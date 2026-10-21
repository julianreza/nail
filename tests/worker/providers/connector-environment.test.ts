import { describe, expect, it } from "vitest";
import { createConnectorEnvironment } from "../../../worker/providers/connector-environment";

describe("subscription connector process environment", () => {
  it("keeps only operational runtime variables and the two connector settings", () => {
    const result = createConnectorEnvironment({
      PATH: "/usr/bin:/bin",
      HOME: "/var/lib/nail-connector",
      TMPDIR: "/var/tmp/nail-connector",
      LANG: "C.UTF-8",
      NAIL_CONNECTOR_SOCKET: "/var/lib/nail-connector/provider.sock",
      NAIL_CONNECTOR_BINDINGS_FILE: "/var/lib/nail-connector/bindings.json",
      DATABASE_URL: "postgresql://owner:must-not-reach-connector@db.invalid/postgres",
      DATABASE_CA_CERT_PATH: "/private/database-ca.crt",
      OWNER_PASSWORD_HASH: "owner-secret",
      SESSION_SECRET: "session-secret",
      NAIL_SECRET_ENCRYPTION_KEY: "encryption-secret",
      OPENAI_API_KEY: "billing-key",
      CODEX_HOME: "/home/user/.codex",
      NODE_OPTIONS: "--require=attacker.js",
      HTTPS_PROXY: "http://proxy-with-credentials.invalid",
    });
    expect(result).toEqual({
      PATH: "/usr/bin:/bin",
      HOME: "/var/lib/nail-connector",
      TMPDIR: "/var/tmp/nail-connector",
      LANG: "C.UTF-8",
      NAIL_CONNECTOR_SOCKET: "/var/lib/nail-connector/provider.sock",
      NAIL_CONNECTOR_BINDINGS_FILE: "/var/lib/nail-connector/bindings.json",
    });
  });

  it("rejects missing connector paths and unsafe environment values", () => {
    expect(() => createConnectorEnvironment({ PATH: "/usr/bin" })).toThrow();
    expect(() => createConnectorEnvironment({
      PATH: "/usr/bin",
      HOME: "/var/lib/nail-connector",
      NAIL_CONNECTOR_SOCKET: "/tmp/provider.sock\nmalicious",
      NAIL_CONNECTOR_BINDINGS_FILE: "/tmp/bindings.json",
    })).toThrow();
  });
});
