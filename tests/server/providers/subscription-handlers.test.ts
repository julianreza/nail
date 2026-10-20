import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SubscriptionConnector } from "../../../lib/domain/subscription-provider";
import { openDatabase, createRepositories } from "../../../lib/server/db/database";
import {
  createProviderConnectionHandler,
  createSubscriptionProviderHandler,
} from "../../../lib/server/providers/subscription-handlers";
import type { ConnectorConfig } from "../../../worker/providers/connector-config";

const origin = "http://localhost:3000";
const directories: string[] = [];
const binding = {
  bindingId: "codex-owner",
  kind: "codex" as const,
  executable: "/opt/nail-provider-bin/codex",
  home: "/var/lib/nail-subscriptions/accounts/codex-owner",
  model: "gpt-codex-model",
  enabled: true,
};

function setup(options: { authenticated?: boolean; connector?: Partial<SubscriptionConnector> } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "nail-subscription-handlers-"));
  directories.push(directory);
  const databasePath = join(directory, "app.sqlite");
  const config: ConnectorConfig = {
    socketPath: join(directory, "provider.sock"),
    bindingsFilePath: join(directory, "bindings.json"),
    bindings: [binding],
  };
  let cancelCalls = 0;
  const defaultConnector: SubscriptionConnector = {
    check: async () => ({
      kind: "codex", state: "not_installed", reason: "cli_not_installed", model: null,
      checkedAt: "2026-10-20T00:00:00.000Z",
    }),
    cancel: async () => { cancelCalls += 1; },
    complete: async () => { throw new Error("Inference should not run in handler tests"); },
  };
  const connector = { ...defaultConnector, ...options.connector };
  const dependencies = {
    auth: {
      protectedResource: async () => options.authenticated === false
        ? Response.json({ error: "Unauthorized" }, { status: 401 })
        : Response.json({ authenticated: true }),
    },
    appOrigin: origin,
    databasePath,
    loadConfig: () => config,
    connector,
    clock: () => "2026-10-20T00:00:00.000Z",
  };
  return {
    databasePath,
    config,
    connector,
    getCancelCalls: () => cancelCalls,
    setupProvider: createSubscriptionProviderHandler(dependencies),
    connection: createProviderConnectionHandler(dependencies),
  };
}

