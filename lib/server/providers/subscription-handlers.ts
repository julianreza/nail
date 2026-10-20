import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ConnectionDiagnostic, SubscriptionProviderKind, SubscriptionConnector } from "../../domain/subscription-provider";
import { isSameOriginRequest } from "../auth/auth-service";
import { openDatabase, withTransaction } from "../db/database";
import { createRepositories, type ProviderRecord } from "../db/repositories";
import { SubscriptionProviderError } from "./subscription-errors";
import type { ConnectorConfig, ConnectorBindingConfig } from "../../../worker/providers/connector-config";

const MAX_BODY_BYTES = 16 * 1024;
const BINDING_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const KIND_NAME: Record<SubscriptionProviderKind, string> = {
  antigravity: "Antigravity Subscription",
  codex: "Codex Subscription",
  claude: "Claude Subscription",
};

interface AuthGuard {
  protectedResource(request: Request): Promise<Response>;
}

interface SubscriptionHandlerDependencies {
  auth: AuthGuard;
  appOrigin: string | undefined;
  databasePath: string | undefined;
  loadConfig(): ConnectorConfig;
  connector: SubscriptionConnector;
  clock?: () => string;
}

function json(value: unknown, status: number): Response {
  return Response.json(value, { status, headers: { "cache-control": "no-store" } });
}

function safeProvider(provider: ProviderRecord) {
  return {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    status: provider.status,
    model: provider.model,
    authMode: provider.authMode,
    capabilities: provider.capabilities,
    createdAt: provider.createdAt,
  };
}

function providerStatus(state: ConnectionDiagnostic["state"]): ProviderRecord["status"] {
  switch (state) {
    case "ready": return "ready";
    case "needs_login": return "needs_login";
    case "rate_limited": return "rate_limited";
    case "not_installed":
    case "connected":
    case "unavailable":
    case "unsupported":
      return "unavailable";
  }
}

function normalizeDiagnostic(
  diagnostic: ConnectionDiagnostic,
  binding: ConnectorBindingConfig,
): ConnectionDiagnostic {
  if (
    diagnostic.kind !== binding.kind ||
    !["not_installed", "needs_login", "connected", "ready", "rate_limited", "unavailable", "unsupported"].includes(diagnostic.state) ||
    (diagnostic.reason !== null && !/^[a-z0-9_]{1,64}$/.test(diagnostic.reason)) ||
    (diagnostic.model !== null && diagnostic.model !== binding.model) ||
    typeof diagnostic.checkedAt !== "string" || Number.isNaN(Date.parse(diagnostic.checkedAt))
  ) throw new SubscriptionProviderError("invalid_output");
  return {
    kind: binding.kind,
    state: diagnostic.state,
    reason: diagnostic.reason,
    model: diagnostic.model,
    checkedAt: diagnostic.checkedAt,
  };
}

function diagnosticFromError(
  binding: ConnectorBindingConfig,
  error: unknown,
  now: string,
): ConnectionDiagnostic {
  const code = error instanceof SubscriptionProviderError ? error.code : "unavailable";
  const state: ConnectionDiagnostic["state"] = code === "not_installed"
    ? "not_installed"
    : code === "needs_login" || code === "wrong_auth_mode"
      ? "needs_login"
      : code === "rate_limited"
        ? "rate_limited"
        : code === "unsupported_version" || code === "policy_unverified" || code === "tool_isolation_unverified" || code === "budget_unenforceable"
          ? "unsupported"
          : "unavailable";
  return { kind: binding.kind, state, reason: code, model: binding.model, checkedAt: now };
}

async function authorizedRequest(
  dependencies: SubscriptionHandlerDependencies,
  request: Request,
): Promise<Response | null> {
  const authorization = await dependencies.auth.protectedResource(request);
  if (!authorization.ok) return authorization;
  if (!dependencies.appOrigin || !isSameOriginRequest(request, dependencies.appOrigin)) {
    return json({ error: "Invalid origin" }, 403);
  }
  if (request.headers.get("content-type")?.split(";")[0] !== "application/json") {
    return json({ error: "Unsupported content type" }, 415);
  }
  if (!dependencies.databasePath) return json({ error: "Provider service is not configured" }, 503);
  return null;
}

