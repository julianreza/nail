import { spawn, type ChildProcess } from "node:child_process";
import { accessSync, constants, lstatSync, realpathSync, readdirSync, statSync } from "node:fs";
import { delimiter, isAbsolute, resolve } from "node:path";
import { SubscriptionProviderError } from "../../lib/server/providers/subscription-errors";

export interface ProviderProcessSpec {
  executable: string;
  args: string[];
  cwd: string;
  env: Record<string, string | undefined>;
  stdin: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface ProviderProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

const ALLOWED_ENVIRONMENT_KEYS = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "CODEX_HOME",
]);
const MAX_PROMPT_BYTES = 64 * 1024;
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_TIMEOUT_MS = 120_000;
const TERMINATION_GRACE_MS = 2_000;

function invalidSpec(): never {
  throw new SubscriptionProviderError("invalid_binding");
}

function canonical(path: string): string {
  if (!isAbsolute(path)) return invalidSpec();
  try {
    return realpathSync(path);
  } catch {
    return invalidSpec();
  }
}

function validatePathDirectory(path: string, requirePrivate: boolean, requireCanonical = true): string {
  const resolved = canonical(path);
  if (requireCanonical && resolved !== resolve(path)) return invalidSpec();
  let stat;
  try {
    stat = lstatSync(resolved);
  } catch {
    return invalidSpec();
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) return invalidSpec();
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid && !(stat.uid === 0 && !requirePrivate)) return invalidSpec();
  if (requirePrivate && (stat.mode & 0o077) !== 0) return invalidSpec();
  return resolved;
}

function validateEnvironment(environment: ProviderProcessSpec["env"], cwd: string): NodeJS.ProcessEnv {
  const result = {} as NodeJS.ProcessEnv;
  for (const key of ALLOWED_ENVIRONMENT_KEYS) {
    const value = environment[key];
    if (value === undefined) continue;
    if (typeof value !== "string" || value.length > 4096 || value.includes("\0")) return invalidSpec();
    result[key] = value;
  }

  if (!result.HOME) return invalidSpec();
  const home = validatePathDirectory(result.HOME, true);
  if (home === cwd) return invalidSpec();
  result.HOME = home;

  if (result.CODEX_HOME !== undefined) {
    const codexHome = validatePathDirectory(result.CODEX_HOME, true);
    if (codexHome !== home) return invalidSpec();
    result.CODEX_HOME = codexHome;
  }

  const pathValue = result.PATH ?? "/usr/bin:/bin";
  const safePaths = new Set<string>();
  for (const entry of pathValue.split(delimiter)) {
    if (!entry || !isAbsolute(entry)) return invalidSpec();
    const safePath = validatePathDirectory(entry, false, false);
    if (safePath === home || safePath === cwd) return invalidSpec();
    let stat;
    try {
      stat = statSync(safePath);
      accessSync(safePath, constants.X_OK);
    } catch {
      return invalidSpec();
    }
    const uid = process.getuid?.();
    if ((uid !== undefined && stat.uid !== uid && stat.uid !== 0) || (stat.mode & 0o022) !== 0) {
      return invalidSpec();
    }
    safePaths.add(safePath);
  }
  result.PATH = [...safePaths].join(delimiter);

  for (const key of ["TMPDIR", "TMP", "TEMP", "SSL_CERT_FILE", "SSL_CERT_DIR"] as const) {
    const value = result[key];
    if (value === undefined) continue;
    if (!isAbsolute(value)) return invalidSpec();
    const resolved = canonical(value);
    result[key] = resolved;
  }
  for (const key of ["LANG", "LC_ALL", "LC_CTYPE"] as const) {
    const value = result[key];
    if (value !== undefined && !/^[A-Za-z0-9_.@-]{1,64}$/.test(value)) return invalidSpec();
  }
  return result;
}

function signalGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === "linux") {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    try {
      child.kill(signal);
    } catch {
      // The process may already have exited; close/error handlers settle the request.
    }
  }
}

