const CONNECTOR_ENVIRONMENT_KEYS = [
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
  "NAIL_CONNECTOR_SOCKET",
  "NAIL_CONNECTOR_BINDINGS_FILE",
] as const;

export function createConnectorEnvironment(
  source: Record<string, string | undefined>,
): Record<string, string> {
  const result: Record<string, string> = {};
  for (const key of CONNECTOR_ENVIRONMENT_KEYS) {
    const value = source[key];
    if (value === undefined) continue;
    if (value.length > 4096 || /[\0\r\n]/.test(value)) {
      throw new Error("Connector environment is invalid");
    }
    result[key] = value;
  }
  for (const key of ["PATH", "HOME", "NAIL_CONNECTOR_SOCKET", "NAIL_CONNECTOR_BINDINGS_FILE"] as const) {
    if (!result[key]) throw new Error("Connector environment is incomplete");
  }
  const socketPath = result.NAIL_CONNECTOR_SOCKET;
  const bindingsPath = result.NAIL_CONNECTOR_BINDINGS_FILE;
  if (!socketPath || !bindingsPath) throw new Error("Connector environment is incomplete");
  if (!socketPath.startsWith("/") || !bindingsPath.startsWith("/")) {
    throw new Error("Connector paths must be absolute");
  }
  return result;
}