async function readBody(request: Request): Promise<string | null> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

async function parseRequest(request: Request, fields: readonly string[]): Promise<Record<string, unknown> | Response> {
  const raw = await readBody(request);
  if (raw === null) return json({ error: "Request body is invalid or too large" }, 413);
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return json({ error: "Invalid request" }, 400);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return json({ error: "Invalid request" }, 400);
  const keys = Object.keys(value).sort();
  const expected = [...fields].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    return json({ error: "Invalid request" }, 400);
  }
  return value as Record<string, unknown>;
}

function findConfiguredBinding(config: ConnectorConfig, bindingId: string): ConnectorBindingConfig | undefined {
  return config.bindings.find((binding) => binding.bindingId === bindingId);
}

function loadConfiguration(dependencies: SubscriptionHandlerDependencies): ConnectorConfig {
  try {
    return dependencies.loadConfig();
  } catch {
    throw new SubscriptionProviderError("unavailable");
  }
}

export function createSubscriptionProviderHandler(dependencies: SubscriptionHandlerDependencies) {
  return async function POST(request: Request): Promise<Response> {
    const denied = await authorizedRequest(dependencies, request);
    if (denied) return denied;
    const body = await parseRequest(request, ["kind", "bindingId", "model"]);
    if (body instanceof Response) return body;
    if (
      typeof body.kind !== "string" || !Object.hasOwn(KIND_NAME, body.kind) ||
      typeof body.bindingId !== "string" || !BINDING_ID.test(body.bindingId) ||
      typeof body.model !== "string" || !MODEL_ID.test(body.model)
    ) return json({ error: "Provider details are invalid" }, 400);

    let config: ConnectorConfig;
    try {
      config = loadConfiguration(dependencies);
    } catch {
      return json({ error: "Provider connector is not configured" }, 503);
    }
    const binding = findConfiguredBinding(config, body.bindingId);
    if (!binding || !binding.enabled || binding.kind !== body.kind || binding.model !== body.model) {
      return json({ error: "Provider binding does not match administrator configuration" }, 400);
    }

    let database: DatabaseSync | undefined;
    try {
      database = openDatabase(dependencies.databasePath!);
      const repositories = createRepositories(database);
      const created = withTransaction(database, () => {
        let provider = repositories.providers.list().find((candidate) =>
          candidate.kind === binding.kind && candidate.authMode === "subscription_cli"
        ) ?? null;
        let accountBinding: ReturnType<typeof repositories.accountBindings.getByProviderId>;
        if (provider) {
          accountBinding = repositories.accountBindings.getByProviderId(provider.id);
          if (accountBinding || provider.status !== "not_configured" || provider.secretReference !== null) {
            throw new SubscriptionProviderError("busy");
          }
          if (!repositories.providers.updateSubscriptionConfiguration(provider.id, binding.model)) {
            throw new SubscriptionProviderError("wrong_auth_mode");
          }
          provider = repositories.providers.getById(provider.id)!;
        } else {
          provider = repositories.providers.create({
            id: randomUUID(),
            name: KIND_NAME[binding.kind],
            kind: binding.kind,
            status: "unavailable",
            model: binding.model,
            authMode: "subscription_cli",
            capabilities: [],
          });
        }
        accountBinding = repositories.accountBindings.create({
          providerId: provider.id,
          bindingId: binding.bindingId,
          state: "not_installed",
        });
        return { provider, accountBinding };
      });

      let diagnostic: ConnectionDiagnostic;
      try {
        diagnostic = normalizeDiagnostic(
          await dependencies.connector.check(binding.bindingId, AbortSignal.timeout(10_000)),
          binding,
        );
      } catch (error) {
        diagnostic = diagnosticFromError(binding, error, (dependencies.clock ?? (() => new Date().toISOString()))());
      }
      withTransaction(database, () => {
        const updated = repositories.accountBindings.updateDiagnostic({
          providerId: created.provider.id,
          bindingId: binding.bindingId,
          expectedRevision: created.accountBinding.revision,
          expectedGeneration: created.accountBinding.generation,
          state: diagnostic.state,
          reason: diagnostic.reason,
          checkedAt: diagnostic.checkedAt,
        });
        if (!updated) throw new SubscriptionProviderError("invalid_binding");
        repositories.providers.updateStatus(created.provider.id, providerStatus(diagnostic.state));
      });
      const finalProvider = repositories.providers.getById(created.provider.id)!;
      return json({ provider: safeProvider(finalProvider), connection: diagnostic }, 201);
    } catch (error) {
      if (error instanceof SubscriptionProviderError) return json({ error: error.message, code: error.code }, error.status);
      return json({ error: "Provider setup is unavailable" }, 503);
    } finally {
      database?.close();
    }
  };
}

