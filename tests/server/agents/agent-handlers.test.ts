import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createAuthHandlers, hashOwnerPassword } from "../../../lib/server/auth/auth-service";
import { createRepositories, openDatabase } from "../../../lib/server/db/database";
import { createAgentHandlers } from "../../../lib/server/agents/agent-handlers";

const origin = "https://nail.example";
const input = {
  name: "PM",
  role: "pm",
  projectId: null,
  providerId: null,
  model: null,
  skillIds: ["planning"],
  instructions: "Make a small plan.",
};

async function createContext(options: { authenticated?: boolean; databaseUrl?: string } = {}) {
  const databaseUrl = options.databaseUrl ?? `agent-handler-${randomUUID()}`;
  const auth = options.authenticated === false
    ? { protectedResource: async () => Response.json({ error: "Unauthorized" }, { status: 401 }) }
    : createAuthHandlers({
      ownerPasswordHash: await hashOwnerPassword("correct horse battery", { salt: Buffer.alloc(16, 3) }),
      sessionSecret: Buffer.alloc(32, 4).toString("base64url"),
      appOrigin: origin,
      secureCookies: true,
    });
  let cookie = "";
  if (options.authenticated !== false && "login" in auth) {
    const login = await auth.login(new Request(`${origin}/api/auth/login`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ password: "correct horse battery" }),
    }));
    cookie = login.headers.get("set-cookie")?.split(";")[0] ?? "";
  }
  return {
    databaseUrl,
    handlers: createAgentHandlers({ auth, appOrigin: origin, databaseUrl }),
    request(path: string, method = "GET", body?: BodyInit | null, requestOrigin: string | null = origin, contentType = "application/json") {
      const headers = new Headers({ "content-type": contentType });
      if (cookie) headers.set("cookie", cookie);
      if (requestOrigin !== null) headers.set("origin", requestOrigin);
      const init: RequestInit & { duplex?: "half" } = {
        method,
        headers,
        ...(body === undefined ? {} : { body }),
      };
      if (body instanceof ReadableStream) init.duplex = "half";
      return new Request(`${origin}${path}`, init);
    },
  };
}

describe("owner-only agent handlers", () => {
  it("creates, reads, updates, lists and deletes with exact PostgreSQL readback", async () => {
    const context = await createContext();
    const createdResponse = await context.handlers.create(context.request("/api/agents", "POST", JSON.stringify(input)));
    const created = await createdResponse.json() as { agent: { id: string; revision: number } };
    expect(createdResponse.status).toBe(201);
    expect(createdResponse.headers.get("cache-control")).toBe("no-store");

    const read = await context.handlers.get(created.agent.id, context.request(`/api/agents/${created.agent.id}`));
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ agent: { ...input, id: created.agent.id, revision: 1 } });
    expect(await (await context.handlers.list(context.request("/api/agents"))).json()).toMatchObject([
      { ...input, id: created.agent.id, revision: 1 },
    ]);

    const updatedInput = { ...input, name: "PM diperbarui", skillIds: ["planning", "review"] };
    const update = await context.handlers.update(created.agent.id, context.request(
      `/api/agents/${created.agent.id}`, "PUT", JSON.stringify({ revision: 1, agent: updatedInput }),
    ));
    expect(update.status).toBe(200);
    expect(await update.json()).toMatchObject({ agent: { ...updatedInput, id: created.agent.id, revision: 2 } });

    const options = await context.handlers.options(context.request("/api/agents/options"));
    expect(options.status).toBe(200);
    expect((await options.json() as { skills: Array<{ id: string }> }).skills.map(({ id }) => id))
      .toEqual(["planning", "implementation", "testing", "review"]);

    const database = await openDatabase(context.databaseUrl);
    try {
      expect(await createRepositories(database).agents.getById(created.agent.id)).toMatchObject({
        id: created.agent.id, name: "PM diperbarui", revision: 2, skillIds: ["planning", "review"],
      });
    } finally { await database.close(); }

    const deleted = await context.handlers.delete(created.agent.id, context.request(
      `/api/agents/${created.agent.id}`, "DELETE", JSON.stringify({ revision: 2 }),
    ));
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ deleted: true, id: created.agent.id });
    expect((await context.handlers.list(context.request("/api/agents"))).status).toBe(200);
    expect(await (await context.handlers.list(context.request("/api/agents"))).json()).toEqual([]);
    expect((await context.handlers.get(created.agent.id, context.request(`/api/agents/${created.agent.id}`))).status).toBe(404);
  });

  it("authorizes before database setup and enforces same-origin JSON mutations", async () => {
    const denied = await createContext({ authenticated: false, databaseUrl: "" });
    const unauthorized = await denied.handlers.create(denied.request("/api/agents", "POST", JSON.stringify(input)));
    expect(unauthorized.status).toBe(401);

    const context = await createContext();
    expect((await context.handlers.create(context.request("/api/agents", "POST", JSON.stringify(input), "https://evil.example"))).status).toBe(403);
    expect((await context.handlers.create(context.request("/api/agents", "POST", JSON.stringify(input), null))).status).toBe(403);
    expect((await context.handlers.create(context.request("/api/agents", "POST", JSON.stringify(input), origin, "text/plain"))).status).toBe(415);
  });

  it("rejects malformed, oversized, invalid-UTF8 and extended-field requests", async () => {
    const context = await createContext();
    const malformed = await context.handlers.create(context.request("/api/agents", "POST", "{bad"));
    expect(malformed.status).toBe(400);
    const extended = await context.handlers.create(context.request("/api/agents", "POST", JSON.stringify({ ...input, ready: true })));
    expect(extended.status).toBe(400);
    const invalidUtf8 = await context.handlers.create(context.request("/api/agents", "POST", new Uint8Array([0xff])));
    expect(invalidUtf8.status).toBe(400);
    const oversizedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(65 * 1024));
        controller.close();
      },
    });
    const oversized = await context.handlers.create(context.request("/api/agents", "POST", oversizedBody));
    expect(oversized.status).toBe(413);
    for (const response of [malformed, extended, invalidUtf8, oversized]) {
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("maps stale revisions and missing database configuration safely", async () => {
    const context = await createContext();
    const created = await context.handlers.create(context.request("/api/agents", "POST", JSON.stringify(input)));
    const { agent } = await created.json() as { agent: { id: string } };
    const stale = await context.handlers.update(agent.id, context.request(
      `/api/agents/${agent.id}`, "PUT", JSON.stringify({ revision: 4, agent: input }),
    ));
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ code: "revision_conflict" });

    const noDatabase = await createContext({ databaseUrl: "" });
    const unavailable = await noDatabase.handlers.options(noDatabase.request("/api/agents/options"));
    expect(unavailable.status).toBe(503);
    expect(unavailable.headers.get("cache-control")).toBe("no-store");
  });

  it("does not expose internal database failure text", async () => {
    const context = await createContext({ databaseUrl: "postgresql://owner:private@127.0.0.1:1/nail" });
    const response = await context.handlers.options(context.request("/api/agents/options"));
    expect(response.status).toBe(500);
    const payload = await response.text();
    expect(payload).toContain("Unable to load agent data");
    expect(payload).not.toContain("private");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });
});
