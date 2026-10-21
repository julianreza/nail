import { randomBytes } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { setTimeout } from "node:timers/promises";

// Explicit opt-in: run only against a new disposable LOCAL PostgreSQL container.
const name = `nail-postgres-tests-${randomBytes(6).toString("hex")}`;
const password = randomBytes(24).toString("base64url");
const image = process.env.NAIL_TEST_POSTGRES_IMAGE ?? "postgres:17-alpine";
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
let created = false;
try {
  docker("run", "--detach", "--rm", "--name", name,
    "--tmpfs", "/var/lib/postgresql/data:rw,nosuid,nodev",
    "--publish", "127.0.0.1::5432", "--env", `POSTGRES_PASSWORD=${password}`, image);
  created = true;
  let ready = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { docker("exec", name, "pg_isready", "-U", "postgres"); ready = true; break; } catch { /* Starting. */ }
    await setTimeout(500);
  }
  if (!ready) throw new Error("Disposable PostgreSQL did not become ready");
  // Exercise Supabase-style default API grants; migrations must revoke them.
  docker("exec", name, "psql", "-U", "postgres", "-v", "ON_ERROR_STOP=1", "-c",
    "CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS; ALTER DEFAULT PRIVILEGES GRANT ALL ON TABLES TO anon, authenticated, service_role;");
  const port = docker("port", name, "5432/tcp").split(":").at(-1);
  console.log("Running tests against disposable local PostgreSQL (no external project).");
  const result = spawnSync("bun", ["run", "test", ...process.argv.slice(2)], {
    stdio: "inherit",
    env: { ...process.env, NAIL_TEST_DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:${port}/postgres` },
  });
  if (result.error) throw new Error("Unable to start Bun test runner", { cause: result.error });
  process.exitCode = result.status ?? 1;
} finally {
  if (created) docker("rm", "--force", name);
}
