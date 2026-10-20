import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createRepositories, openDatabase } from "../../../lib/server/db/database";
import { EncryptedSecretStore } from "../../../lib/server/providers/secret-store";
import {
  createDeepSeekProviderSetup,
  ProviderSetupError,
} from "../../../lib/server/providers/provider-setup";

const directories: string[] = [];

function setup() {
  const directory = mkdtempSync(join(tmpdir(), "nail-provider-setup-"));
  directories.push(directory);
  const database = openDatabase(join(directory, "app.sqlite"));
  const store = new EncryptedSecretStore(join(directory, "secrets"), Buffer.alloc(32, 7));
  return { directory, database, store };
}

function modelsResponse(ids = ["deepseek-chat", "deepseek-reasoner"]) {
  return Response.json({ data: ids.map((id) => ({ id, object: "model" })) });
}

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("DeepSeek provider setup", () => {
  it("validates a key and advertised model before saving only an encrypted secret reference", async () => {
    const { directory, database, store } = setup();
    let requestedUrl = "";
    let authorization = "";
    const apiKey = "ds-test-provider-key-123";
    try {
      const result = await createDeepSeekProviderSetup(
        database,
        store,
        { apiKey, model: "deepseek-chat" },
        async (url, init) => {
          requestedUrl = String(url);
          authorization = new Headers(init?.headers).get("authorization") ?? "";
          return modelsResponse();
        },
      );
      const persisted = createRepositories(database).providers.getById(result.id);
      expect(requestedUrl).toBe("https://api.deepseek.com/models");
      expect(authorization).toBe(`Bearer ${apiKey}`);
      expect(result).toMatchObject({ name: "DeepSeek", model: "deepseek-chat", status: "ready" });
      expect(JSON.stringify(result)).not.toContain(apiKey);
      expect(persisted?.authMode).toBe("api_key");
      expect(persisted?.secretReference).toMatch(/^secret:/);
      expect(store.get(persisted!.secretReference!)).toBe(apiKey);
      expect(readdirSync(join(directory, "secrets"))).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("rejects a model not advertised by DeepSeek without saving a secret", async () => {
    const { database, store } = setup();
    try {
      await expect(createDeepSeekProviderSetup(
        database, store, { apiKey: "valid-key", model: "unknown-model" },
        async () => modelsResponse(),
      )).rejects.toMatchObject({ code: "model_not_available" });
      expect(createRepositories(database).providers.list()).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it("rejects invalid credentials without persisting the key", async () => {
    const { directory, database, store } = setup();
    try {
      await expect(createDeepSeekProviderSetup(
        database, store, { apiKey: "invalid-key", model: "deepseek-chat" },
        async () => new Response("denied", { status: 401 }),
      )).rejects.toMatchObject({ code: "invalid_credentials" });
      expect(createRepositories(database).providers.list()).toHaveLength(0);
      expect(existsSync(join(directory, "secrets")) ? readdirSync(join(directory, "secrets")) : []).toHaveLength(0);
    } finally {
      database.close();
    }
  });

  it("rejects a second DeepSeek provider before making another request", async () => {
    const { database, store } = setup();
    createRepositories(database).providers.create({
      id: "existing", name: "DeepSeek", status: "ready", authMode: "api_key",
    });
    let fetchCount = 0;
    try {
      await expect(createDeepSeekProviderSetup(
        database, store, { apiKey: "valid-key", model: "deepseek-chat" },
        async () => { fetchCount += 1; return modelsResponse(); },
      )).rejects.toBeInstanceOf(ProviderSetupError);
      expect(fetchCount).toBe(0);
    } finally {
      database.close();
    }
  });

  it("deletes a newly encrypted key if provider persistence fails", async () => {
    const { directory, database, store } = setup();
    const originalPut = store.put.bind(store);
    store.put = (secret: string) => {
      const reference = originalPut(secret);
      database.close();
      return reference;
    };
    await expect(createDeepSeekProviderSetup(
      database, store, { apiKey: "valid-key", model: "deepseek-chat" },
      async () => modelsResponse(),
    )).rejects.toThrow();
    expect(existsSync(join(directory, "secrets")) ? readdirSync(join(directory, "secrets")) : []).toHaveLength(0);
  });

  it("rejects malformed or oversized model-list responses without persisting a key", async () => {
    for (const response of [
      Response.json({ unexpected: [] }),
      new Response("x".repeat(300_000), { headers: { "content-type": "application/json" } }),
      new Response(null, { status: 503 }),
    ]) {
      const { directory, database, store } = setup();
      try {
        await expect(createDeepSeekProviderSetup(
          database, store, { apiKey: "valid-key", model: "deepseek-chat" },
          async () => response,
        )).rejects.toMatchObject({ code: "provider_unavailable" });
        expect(createRepositories(database).providers.list()).toHaveLength(0);
        expect(existsSync(join(directory, "secrets")) ? readdirSync(join(directory, "secrets")) : []).toHaveLength(0);
      } finally {
        database.close();
      }
    }
  });

  it("maps network failures to a safe provider-unavailable error", async () => {
    const { database, store } = setup();
    try {
      await expect(createDeepSeekProviderSetup(
        database, store, { apiKey: "valid-key", model: "deepseek-chat" },
        async () => { throw new Error("network failed with valid-key"); },
      )).rejects.toMatchObject({ code: "provider_unavailable", message: expect.not.stringContaining("valid-key") });
    } finally {
      database.close();
    }
  });

  it("serializes concurrent setup attempts so only one provider is created", async () => {
    const { database, store } = setup();
    const finishRequests: Array<() => void> = [];
    const fetcher: typeof fetch = async () => new Promise<Response>((resolve) => {
      finishRequests.push(() => resolve(modelsResponse()));
      if (finishRequests.length === 2) finishRequests.forEach((finish) => finish());
    });
    try {
      const results = await Promise.allSettled([
        createDeepSeekProviderSetup(database, store, { apiKey: "key-one", model: "deepseek-chat" }, fetcher),
        createDeepSeekProviderSetup(database, store, { apiKey: "key-two", model: "deepseek-chat" }, fetcher),
      ]);
      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(createRepositories(database).providers.list()).toHaveLength(1);
    } finally {
      database.close();
    }
  });
});