export async function runProviderProcess(
  spec: ProviderProcessSpec,
  signal: AbortSignal,
): Promise<ProviderProcessResult> {
  if (signal.aborted) throw new SubscriptionProviderError("cancelled");
  if (
    process.platform !== "linux" ||
    !Array.isArray(spec.args) || spec.args.length > 64 ||
    spec.args.some((arg) => typeof arg !== "string" || arg.length > 4096 || arg.includes("\0")) ||
    typeof spec.stdin !== "string" || Buffer.byteLength(spec.stdin, "utf8") > MAX_PROMPT_BYTES ||
    !Number.isSafeInteger(spec.timeoutMs) || spec.timeoutMs < 1 || spec.timeoutMs > MAX_TIMEOUT_MS ||
    !Number.isSafeInteger(spec.maxOutputBytes) || spec.maxOutputBytes < 1 || spec.maxOutputBytes > MAX_OUTPUT_BYTES
  ) return invalidSpec();

  if (!isAbsolute(spec.executable)) return invalidSpec();
  let executable: string;
  try {
    executable = realpathSync(spec.executable);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new SubscriptionProviderError("not_installed");
    }
    return invalidSpec();
  }
  let executableStat;
  try {
    executableStat = statSync(executable);
    accessSync(executable, constants.X_OK);
  } catch {
    throw new SubscriptionProviderError("not_installed");
  }
  const uid = process.getuid?.();
  if (
    !executableStat.isFile() ||
    (uid !== undefined && executableStat.uid !== uid && executableStat.uid !== 0) ||
    (executableStat.mode & 0o022) !== 0
  ) return invalidSpec();

  const cwd = validatePathDirectory(spec.cwd, false);
  if (readdirSync(cwd).length !== 0) return invalidSpec();
  const env = validateEnvironment(spec.env, cwd);

  return new Promise<ProviderProcessResult>((resolvePromise, rejectPromise) => {
    let child: ChildProcess;
    try {
      child = spawn(executable, spec.args, {
        cwd,
        env,
        shell: false,
        detached: true,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      rejectPromise(new SubscriptionProviderError("unavailable"));
      return;
    }

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let outputBytes = 0;
    let failure: "not_installed" | "unavailable" | "timeout" | "output_limit" | "cancelled" | null = null;
    let spawnFailed = false;
    let closed = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const terminate = (reason: NonNullable<typeof failure>) => {
      if (closed || failure !== null) return;
      failure = reason;
      signalGroup(child, "SIGTERM");
      forceKillTimer = setTimeout(() => signalGroup(child, "SIGKILL"), TERMINATION_GRACE_MS);
    };
    const timeout = setTimeout(() => terminate("timeout"), spec.timeoutMs);
    const onAbort = () => terminate("cancelled");
    signal.addEventListener("abort", onAbort, { once: true });

    const collect = (target: Buffer[]) => (chunk: Buffer | string) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      outputBytes += bytes.byteLength;
      if (outputBytes > spec.maxOutputBytes) {
        terminate("output_limit");
        return;
      }
      if (failure === null) target.push(bytes);
    };
    child.stdout?.on("data", collect(stdout));
    child.stderr?.on("data", collect(stderr));
    child.stdin?.on("error", () => undefined);
    child.on("error", (error: NodeJS.ErrnoException) => {
      spawnFailed = true;
      if (failure === null) failure = error.code === "ENOENT" ? "not_installed" : "unavailable";
    });
    child.on("close", (exitCode) => {
      closed = true;
      clearTimeout(timeout);
      if (forceKillTimer) {
        clearTimeout(forceKillTimer);
        if (failure !== null) signalGroup(child, "SIGKILL");
      }
      signal.removeEventListener("abort", onAbort);
      if (failure !== null) {
        rejectPromise(new SubscriptionProviderError(failure));
        return;
      }
      if (spawnFailed || exitCode === null) {
        rejectPromise(new SubscriptionProviderError("unavailable"));
        return;
      }
      resolvePromise({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode,
      });
    });
    if (signal.aborted) terminate("cancelled");
    child.stdin?.end(spec.stdin, "utf8");
  });
}
