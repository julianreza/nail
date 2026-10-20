import {
  lstatSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  SUBSCRIPTION_PROVIDER_KINDS,
  type SubscriptionProviderKind,
} from "../../lib/domain/subscription-provider";

export type ConnectorConfigurationErrorCode = "missing_configuration" | "invalid_configuration";

export class ConnectorConfigurationError extends Error {
  constructor(public readonly code: ConnectorConfigurationErrorCode) {
    super(code === "missing_configuration"
      ? "Subscription connector configuration is missing"
      : "Subscription connector configuration is invalid");
    this.name = "ConnectorConfigurationError";
  }
}

export interface ConnectorBindingConfig {
  bindingId: string;
  kind: SubscriptionProviderKind;
  executable: string;
  home: string;
  model: string;
  enabled: boolean;
}

export interface ConnectorConfig {
  socketPath: string;
  bindingsFilePath: string;
  bindings: ConnectorBindingConfig[];
}

interface ConnectorConfigOptions {
  applicationRoot: string;
  sandboxRoot?: string;
  personalHome?: string;
}

const EXPECTED_EXECUTABLE: Record<SubscriptionProviderKind, string> = {
  antigravity: "agy",
  codex: "codex",
  claude: "claude",
};
const MAX_CONFIG_BYTES = 64 * 1024;
const BINDING_ID = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function invalid(): never {
  throw new ConnectorConfigurationError("invalid_configuration");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactFields(value: Record<string, unknown>, fields: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return actual.length === expected.length && actual.every((field, index) => field === expected[index]);
}

function canonical(path: string): string {
  if (!isAbsolute(path)) return invalid();
  try {
    return realpathSync(path);
  } catch {
    return invalid();
  }
}

function pathInside(path: string, parent: string): boolean {
  const rel = relative(parent, path);
  return rel === "" || (!rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && rel !== ".." && !isAbsolute(rel));
}

function pathsOverlap(first: string, second: string): boolean {
  return pathInside(first, second) || pathInside(second, first);
}

function assertOwned(path: string, maximumMode: number, requireDirectory: boolean): void {
  let stat;
  try {
    stat = lstatSync(path);
  } catch {
    return invalid();
  }
  if (stat.isSymbolicLink() || (requireDirectory ? !stat.isDirectory() : !stat.isFile())) return invalid();
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) return invalid();
  if ((stat.mode & maximumMode) !== 0) return invalid();
}

function readBindings(path: string, forbiddenRoots: readonly string[]): ConnectorBindingConfig[] {
  let stat;
  let parsed: unknown;
  try {
    stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_CONFIG_BYTES) return invalid();
    const uid = process.getuid?.();
    if ((uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) return invalid();
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return invalid();
  }
  if (!isRecord(parsed) || !exactFields(parsed, ["version", "bindings"]) || parsed.version !== 1 || !Array.isArray(parsed.bindings) || parsed.bindings.length > 3) {
    return invalid();
  }

  const bindingIds = new Set<string>();
  const kinds = new Set<string>();
  const accountsRoot = join(dirname(path), "accounts");
  const accountsRootCanonical = canonical(accountsRoot);
  if (accountsRootCanonical !== resolve(accountsRoot)) return invalid();
  assertOwned(accountsRoot, 0o077, true);

  return parsed.bindings.map((item): ConnectorBindingConfig => {
    if (
      !isRecord(item) ||
      !exactFields(item, ["bindingId", "kind", "executable", "home", "model", "enabled"]) ||
      typeof item.bindingId !== "string" || !BINDING_ID.test(item.bindingId) ||
      !SUBSCRIPTION_PROVIDER_KINDS.includes(item.kind as SubscriptionProviderKind) ||
      typeof item.executable !== "string" || !isAbsolute(item.executable) ||
      typeof item.home !== "string" || !isAbsolute(item.home) ||
      typeof item.model !== "string" || !MODEL_ID.test(item.model) ||
      typeof item.enabled !== "boolean"
    ) return invalid();

    const kind = item.kind as SubscriptionProviderKind;
    if (bindingIds.has(item.bindingId) || kinds.has(kind)) return invalid();
    bindingIds.add(item.bindingId);
    kinds.add(kind);

    if (basename(item.executable) !== EXPECTED_EXECUTABLE[kind]) return invalid();
    const executable = canonical(item.executable);
    if (forbiddenRoots.some((rootPath) => pathsOverlap(executable, rootPath))) return invalid();
    let executableStat;
    try {
      executableStat = statSync(executable);
    } catch {
      return invalid();
    }
    const uid = process.getuid?.();
    if (
      !executableStat.isFile() ||
      (uid !== undefined && executableStat.uid !== uid && executableStat.uid !== 0) ||
      (executableStat.mode & 0o111) === 0 ||
      (executableStat.mode & 0o022) !== 0
    ) return invalid();

    const expectedHome = join(accountsRootCanonical, item.bindingId);
    const home = canonical(item.home);
    if (home !== expectedHome) return invalid();
    assertOwned(home, 0o077, true);
    return {
      bindingId: item.bindingId,
      kind,
      executable,
      home,
      model: item.model,
      enabled: item.enabled,
    };
  });
}

export function loadConnectorConfig(
  environment: Record<string, string | undefined> = process.env,
  options: ConnectorConfigOptions = { applicationRoot: process.cwd() },
): ConnectorConfig {
  const socketSetting = environment.NAIL_CONNECTOR_SOCKET;
  const bindingsSetting = environment.NAIL_CONNECTOR_BINDINGS_FILE;
  if (!socketSetting || !bindingsSetting) {
    throw new ConnectorConfigurationError("missing_configuration");
  }
  if (!isAbsolute(socketSetting) || !isAbsolute(bindingsSetting)) return invalid();

  const bindingsFileSetting = resolve(bindingsSetting);
  const bindingsFilePath = canonical(bindingsFileSetting);
  if (bindingsFilePath !== bindingsFileSetting || basename(bindingsFilePath) !== "bindings.json") return invalid();
  const rootSetting = dirname(bindingsFileSetting);
  const root = canonical(rootSetting);
  if (root !== rootSetting) return invalid();
  assertOwned(root, 0o077, true);

  const socketPath = resolve(socketSetting);
  if (dirname(socketPath) !== root || basename(socketPath) !== "provider.sock") return invalid();
  try {
    const socketStat = lstatSync(socketPath);
    if (!socketStat.isSocket() || socketStat.isSymbolicLink()) return invalid();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return invalid();
  }

  const applicationRoot = resolve(options.applicationRoot);
  const forbiddenRoots = [applicationRoot];
  if (options.sandboxRoot) forbiddenRoots.push(resolve(options.sandboxRoot));
  const personalHome = options.personalHome ?? environment.HOME;
  if (personalHome) forbiddenRoots.push(resolve(personalHome));
  if (forbiddenRoots.some((rootPath) => pathsOverlap(root, rootPath))) return invalid();

  return {
    socketPath,
    bindingsFilePath,
    bindings: readBindings(bindingsFilePath, forbiddenRoots),
  };
}
