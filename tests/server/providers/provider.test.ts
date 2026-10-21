import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, createRepositories } from "../../../lib/server/db/database";
import { EncryptedSecretStore } from "../../../lib/server/providers/secret-store";
import {
  completeProviderUsage,
  configureRunUsageBudget,
  reserveProviderRequest,
} from "../../../lib/server/providers/usage-budget";
import {
  DeepSeekAdapter,
  ProviderAuthenticationError,
  ProviderRateLimitError,
  ProviderUnavailableError,
} from "../../../lib/server/providers/deepseek-adapter";

const temporaryDirectories: string[] = [];

function createTempDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "nail-provider-test-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function createDatabase(path: string) {
  const database = (await openDatabase(path));
  (await createRepositories(database).projects.create({ id: "project-1", name: "Nail" }));
  (await createRepositories(database).runs.create({
    id: "run-1",
    projectId: "project-1",
    state: "running",
    baselineCommit: "base-1",
  }));
  return database;
}

function completeResponse(overrides: Record<string, unknown> = {}) {
  return Response.json({
    id: "completion-1",
    model: "deepseek-chat",
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: "done", tool_calls: [] },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
    ...overrides,
  });
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("provider key handling and bounded API calls", () => {
  it("encrypts API keys at rest and rejects ciphertext tampering", () => {
    const directory = createTempDirectory();
    const store = new EncryptedSecretStore(directory, Buffer.alloc(32, 9));
    const secret = "sk-test-provider-secret";
    const reference = store.put(secret);
    const file = join(directory, readdirSync(directory)[0]!);
    const ciphertext = readFileSync(file, "utf8");

    expect(reference).not.toContain(secret);
    expect(ciphertext).not.toContain(secret);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(store.get(reference)).toBe(secret);

    const record = JSON.parse(ciphertext) as { tag: string };
    record.tag = `${record.tag[0] === "A" ? "B" : "A"}${record.tag.slice(1)}`;
    writeFileSync(file, JSON.stringify(record), { mode: 0o600 });
    expect(() => store.get(reference)).toThrow();
  });

  it("reserves request/output budgets before calls and blocks over-limit tool calls", async () => {
    const directory = createTempDirectory();
    const database = (await createDatabase(join(directory, "orchestrator-database")));
    (await createRepositories(database).providers.create({
      id: "provider-1",
      name: "DeepSeek",
      kind: "deepseek",
      status: "ready",
      model: "deepseek-chat",
      authMode: "api_key",
    }));
    try {
      (await configureRunUsageBudget(database, {
        runId: "run-1",
        maxRequests: 2,
        maxToolCalls: 1,
        maxOutputTokens: 10,
      }));
      const first = (await reserveProviderRequest(database, {
        runId: "run-1",
        providerId: "provider-1",
        maxOutputTokens: 7,
      }));
      expect((await createRepositories(database).usageRecords.getById(first.id))?.usageState).toBe("reserved");
      await expect(async () =>
        (await reserveProviderRequest(database, {
          runId: "run-1",
          providerId: "provider-1",
          maxOutputTokens: 4,
        })),
      ).rejects.toThrow();
      expect(
        (await completeProviderUsage(database, first.id, {
          inputTokens: 4,
          outputTokens: 3,
          toolCalls: 1,
        })).toolCallsAllowed,
      ).toBe(true);
      expect((await createRepositories(database).usageRecords.getById(first.id))?.usageState).toBe("known");

      const second = (await reserveProviderRequest(database, {
        runId: "run-1",
        providerId: "provider-1",
        maxOutputTokens: 7,
      }));
      expect(
        (await completeProviderUsage(database, second.id, {
          inputTokens: 4,
          outputTokens: 3,
          toolCalls: 1,
        })).toolCallsAllowed,
      ).toBe(false);
      expect((await createRepositories(database).usageRecords.getById(second.id))?.usageState).toBe("known");
      await expect(async () =>
        (await completeProviderUsage(database, second.id, {
          inputTokens: 0,
          outputTokens: 0,
          toolCalls: 0,
        })),
      ).rejects.toThrow(/already settled/);
      await expect(async () =>
        (await reserveProviderRequest(database, {
          runId: "run-1",
          providerId: "provider-1",
          maxOutputTokens: 1,
        })),
      ).rejects.toThrow();
    } finally {
      (await database.close());
    }
  });

  it("sends the key only in the HTTPS authorization header and returns typed completion", async () => {
    const directory = createTempDirectory();
    const database = (await createDatabase(join(directory, "orchestrator-database")));
    const store = new EncryptedSecretStore(join(directory, "secrets"), Buffer.alloc(32, 8));
    const apiKey = "sk-provider-key-never-return-this";
    const secretReference = store.put(apiKey);
    (await createRepositories(database).providers.create({
      id: "provider-1",
      name: "DeepSeek",
      kind: "deepseek",
      status: "ready",
      model: "deepseek-chat",
      authMode: "api_key",
      secretReference,
      capabilities: ["tools", "streaming"],
    }));
    (await configureRunUsageBudget(database, {
      runId: "run-1",
      maxRequests: 2,
      maxToolCalls: 2,
      maxOutputTokens: 20,
    }));
    let capturedUrl = "";
    let capturedAuthorization = "";
    let capturedBody: Record<string, unknown> = {};
    const adapter = new DeepSeekAdapter({
      database,
      secretStore: store,
      fetcher: async (input, init) => {
        capturedUrl = String(input);
        capturedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return completeResponse();
      },
    });
    try {
      const result = await adapter.complete({
        runId: "run-1",
        providerId: "provider-1",
        maxOutputTokens: 12,
        messages: [{ role: "user", content: "hello" }],
      });

      expect(capturedUrl).toBe("https://api.deepseek.com/chat/completions");
      expect(capturedAuthorization).toBe(`Bearer ${apiKey}`);
      expect(capturedBody.max_tokens).toBe(12);
      expect(JSON.stringify(result)).not.toContain(apiKey);
      expect(result).toMatchObject({
        kind: "complete",
        content: "done",
        usage: { inputTokens: 5, outputTokens: 3 },
      });
    } finally {
      (await database.close());
    }
  });

  it("streams text responses and finalizes usage when the provider supplies token totals", async () => {
    const directory = createTempDirectory();
    const database = (await createDatabase(join(directory, "orchestrator-database")));
    const store = new EncryptedSecretStore(join(directory, "secrets"), Buffer.alloc(32, 12));
    const secretReference = store.put("provider-stream-secret-test");
    (await createRepositories(database).providers.create({
      id: "provider-1",
      name: "DeepSeek",
      kind: "deepseek",
      status: "ready",
      model: "deepseek-chat",
      authMode: "api_key",
      secretReference,
      capabilities: ["streaming"],
    }));
    (await configureRunUsageBudget(database, {
      runId: "run-1",
      maxRequests: 2,
      maxToolCalls: 0,
      maxOutputTokens: 20,
    }));
    const chunks = [
      'data: {"choices":[{"delta":{"content":"hello provider-stream-',
      'secret-test"}}]}\n\n',
      'data: {"choices":[],"usage":{"prompt_tokens":5,"completion_tokens":3}}\n\n',
      "data: [DONE]\n\n",
    ];
    const adapter = new DeepSeekAdapter({
      database,
      secretStore: store,
      fetcher: async () =>
        new Response(
          new ReadableStream<Uint8Array>({
            pull(controller) {
              const chunk = chunks.shift();
              if (chunk) controller.enqueue(new TextEncoder().encode(chunk));
              else controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        ),
    });
    try {
      const result = await adapter.complete({
        runId: "run-1",
        providerId: "provider-1",
        maxOutputTokens: 10,
        messages: [{ role: "user", content: "hello" }],
        stream: true,
      });
      expect(result.kind).toBe("stream");
      if (result.kind !== "stream") throw new Error("Expected a stream result");
      const content = await new Response(result.stream).text();
      expect(content).toContain('"content":"hello [REDACTED]"');
      expect(content).not.toContain("provider-stream-secret-test");
      const usage = (await createRepositories(database).usageRecords.getById(result.reservationId));
      expect(usage).toMatchObject({ inputTokens: 5, outputTokens: 3, usageState: "known" });
    } finally {
      (await database.close());
    }
  });

  it("rejects unsupported tools before requesting and never falls back on provider errors", async () => {
    const directory = createTempDirectory();
    const database = (await createDatabase(join(directory, "orchestrator-database")));
    const store = new EncryptedSecretStore(join(directory, "secrets"), Buffer.alloc(32, 5));
    const secretReference = store.put("sk-secret");
    (await createRepositories(database).providers.create({
      id: "provider-1",
      name: "DeepSeek",
      kind: "deepseek",
      status: "ready",
      model: "deepseek-chat",
      authMode: "api_key",
      secretReference,
      capabilities: [],
    }));
    (await configureRunUsageBudget(database, {
      runId: "run-1",
      maxRequests: 4,
      maxToolCalls: 1,
      maxOutputTokens: 50,
    }));
    let fetchCount = 0;
    const adapter = new DeepSeekAdapter({
      database,
      secretStore: store,
      fetcher: async () => {
        fetchCount += 1;
        return new Response("secret should not be copied", { status: 401 });
      },
    });
    try {
      await expect(
        adapter.complete({
          runId: "run-1",
          providerId: "provider-1",
          maxOutputTokens: 10,
          messages: [{ role: "user", content: "hello" }],
          tools: [{ type: "function", function: { name: "inspect", parameters: {} } }],
        }),
      ).rejects.toThrow(/tool/i);
      expect(fetchCount).toBe(0);

      (await createRepositories(database).providers.create({
        id: "provider-2",
        name: "DeepSeek",
        kind: "deepseek",
        status: "ready",
        model: "deepseek-chat",
        authMode: "api_key",
        secretReference,
        capabilities: ["tools"],
      }));
      await expect(
        adapter.complete({
          runId: "run-1",
          providerId: "provider-2",
          maxOutputTokens: 10,
          messages: [{ role: "user", content: "hello" }],
        }),
      ).rejects.toBeInstanceOf(ProviderAuthenticationError);
      expect(fetchCount).toBe(1);
      expect((await createRepositories(database).providers.getById("provider-2"))?.status).toBe(
        "needs_login",
      );
    } finally {
      (await database.close());
    }
  });

  it("maps 429 and 5xx to explicit health states without retrying or switching billing", async () => {
    for (const [status, ErrorType, connectionStatus] of [
      [429, ProviderRateLimitError, "rate_limited"],
      [503, ProviderUnavailableError, "unavailable"],
    ] as const) {
      const directory = createTempDirectory();
      const database = (await createDatabase(join(directory, "orchestrator-database")));
      const store = new EncryptedSecretStore(join(directory, "secrets"), Buffer.alloc(32, status % 255));
      const secretReference = store.put("sk-billing-test");
      (await createRepositories(database).providers.create({
        id: "provider-1",
        name: "DeepSeek",
        kind: "deepseek",
        status: "ready",
        model: "deepseek-chat",
        authMode: "api_key",
        secretReference,
        capabilities: ["tools"],
      }));
      (await configureRunUsageBudget(database, {
        runId: "run-1",
        maxRequests: 2,
        maxToolCalls: 1,
        maxOutputTokens: 20,
      }));
      let fetchCount = 0;
      const adapter = new DeepSeekAdapter({
        database,
        secretStore: store,
        fetcher: async () => {
          fetchCount += 1;
          return new Response("provider error with no secret echo", { status });
        },
      });
      try {
        await expect(
          adapter.complete({
            runId: "run-1",
            providerId: "provider-1",
            maxOutputTokens: 5,
            messages: [{ role: "user", content: "hello" }],
          }),
        ).rejects.toBeInstanceOf(ErrorType);
        expect(fetchCount).toBe(1);
        expect((await createRepositories(database).providers.getById("provider-1"))?.status).toBe(
          connectionStatus,
        );
      } finally {
        (await database.close());
      }
    }
  });
});
