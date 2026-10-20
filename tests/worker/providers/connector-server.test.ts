import { createConnection } from "node:net";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SubscriptionConnector } from "../../../lib/domain/subscription-provider";
import { createSubscriptionConnectorClient } from "../../../lib/server/providers/subscription-connector-client";
import { startSubscriptionConnectorServer } from "../../../worker/providers/connector-server";

const roots: string[] = [];

function setup() {
  const root = mkdtempSync(join(tmpdir(), "nail-subscription-socket-"));
  roots.push(root);
  mkdirSync(join(root, "accounts", "codex-owner"), { recursive: true, mode: 0o700 });
  const binding = {
    bindingId: "codex-owner",
    kind: "codex" as const,
    executable: "/usr/local/bin/codex",
    home: join(root, "accounts", "codex-owner"),
    model: "gpt-codex-model",
    enabled: true,
  };
  const config = {
    socketPath: join(root, "provider.sock"),
    bindingsFilePath: join(root, "bindings.json"),
    bindings: [binding],
  };
  return { root, binding, config };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fakeConnector(overrides: Partial<SubscriptionConnector> = {}): SubscriptionConnector {
  return {
    check: async (bindingId) => ({
      kind: "codex",
      state: "unsupported",
      reason: bindingId === "codex-owner" ? "auth_status_unverified" : "wrong_binding",
      model: "gpt-codex-model",
      checkedAt: "2026-10-20T00:00:00.000Z",
    }),
    cancel: async () => undefined,
    complete: async () => ({
      text: "NAIL_OK",
      model: "gpt-codex-model",
      usage: { inputTokens: 7, outputTokens: 2 },
      finishReason: "stop",
    }),
    ...overrides,
  };
}

describe("private subscription connector socket", () => {
  it("sets owner-only socket permissions and never unlinks an existing path", async () => {
    const stale = setup();
    writeFileSync(stale.config.socketPath, "do-not-delete", { mode: 0o600 });
    await expect(startSubscriptionConnectorServer({
      config: stale.config,
      adapters: { codex: fakeConnector() },
    })).rejects.toMatchObject({ code: "invalid_binding" });
    expect(readFileSync(stale.config.socketPath, "utf8")).toBe("do-not-delete");

    const fresh = setup();
    const server = await startSubscriptionConnectorServer({
      config: fresh.config,
      adapters: { codex: fakeConnector() },
    });
    expect(statSync(fresh.config.socketPath).mode & 0o777).toBe(0o600);
    await server.close();
    expect(existsSync(fresh.config.socketPath)).toBe(false);
  });

  it("checks and completes only an administrator-bound provider without leaking extra fields", async () => {
    const { config, binding } = setup();
    const server = await startSubscriptionConnectorServer({
      config,
      adapters: { codex: fakeConnector() },
    });
    try {
      const client = createSubscriptionConnectorClient(config.socketPath);
      await expect(client.check(binding.bindingId, new AbortController().signal)).resolves.toEqual({
        kind: "codex",
        state: "unsupported",
        reason: "auth_status_unverified",
        model: "gpt-codex-model",
        checkedAt: "2026-10-20T00:00:00.000Z",
      });
      await expect(client.complete({
        bindingId: binding.bindingId,
        prompt: "Return NAIL_OK",
        model: binding.model,
        maxOutputTokens: 20,
      }, new AbortController().signal)).resolves.toEqual({
        text: "NAIL_OK",
        model: binding.model,
        usage: { inputTokens: 7, outputTokens: 2 },
        finishReason: "stop",
      });
      await expect(client.check("other-binding", new AbortController().signal))
        .rejects.toMatchObject({ code: "invalid_binding" });
    } finally {
      await server.close();
    }
  });

  it("serializes calls per account and explicit cancel aborts the active invocation", async () => {
    const { config, binding } = setup();
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    const adapter = fakeConnector({
      complete: async (_input, signal) => new Promise((resolve, reject) => {
        startedResolve?.();
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      }),
    });
    const server = await startSubscriptionConnectorServer({ config, adapters: { codex: adapter } });
    const client = createSubscriptionConnectorClient(config.socketPath);
    try {
      const request = client.complete({
        bindingId: binding.bindingId,
        prompt: "Wait",
        model: binding.model,
        maxOutputTokens: 20,
      }, new AbortController().signal);
      const requestRejected = expect(request).rejects.toMatchObject({ code: "cancelled" });
      await started;
      await expect(client.complete({
        bindingId: binding.bindingId,
        prompt: "Concurrent",
        model: binding.model,
        maxOutputTokens: 20,
      }, new AbortController().signal)).rejects.toMatchObject({ code: "busy" });
      await client.cancel(binding.bindingId, new AbortController().signal);
      await requestRejected;
    } finally {
      await server.close();
    }
  });

  it("cancels an active connection check before it can return a stale diagnostic", async () => {
    const { config, binding } = setup();
    let startedResolve: (() => void) | undefined;
    const started = new Promise<void>((resolve) => { startedResolve = resolve; });
    const adapter = fakeConnector({
      check: async (_bindingId, signal) => new Promise((resolve, reject) => {
        startedResolve?.();
        signal.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
      }),
    });
    const server = await startSubscriptionConnectorServer({ config, adapters: { codex: adapter } });
    const client = createSubscriptionConnectorClient(config.socketPath);
    try {
      const check = client.check(binding.bindingId, new AbortController().signal);
      const checkRejected = expect(check).rejects.toMatchObject({ code: "cancelled" });
      await started;
      await client.cancel(binding.bindingId, new AbortController().signal);
      await checkRejected;
    } finally {
      await server.close();
    }
  });

  it("rejects unknown and oversized protocol requests with bounded responses", async () => {
    const { config } = setup();
    const server = await startSubscriptionConnectorServer({ config, adapters: { codex: fakeConnector() } });
    try {
      const oversizedResponse = await new Promise<Record<string, unknown>>((resolve, reject) => {
        const socket = createConnection(config.socketPath);
        let received = "";
        socket.on("connect", () => socket.end(`${"x".repeat(97 * 1024)}\n`));
        socket.on("data", (chunk) => {
          received += chunk.toString("utf8");
          if (received.includes("\n")) resolve(JSON.parse(received.trim()) as Record<string, unknown>);
        });
        socket.on("error", reject);
      });
      expect(oversizedResponse).toMatchObject({ v: 1, ok: false, code: "output_limit" });

      const client = createSubscriptionConnectorClient(config.socketPath);
      await expect(client.complete({
        bindingId: "codex-owner",
        prompt: "x".repeat(65 * 1024),
        model: "gpt-codex-model",
        maxOutputTokens: 1,
      }, new AbortController().signal)).rejects.toMatchObject({ code: "output_limit" });
      await expect(client.complete({
        bindingId: "codex-owner",
        prompt: "ok",
        model: "not-the-configured-model",
        maxOutputTokens: 1,
      }, new AbortController().signal)).rejects.toMatchObject({ code: "invalid_model" });
    } finally {
      await server.close();
    }
  });
});
