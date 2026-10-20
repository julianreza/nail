import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConnectorConfig, ConnectorConfigurationError } from "../../../worker/providers/connector-config";

const roots: string[] = [];

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "nail-connector-config-"));
  roots.push(root);
  const dataDirectory = join(root, "connector-data");
  const accountsDirectory = join(dataDirectory, "accounts");
  const binDirectory = join(root, "vendor-bin");
  mkdirSync(accountsDirectory, { recursive: true, mode: 0o700 });
  mkdirSync(binDirectory, { recursive: true, mode: 0o700 });
  const home = join(accountsDirectory, "codex-owner");
  mkdirSync(home, { mode: 0o700 });
  const executable = join(binDirectory, "codex");
  writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const bindingsFile = join(dataDirectory, "bindings.json");
  const socket = join(dataDirectory, "provider.sock");
  const document = {
    version: 1,
    bindings: [{
      bindingId: "codex-owner",
      kind: "codex",
      executable,
      home,
      model: "gpt-6-codex",
      enabled: true,
    }],
  };
  writeFileSync(bindingsFile, JSON.stringify(document), { mode: 0o600 });
  const environment = {
    NAIL_CONNECTOR_SOCKET: socket,
    NAIL_CONNECTOR_BINDINGS_FILE: bindingsFile,
  };
  const personalHome = join(root, "personal-home");
  const config = () => loadConnectorConfig(environment, {
    applicationRoot: join(root, "app"),
    sandboxRoot: join(root, "sandbox"),
    personalHome,
  });
  return { root, dataDirectory, accountsDirectory, personalHome, home, executable, bindingsFile, socket, document, environment, config };
}

afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe("subscription connector configuration", () => {
  it("loads a secure owner-controlled binding with canonical paths", () => {
    const { config, executable, home, socket, bindingsFile } = fixture();
    const loaded = config();
    expect(loaded.socketPath).toBe(socket);
    expect(loaded.bindingsFilePath).toBe(bindingsFile);
    expect(loaded.bindings).toEqual([expect.objectContaining({
      bindingId: "codex-owner",
      kind: "codex",
      executable,
      home,
      model: "gpt-6-codex",
      enabled: true,
    })]);
  });

  it("keeps a securely configured but uninstalled official CLI available for diagnostics", () => {
    const missingCli = fixture();
    rmSync(missingCli.executable);
    expect(missingCli.config().bindings[0]?.executable).toBe(missingCli.executable);
  });

  it("requires both startup-only environment paths", () => {
    const { environment } = fixture();
    expect(() => loadConnectorConfig({}, { applicationRoot: "/app" }))
      .toThrowError(new ConnectorConfigurationError("missing_configuration"));
    expect(() => loadConnectorConfig({ ...environment, NAIL_CONNECTOR_SOCKET: "relative.sock" }, { applicationRoot: "/app" }))
      .toThrowError(new ConnectorConfigurationError("invalid_configuration"));
  });

  it("rejects unsafe config permissions, invalid account homes and symlink escapes", () => {
    const insecureConfig = fixture();
    chmodSync(insecureConfig.bindingsFile, 0o644);
    expect(() => insecureConfig.config()).toThrowError(ConnectorConfigurationError);

    const insecureHome = fixture();
    chmodSync(insecureHome.home, 0o755);
    expect(() => insecureHome.config()).toThrowError(ConnectorConfigurationError);

    const escapedHome = fixture();
    const elsewhere = join(escapedHome.root, "other-home");
    mkdirSync(elsewhere, { mode: 0o700 });
    rmSync(escapedHome.home, { recursive: true });
    symlinkSync(elsewhere, escapedHome.home);
    expect(() => escapedHome.config()).toThrowError(ConnectorConfigurationError);
  });

  it("rejects duplicate bindings, unsupported kinds and executable-name substitution", () => {
    const duplicate = fixture();
    const item = duplicate.document.bindings[0];
    writeFileSync(duplicate.bindingsFile, JSON.stringify({ version: 1, bindings: [item, item] }), { mode: 0o600 });
    expect(() => duplicate.config()).toThrowError(ConnectorConfigurationError);

    const wrongKind = fixture();
    writeFileSync(wrongKind.bindingsFile, JSON.stringify({
      version: 1,
      bindings: [{ ...wrongKind.document.bindings[0], kind: "deepseek" }],
    }), { mode: 0o600 });
    expect(() => wrongKind.config()).toThrowError(ConnectorConfigurationError);

    const wrongExecutable = fixture();
    const codex = wrongExecutable.document.bindings[0];
    writeFileSync(wrongExecutable.bindingsFile, JSON.stringify({
      version: 1,
      bindings: [{ ...codex, kind: "antigravity", executable: codex.executable }],
    }), { mode: 0o600 });
    expect(() => wrongExecutable.config()).toThrowError(ConnectorConfigurationError);
  });

  it("rejects connector roots inside the application, personal home or sandbox", () => {
    const rootInApplication = fixture();
    expect(() => loadConnectorConfig(rootInApplication.environment, {
      applicationRoot: rootInApplication.root,
      sandboxRoot: join(rootInApplication.root, "sandbox"),
      personalHome: rootInApplication.personalHome,
    })).toThrowError(ConnectorConfigurationError);

    const rootInPersonalHome = fixture();
    expect(() => loadConnectorConfig(rootInPersonalHome.environment, {
      applicationRoot: join(rootInPersonalHome.root, "app"),
      sandboxRoot: join(rootInPersonalHome.root, "sandbox"),
      personalHome: rootInPersonalHome.root,
    })).toThrowError(ConnectorConfigurationError);

    const rootInSandbox = fixture();
    expect(() => loadConnectorConfig(rootInSandbox.environment, {
      applicationRoot: join(rootInSandbox.root, "app"),
      sandboxRoot: rootInSandbox.root,
      personalHome: rootInSandbox.personalHome,
    })).toThrowError(ConnectorConfigurationError);
  });

  it("rejects an accounts-root symlink and executables located in the sandbox", () => {
    const symlinkedAccounts = fixture();
    const externalAccounts = join(symlinkedAccounts.root, "external-accounts");
    mkdirSync(externalAccounts, { mode: 0o700 });
    rmSync(symlinkedAccounts.accountsDirectory, { recursive: true, force: true });
    symlinkSync(externalAccounts, symlinkedAccounts.accountsDirectory);
    expect(() => symlinkedAccounts.config()).toThrowError(ConnectorConfigurationError);

    const sandboxExecutable = fixture();
    const sandboxDir = join(sandboxExecutable.root, "sandbox");
    mkdirSync(sandboxDir, { mode: 0o700 });
    const fakeExe = join(sandboxDir, "codex");
    writeFileSync(fakeExe, "#!/bin/sh\\nexit 0\\n", { mode: 0o700 });
    writeFileSync(sandboxExecutable.bindingsFile, JSON.stringify({
      version: 1,
      bindings: [{ ...sandboxExecutable.document.bindings[0], executable: fakeExe }],
    }), { mode: 0o600 });
    expect(() => sandboxExecutable.config()).toThrowError(ConnectorConfigurationError);
  });
});
