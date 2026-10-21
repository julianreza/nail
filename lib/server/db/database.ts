// Shared by Next server routes and the standalone worker. Next-facing runtime
// entrypoints retain their server-only markers; that package throws outside Next.
import { AsyncLocalStorage } from "node:async_hooks";
import { readFileSync } from "node:fs";
import { Pool, types, type PoolClient, type PoolConfig } from "pg";
import { migrateDatabase } from "./migrations";

if (typeof window !== "undefined") {
  throw new Error("Database access is restricted to the server");
}

// Never let URL sslmode options silently override certificate verification.
export function databasePoolConfig(connectionString: string): PoolConfig {
  let url: URL;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error("A PostgreSQL DATABASE_URL is required");
  }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) {
    throw new Error("A PostgreSQL DATABASE_URL is required");
  }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  const mode = url.searchParams.get("sslmode");
  if (mode && !["disable", "require", "verify-ca", "verify-full"].includes(mode)) {
    throw new Error("Unsupported DATABASE_URL TLS mode");
  }
  if (mode === "disable" && !local && process.env.NODE_ENV !== "test") {
    throw new Error("Remote PostgreSQL connections require verified TLS");
  }
  // Parse connection fields explicitly: pg's connectionString parser can
  // otherwise override `ssl` with query parameters (including ssl=0).
  return {
    host: url.hostname.replace(/^\[|\]$/g, ""),
    port: url.port ? Number(url.port) : 5432,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.slice(1)),
    application_name: url.searchParams.get("application_name") ?? "nail",
    options: url.searchParams.get("options") ?? undefined,
    ssl: local && mode !== "require" && mode !== "verify-full" && mode !== "verify-ca"
      ? false
      : { rejectUnauthorized: true, ...(process.env.DATABASE_CA_CERT_PATH
        ? { ca: readFileSync(process.env.DATABASE_CA_CERT_PATH, "utf8") }
        : {}) },
    max: 5,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    // Keep aggregate counts numeric without globally changing pg type parsers.
    types: { getTypeParser: (oid) => {
      if (oid === 1184) return (value: string) => new Date(value).toISOString();
      if (oid === 20) return (value: string) => {
        const number = Number(value);
        if (!Number.isSafeInteger(number)) throw new Error("Database integer exceeds the safe application range");
        return number;
      };
      return types.getTypeParser(oid);
    } },
  };
}

interface TransactionContext {
  connection: PoolClient;
  pending: Promise<void>;
  failure?: unknown;
  closed: boolean;
}

export class Database {
  private readonly transaction = new AsyncLocalStorage<TransactionContext>();

  constructor(private readonly pool: Pool) {
    pool.on("error", () => { console.error("An idle PostgreSQL connection failed"); });
  }

  private query(sql: string, values: unknown[] = []) {
    const context = this.transaction.getStore();
    if (!context) return this.pool.query(sql, values);
    if (context.closed) return Promise.reject(new Error("Transaction has already ended"));
    const result = context.pending.then(() => context.connection.query(sql, values));
    context.pending = result.then(() => undefined, (error: unknown) => { context.failure = error; });
    return result;
  }

  prepare(sql: string) {
    const query = (values: unknown[]) => this.query(sql, values);
    return {
      get: async (...values: unknown[]): Promise<Record<string, unknown> | undefined> =>
        (await query(values)).rows[0],
      all: async (...values: unknown[]): Promise<Record<string, unknown>[]> =>
        (await query(values)).rows,
      run: async (...values: unknown[]): Promise<{ changes: number }> =>
        ({ changes: (await query(values)).rowCount ?? 0 }),
    };
  }

  async exec(sql: string): Promise<void> {
    await this.query(sql);
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  async withTransaction<T>(operation: () => T | Promise<T>): Promise<T> {
    const enclosing = this.transaction.getStore();
    if (enclosing) {
      // Nested operations join the parent; even a caught failure aborts it.
      try { return await operation(); } catch (error) {
        enclosing.failure = error;
        throw error;
      }
    }
    const connection = await this.pool.connect();
    const context: TransactionContext = { connection, pending: Promise.resolve(), closed: false };
    let discard = false;
    try {
      await connection.query("BEGIN");
      // Nail deliberately executes one orchestration mutation at a time. The
      // transaction-scoped lock also covers the initially absent global lease.
      await connection.query("SELECT pg_advisory_xact_lock(1869506924, 1)");
      const result = await this.transaction.run(context, operation);
      await context.pending;
      if (context.failure) throw context.failure;
      context.closed = true;
      await connection.query("COMMIT");
      return result;
    } catch (error) {
      await context.pending;
      context.closed = true;
      try { await connection.query("ROLLBACK"); } catch { discard = true; }
      throw error;
    } finally {
      connection.release(discard);
    }
  }
}

// Initialization happens only on an authenticated runtime request, never import.
export async function openDatabase(url = process.env.DATABASE_URL): Promise<Database> {
  if (!url) throw new Error("A server-only DATABASE_URL is required");
  const database = new Database(new Pool(databasePoolConfig(url)));
  try {
    await migrateDatabase(database);
    return database;
  } catch (error) {
    await database.close();
    throw error;
  }
}

export function withTransaction<T>(
  database: Database,
  operation: () => T | Promise<T>,
): Promise<T> {
  return database.withTransaction(operation);
}

export { createRepositories } from "./repositories";