export function createProviderConnectionHandler(dependencies: SubscriptionHandlerDependencies) {
  return async function POST(providerId: string, request: Request): Promise<Response> {
    const denied = await authorizedRequest(dependencies, request);
    if (denied) return denied;
    const body = await parseRequest(request, ["action"]);
    if (body instanceof Response) return body;
    if (body.action !== "check" && body.action !== "disconnect") return json({ error: "Invalid request" }, 400);

    let database: DatabaseSync | undefined;
    try {
      database = openDatabase(dependencies.databasePath!);
      const repositories = createRepositories(database);
      const provider = repositories.providers.getById(providerId);
      if (!provider) return json({ error: "Provider not found" }, 404);
      if (provider.authMode !== "subscription_cli" || provider.kind === null || provider.kind === "deepseek") {
        return json({ error: "Provider account binding is invalid" }, 400);
      }
      const binding = repositories.accountBindings.getByProviderId(providerId);
      if (!binding) return json({ error: "Provider binding not found" }, 404);

      if (body.action === "disconnect") {
        const config = loadConfiguration(dependencies);
        if (!findConfiguredBinding(config, binding.bindingId)) return json({ error: "Provider binding not found" }, 404);
        await dependencies.connector.cancel(binding.bindingId, AbortSignal.timeout(5_000)).catch(() => {
          throw new SubscriptionProviderError("unavailable");
        });
        withTransaction(database, () => {
          if (repositories.providers.advanceBindingGeneration(providerId) === null) {
            throw new SubscriptionProviderError("wrong_auth_mode");
          }
          if (!repositories.accountBindings.delete(providerId)) {
            throw new SubscriptionProviderError("invalid_binding");
          }
          repositories.providers.updateStatus(providerId, "not_configured");
        });
        return json({ provider: safeProvider(repositories.providers.getById(providerId)!), disconnected: true }, 200);
      }

      const config = loadConfiguration(dependencies);
      const configuredBinding = findConfiguredBinding(config, binding.bindingId);
      if (!configuredBinding || configuredBinding.kind !== provider.kind || configuredBinding.model !== provider.model) {
        return json({ error: "Provider binding does not match administrator configuration" }, 409);
      }
      let diagnostic: ConnectionDiagnostic;
      try {
        diagnostic = normalizeDiagnostic(
          await dependencies.connector.check(binding.bindingId, AbortSignal.timeout(10_000)),
          configuredBinding,
        );
      } catch (error) {
        diagnostic = diagnosticFromError(configuredBinding, error, (dependencies.clock ?? (() => new Date().toISOString()))());
      }
      const updated = withTransaction(database, () => {
        const changed = repositories.accountBindings.updateDiagnostic({
          providerId,
          bindingId: binding.bindingId,
          expectedRevision: binding.revision,
          expectedGeneration: binding.generation,
          state: diagnostic.state,
          reason: diagnostic.reason,
          checkedAt: diagnostic.checkedAt,
        });
        if (!changed) return false;
        repositories.providers.updateStatus(providerId, providerStatus(diagnostic.state));
        return true;
      });
      if (!updated) return json({ error: "Provider binding changed during check" }, 409);
      return json({ provider: safeProvider(repositories.providers.getById(providerId)!), connection: diagnostic }, 200);
    } catch (error) {
      if (error instanceof SubscriptionProviderError) return json({ error: error.message, code: error.code }, error.status);
      return json({ error: "Provider connection check is unavailable" }, 503);
    } finally {
      database?.close();
    }
  };
}
