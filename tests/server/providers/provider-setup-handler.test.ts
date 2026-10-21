import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openDatabase, createRepositories } from "../../../lib/server/db/database";
import { EncryptedSecretStore } from "../../../lib/server/providers/secret-store";
import { createProviderSetupHandler } from "../../../lib/server/providers/provider-setup-handler";

const directories: string[] = [];
const origin = "http://localhost:3000";
const apiKey = "ds-handler-key-123456";

function createContext(options: { authenticated?: boolean; databaseUrl?: string } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "nail-provider-handler-"));
  directories.push(directory);
  const databaseUrl = options.databaseUrl ?? join(directory, "app-database");
  const handler = createProviderSetupHandler({
    auth: {
      protectedResource: async () => options.authenticated === false
        ? Response.json({ error: "Unauthorized" }, { status: 401 })
        : Response.json({ authenticated: true }),
    },
    appOrigin: origin,
    databaseUrl,
    createSecretStore: () => new EncryptedSecretStore(join(directory, "secrets"), Buffer.alloc(32, 5)),
    fetcher: async () => Response.json({ data: [{ id: "deepseek-chat" }] }),
  });
  return { directory, databaseUrl, handler };
}

function post(body: unknown, requestOrigin = origin, contentType = "application/json") {
  return new Request(`${origin}/api/providers`, {
    method: "POST",
    headers: { origin: requestOrigin, "content-type": contentType },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("provider setup handler", () => {
  it("requires an authenticated same-origin JSON request before provider setup", async () => {
    const unauthenticated = createContext({ authenticated: false });
    const denied = await unauthenticated.handler(post({ apiKey, model: "deepseek-chat" }));
    expect(denied.status).toBe(401);

    const wrongOrigin = createContext();
    const forbidden = await wrongOrigin.handler(post({ apiKey, model: "deepseek-chat" }, "https://evil.example"));
    expect(forbidden.status).toBe(403);

    const wrongType = createContext();
    const unsupported = await wrongType.handler(post({ apiKey, model: "deepseek-chat" }, origin, "text/plain"));
    expect(unsupported.status).toBe(415);
  });

  it("persists a valid provider but does not return the API key or secret reference", async () => {
    const { handler, databaseUrl } = createContext();
    const response = await handler(post({ apiKey, model: "deepseek-chat" }));
    const payload = await response.json() as Record<string, unknown>;
    const database = (await openDatabase(databaseUrl));
    try {
      expect(response.status).toBe(201);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(payload).toMatchObject({ name: "DeepSeek", model: "deepseek-chat", status: "ready" });
      expect(JSON.stringify(payload)).not.toContain(apiKey);
      expect(payload).not.toHaveProperty("secretReference");
      expect((await createRepositories(database).providers.list())).toHaveLength(1);
    } finally {
      (await database.close());
    }
  });

  it("rejects malformed JSON without creating the database", async () => {
    const { handler, databaseUrl } = createContext();
    const response = await handler(post("{not-json"));
    expect(response.status).toBe(400);
    expect(existsSync(databaseUrl)).toBe(false);
  });

  it("returns configuration errors without exposing internals", async () => {
    const directory = mkdtempSync(join(tmpdir(), "nail-provider-handler-"));
    directories.push(directory);
    const handler = createProviderSetupHandler({
      auth: { protectedResource: async () => Response.json({ authenticated: true }) },
      appOrigin: origin,
      databaseUrl: undefined,
      createSecretStore: () => { throw new Error(`bad key ${apiKey}`); },
      fetcher: async () => Response.json({ data: [{ id: "deepseek-chat" }] }),
    });
    const response = await handler(post({ apiKey, model: "deepseek-chat" }));
    const payload = await response.json() as Record<string, unknown>;
    expect(response.status).toBe(503);
    expect(JSON.stringify(payload)).not.toContain(apiKey);
  });
});