function post(body: unknown, requestOrigin = origin) {
  return new Request(`${origin}/api/providers/subscriptions`, {
    method: "POST",
    headers: { origin: requestOrigin, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

function action(body: unknown, requestOrigin = origin) {
  return new Request(`${origin}/api/providers/provider-1/connection`, {
    method: "POST",
    headers: { origin: requestOrigin, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, { recursive: true, force: true });
});

describe("owner-only subscription handlers", () => {
  it("creates one unavailable binding with safe diagnostic fields when the CLI is absent", async () => {
    const context = setup();
    const response = await context.setupProvider(post({ kind: "codex", bindingId: binding.bindingId, model: binding.model }));
    const payload = await response.json() as Record<string, unknown>;
    const database = openDatabase(context.databasePath);
    try {
      expect(response.status).toBe(201);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(payload).toMatchObject({
        provider: { kind: "codex", authMode: "subscription_cli", status: "unavailable" },
        connection: { state: "not_installed", reason: "cli_not_installed" },
      });
      expect(JSON.stringify(payload)).not.toContain(binding.executable);
      expect(JSON.stringify(payload)).not.toContain(binding.home);
      expect(JSON.stringify(payload)).not.toContain("secretReference");
      expect(createRepositories(database).providers.list()).toHaveLength(1);
      expect(createRepositories(database).accountBindings.getByProviderId((payload.provider as { id: string }).id))
        .toMatchObject({ bindingId: "codex-owner", state: "not_installed" });
    } finally {
      database.close();
    }
  });

  it("rejects a duplicate provider kind instead of creating a second binding", async () => {
    const context = setup();
    const request = () => post({ kind: "codex", bindingId: binding.bindingId, model: binding.model });
    expect((await context.setupProvider(request())).status).toBe(201);
    const duplicate = await context.setupProvider(request());
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ code: "busy" });
    const database = openDatabase(context.databasePath);
    try {
      expect(createRepositories(database).providers.list().filter((provider) => provider.kind === "codex")).toHaveLength(1);
    } finally {
      database.close();
    }
  });

  it("rejects unauthenticated, cross-origin, malformed, and non-admin-configured bindings", async () => {
    const unauthenticated = setup({ authenticated: false });
    expect((await unauthenticated.setupProvider(post({ kind: "codex", bindingId: binding.bindingId, model: binding.model }))).status).toBe(401);

    const wrongOrigin = setup();
    expect((await wrongOrigin.setupProvider(post({ kind: "codex", bindingId: binding.bindingId, model: binding.model }, "https://evil.invalid"))).status).toBe(403);

    const malformed = setup();
    expect((await malformed.setupProvider(post("not-json"))).status).toBe(400);

    const unknownBinding = setup();
    expect((await unknownBinding.setupProvider(post({ kind: "codex", bindingId: "other", model: binding.model }))).status).toBe(400);
  });

  it("re-probes with a revision check and disconnects without vendor logout", async () => {
    const context = setup();
    const created = await context.setupProvider(post({ kind: "codex", bindingId: binding.bindingId, model: binding.model }));
    const provider = (await created.json() as { provider: { id: string } }).provider;
    const checked = await context.connection(provider.id, action({ action: "check" }));
    expect(checked.status).toBe(200);
    expect(await checked.json()).toMatchObject({
      provider: { id: provider.id, status: "unavailable" },
      connection: { state: "not_installed", reason: "cli_not_installed" },
    });

    const disconnected = await context.connection(provider.id, action({ action: "disconnect" }));
    expect(disconnected.status).toBe(200);
    expect(await disconnected.json()).toMatchObject({ disconnected: true, provider: { id: provider.id, status: "not_configured" } });
    expect(context.getCancelCalls()).toBe(1);
    const rebound = await context.setupProvider(post({ kind: "codex", bindingId: binding.bindingId, model: binding.model }));
    expect(rebound.status).toBe(201);
    const reboundProvider = (await rebound.json() as { provider: { id: string } }).provider;
    expect(reboundProvider.id).toBe(provider.id);
    const database = openDatabase(context.databasePath);
    try {
      expect(createRepositories(database).accountBindings.getByProviderId(provider.id)?.revision).toBe(1);
    } finally {
      database.close();
    }
  });

  it("does not restore provider readiness when a check completes after disconnect", async () => {
    let finishCheck: ((value: Awaited<ReturnType<SubscriptionConnector["check"]>>) => void) | undefined;
    let checkCalls = 0;
    const checking = new Promise<Awaited<ReturnType<SubscriptionConnector["check"]>>>((resolve) => { finishCheck = resolve; });
    const context = setup({ connector: { check: async () => {
      checkCalls += 1;
      return checkCalls === 1 ? {
        kind: "codex", state: "not_installed", reason: "cli_not_installed", model: null,
        checkedAt: "2026-10-20T00:00:00.000Z",
      } : checking;
    } } });
    const created = await context.setupProvider(post({ kind: "codex", bindingId: binding.bindingId, model: binding.model }));
    const provider = (await created.json() as { provider: { id: string } }).provider;
    const lateCheck = context.connection(provider.id, action({ action: "check" }));
    await Promise.resolve();
    const disconnected = await context.connection(provider.id, action({ action: "disconnect" }));
    expect(disconnected.status).toBe(200);
    finishCheck?.({
      kind: "codex", state: "ready", reason: null, model: binding.model,
      checkedAt: "2026-10-20T00:00:01.000Z",
    });
    expect((await lateCheck).status).toBe(409);
    const database = openDatabase(context.databasePath);
    try {
      expect(createRepositories(database).providers.getById(provider.id)?.status).toBe("not_configured");
      expect(createRepositories(database).accountBindings.getByProviderId(provider.id)).toBeNull();
    } finally {
      database.close();
    }
  });
});
