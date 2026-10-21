import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout } from "node:timers/promises";

// Builds must already exist. No vendor clients, real accounts, or live inference.
const appImage = process.env.NAIL_SMOKE_APP_IMAGE ?? "nail-docker-runtime:local";
const connectorImage = process.env.NAIL_SMOKE_CONNECTOR_IMAGE ?? "nail-connector-runtime:local";
const postgresImage = process.env.NAIL_SMOKE_POSTGRES_IMAGE ?? "postgres:17-alpine";
const prefix = `nail-smoke-${randomBytes(6).toString("hex")}`;
const app = `${prefix}-app`;
const connector = `${prefix}-connector`;
const database = `${prefix}-postgres`;
const volumes = ["data", "secrets", "accounts", "socket"].map((name) => `${prefix}-${name}`);
const password = randomBytes(24).toString("base64url");
const databasePassword = randomBytes(24).toString("base64url");
const origin = "https://nail-smoke.invalid";
const docker = (...args) => execFileSync("docker", args, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
const mount = (volume, target, readonly = false) => ["--mount", `type=volume,src=${volume},dst=${target}${readonly ? ",readonly" : ""}`];
let base;
let cookie;
async function request(path, body, authenticated = true, requestOrigin = origin) {
  return fetch(`${base}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json", origin: requestOrigin }),
      ...(authenticated && cookie ? { cookie } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
}
async function ready() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      if ((await request("/login")).status === 200) return;
    } catch { /* Startup may not have bound the port yet. */ }
    await setTimeout(500);
  }
  throw new Error("App did not become ready");
}
async function login() {
  const response = await request("/api/auth/login", { password }, false);
  assert.equal(response.status, 200, "owner login");
  const header = response.headers.get("set-cookie");
  assert.ok(header?.includes("HttpOnly"), "session cookie is HttpOnly");
  cookie = header.split(";")[0];
}
try {
  for (const volume of volumes) docker("volume", "create", volume);
  const initScript = `
    const fs = require('node:fs');
    const { randomBytes, scryptSync } = require('node:crypto');
    const { password, databasePassword } = JSON.parse(fs.readFileSync(0, 'utf8'));
    const salt = randomBytes(16);
    const values = {
      owner_password_hash: 'scrypt:' + salt.toString('base64url') + ':' + scryptSync(password, salt, 64).toString('base64url'),
      session_secret: randomBytes(48).toString('base64url'),
      nail_secret_encryption_key: randomBytes(32).toString('base64url'),
      database_url: 'postgresql://postgres:' + databasePassword + '@127.0.0.1:5432/postgres?sslmode=disable',
    };
    for (const [name, value] of Object.entries(values)) fs.writeFileSync('/run/secrets/' + name, value, { mode: 0o600 });
    for (const path of ['/accounts', '/accounts/accounts', '/accounts/accounts/codex-owner', '/socket']) {
      fs.mkdirSync(path, { recursive: true, mode: 0o700 });
      fs.chownSync(path, 10001, 10001);
      fs.chmodSync(path, 0o700);
    }
    fs.writeFileSync('/accounts/bindings.json', JSON.stringify({ version: 1, bindings: [{
      bindingId: 'codex-owner', kind: 'codex', executable: '/opt/vendor-bin/codex',
      home: '/accounts/accounts/codex-owner', model: 'smoke-model', enabled: true,
    }] }), { mode: 0o600 });
    fs.chownSync('/accounts/bindings.json', 10001, 10001);
  `;
  execFileSync("docker", ["run", "--rm", "-i", "--entrypoint", "node",
    ...mount(volumes[1], "/run/secrets"), ...mount(volumes[2], "/accounts"),
    ...mount(volumes[3], "/socket"), appImage, "-e", initScript], { input: JSON.stringify({ password, databasePassword }), stdio: ["pipe", "pipe", "pipe"] });
  const missingSecrets = docker("run", "--name", `${prefix}-missing`, "-d", appImage);
  assert.ok(missingSecrets);
  assert.equal(docker("wait", `${prefix}-missing`), "1", "missing secrets fail closed");
  docker("rm", `${prefix}-missing`);
  // Only the app shares this disposable network namespace. PostgreSQL is not
  // published on the host; its loopback transport is deliberately local-only.
  docker("run", "-d", "--name", database, "-p", "127.0.0.1::3000",
    "-e", `POSTGRES_PASSWORD=${databasePassword}`, postgresImage);
  let databaseReady = false;
  for (let attempt = 0; attempt < 60; attempt++) {
    try { docker("exec", database, "pg_isready", "-U", "postgres"); databaseReady = true; break; } catch { /* Starting. */ }
    await setTimeout(500);
  }
  assert.ok(databaseReady, "disposable PostgreSQL is ready");
  docker("run", "-d", "--name", connector, "--read-only", "--cap-drop=ALL",
    "--security-opt=no-new-privileges:true", "--tmpfs", "/tmp:rw,nosuid,nodev,size=32m",
    "-e", "HOME=/tmp", "-e", "NAIL_CONNECTOR_SOCKET=/socket/provider.sock",
    "-e", "NAIL_CONNECTOR_BINDINGS_FILE=/accounts/bindings.json",
    ...mount(volumes[2], "/accounts"), ...mount(volumes[3], "/socket"), connectorImage);
  docker("run", "-d", "--name", app, "--read-only", "--cap-drop=ALL",
    "--cap-add=CHOWN", "--cap-add=DAC_OVERRIDE", "--cap-add=FOWNER",
    "--cap-add=SETUID", "--cap-add=SETGID", "--cap-add=SETPCAP",
    "--security-opt=no-new-privileges:true", "--tmpfs", "/tmp:rw,nosuid,nodev,size=32m",
    "--tmpfs", "/app/.next/cache:rw,uid=10001,gid=10001,size=32m",
    "--network", `container:${database}`, "-e", `APP_ORIGIN=${origin}`,
    "-e", "NAIL_SECRET_DIR=/var/lib/nail/secrets",
    "-e", "NAIL_CONNECTOR_SOCKET=/socket/provider.sock",
    ...mount(volumes[0], "/var/lib/nail"), ...mount(volumes[1], "/run/secrets", true),
    ...mount(volumes[3], "/socket", true), appImage);
  const port = docker("port", database, "3000/tcp").split(":").at(-1);
  base = `http://127.0.0.1:${port}`;
  await ready();
  const environmentPresence = JSON.parse(docker("exec", "--user", "10001:10001", app, "node", "-e", "const fs=require('fs'); const env=fs.readFileSync('/proc/1/environ','utf8').split('\\0'); console.log(JSON.stringify(Object.fromEntries(['OWNER_PASSWORD_HASH','SESSION_SECRET','APP_ORIGIN'].map(k=>[k,env.some(e=>e.startsWith(k+'=') && e.length>k.length+1)]))))"));
  assert.deepEqual(environmentPresence, { OWNER_PASSWORD_HASH: true, SESSION_SECRET: true, APP_ORIGIN: true });
  const unauthenticated = await request("/api/providers", undefined, false);
  assert.equal(unauthenticated.status, 401, await unauthenticated.text());
  await login();
  const body = { kind: "codex", bindingId: "codex-owner", model: "smoke-model" };
  assert.equal((await request("/api/providers/subscriptions", body, true, "https://evil.invalid")).status, 403);
  const created = await request("/api/providers/subscriptions", body);
  assert.equal(created.status, 201, await created.clone().text());
  const payload = await created.json();
  assert.equal(payload.connection.state, "not_installed");
  assert.equal(payload.provider.status, "unavailable");
  assert.ok(!JSON.stringify(payload).includes("/accounts"), "private account paths are not returned");
  const status = docker("exec", app, "node", "-e", "const fs=require('fs'); console.log(fs.readFileSync('/proc/1/status','utf8'))");
  assert.match(status, /Uid:\s+10001\s+10001\s+10001\s+10001/);
  assert.match(status, /CapEff:\s+0+\b/);
  const isolation = docker("exec", "--user", "10001:10001", app, "node", "-e",
    "const fs=require('fs'); console.log(JSON.stringify({accounts:fs.existsSync('/accounts'),docker:fs.existsSync('/var/run/docker.sock')}))");
  assert.deepEqual(JSON.parse(isolation), { accounts: false, docker: false });
  const connectorIsolation = docker("exec", connector, "node", "-e",
    "const fs=require('fs'); console.log(JSON.stringify({databaseUrl:!!process.env.DATABASE_URL,databaseSecret:fs.existsSync('/run/secrets/database_url')}))");
  assert.deepEqual(JSON.parse(connectorIsolation), { databaseUrl: false, databaseSecret: false });
  docker("restart", app);
  base = `http://127.0.0.1:${docker("port", database, "3000/tcp").split(":").at(-1)}`;
  cookie = undefined;
  await ready();
  await login();
  const checked = await request(`/api/providers/${payload.provider.id}/connection`, { action: "check" });
  assert.equal(checked.status, 200, await checked.clone().text());
  assert.equal((await checked.json()).connection.state, "not_installed");
  console.log("PASS: both Docker images start; missing secrets rejected; owner login and origin guard work; private socket binding discovery works without account mounts in app; PID 1 runs as UID 10001 with zero effective capabilities; provider PostgreSQL state survives restart; database credentials never enter connector; subscription remains fail-closed. No external database or live accounts used.");
} catch (error) {
  for (const container of [app, connector]) {
    try {
      console.error(`${container}: ${docker("inspect", "--format", "{{json .State}} {{json .NetworkSettings.Ports}}", container)}`);
      console.error(execFileSync("sh", ["-c", 'docker logs "$1" 2>&1', "sh", container], { encoding: "utf8" }));
    } catch { /* Container may not exist. */ }
  }
  throw error;
} finally {
  for (const container of [app, connector, `${prefix}-missing`, database]) {
    try { docker("rm", "-f", container); } catch { /* Already removed or never created. */ }
  }
  for (const volume of volumes) {
    try { docker("volume", "rm", volume); } catch { /* Preserve original test failure. */ }
  }
}
