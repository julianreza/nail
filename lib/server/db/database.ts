import { chmodSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { migrateDatabase } from "./migrations";

export function openDatabase(path: string): DatabaseSync {
  if (!path) throw new Error("A persistent SQLite database path is required");
  if (path !== ":memory:") {
    mkdirSync(dirname(resolve(path)), { recursive: true });
  }

  const database = new DatabaseSync(path);
  try {
    if (path !== ":memory:") {
      chmodSync(path, 0o600);
    }
    database.exec("PRAGMA foreign_keys = ON;");
    database.exec("PRAGMA busy_timeout = 5000;");
    if (path !== ":memory:") {
      database.exec("PRAGMA journal_mode = WAL;");
    }
    migrateDatabase(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function withTransaction<T>(
  database: DatabaseSync,
  operation: () => T,
): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = operation();
    if (
      result !== null &&
      typeof result === "object" &&
      "then" in result &&
      typeof result.then === "function"
    ) {
      throw new Error("SQLite transactions must be synchronous");
    }
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

export { createRepositories } from "./repositories";
