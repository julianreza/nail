import { createHash, randomUUID } from "node:crypto";
import { Pool } from "pg";
import { afterAll, vi } from "vitest";
import type { Database } from "../../lib/server/db/database";

const state = vi.hoisted(() => ({ schemas: new Map<string, Promise<string>>(), databases: new Set<Database>() }));

// Only this test setup accepts opaque fixture IDs. Production accepts URLs only.
// Each fixture gets a dedicated schema on an explicitly opted-in disposable DB.
vi.mock("../../lib/server/db/database", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../lib/server/db/database")>();
  return {
    ...original,
    openDatabase: async (identity: string) => {
      const base = process.env.NAIL_TEST_DATABASE_URL;
      if (!base) throw new Error("Database tests require NAIL_TEST_DATABASE_URL pointing to disposable PostgreSQL");
      if (/^postgres(?:ql)?:/.test(identity)) return original.openDatabase(identity);
      let pending = state.schemas.get(identity);
      if (!pending) {
        pending = (async () => {
          const schema = `nail_test_${createHash("sha256").update(identity + randomUUID()).digest("hex").slice(0, 24)}`;
          const pool = new Pool(original.databasePoolConfig(base));
          try { await pool.query(`CREATE SCHEMA "${schema}"`); } finally { await pool.end(); }
          const url = new URL(base);
          url.searchParams.set("options", `-c search_path=${schema}`);
          return url.toString();
        })();
        state.schemas.set(identity, pending);
      }
      const database = await original.openDatabase(await pending);
      state.databases.add(database);
      const close = database.close.bind(database);
      database.close = async () => { if (state.databases.delete(database)) await close(); };
      return database;
    },
  };
});

afterAll(async () => {
  await Promise.all([...state.databases].map((database) => database.close()));
  if (!state.schemas.size) return;
  const { databasePoolConfig } = await import("../../lib/server/db/database");
  const pool = new Pool(databasePoolConfig(process.env.NAIL_TEST_DATABASE_URL!));
  try {
    for (const pending of state.schemas.values()) {
      const url = new URL(await pending);
      const schema = url.searchParams.get("options")!.replace("-c search_path=", "");
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    }
  } finally { await pool.end(); }
});
