export const SANDBOX_POLICY = {
  cpuCores: 1,
  memoryBytes: 768 * 1024 * 1024,
  memorySwapBytes: 768 * 1024 * 1024,
  pidsLimit: 128,
  timeoutMs: 15 * 60 * 1000,
  maxOutputBytes: 10 * 1024 * 1024,
  networkMode: "none" as const,
  user: "10001:10001" as const,
  readOnlyRootFilesystem: true as const,
  capabilities: [] as string[],
  noNewPrivileges: true as const,
};

export interface SandboxHostCapabilities {
  dockerAvailable: boolean;
  rootless: boolean;
  cgroupVersion: "1" | "2" | "unknown";
  delegatedControllers: string[];
}

export interface ResourceProbeResult {
  cpuLimitEffective: boolean;
  memoryLimitEffective: boolean;
  pidsLimitEffective: boolean;
  swapDisabled: boolean;
  networkIsolated: boolean;
  nonRoot: boolean;
  hostFilesystemDenied: boolean;
  metadataDenied: boolean;
  credentialsAbsent: boolean;
}

export interface SandboxMount {
  source: string;
  target: string;
  readOnly: boolean;
}

export interface DockerContainerSpec {
  runId: string;
  image: string;
  cpuCores: number;
  memoryBytes: number;
  memorySwapBytes: number;
  pidsLimit: number;
  networkMode: string;
  user: string;
  readOnlyRootFilesystem: boolean;
  capabilities: string[];
  noNewPrivileges: boolean;
  privileged: boolean;
  tmpfs: Record<string, string>;
  mounts: SandboxMount[];
  approvedCommands: string[];
}

export interface DockerInspection {
  running: boolean;
  spec: DockerContainerSpec;
}

export interface SandboxCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  outputTruncated: boolean;
}

export interface DockerDriver {
  inspectHost(): Promise<SandboxHostCapabilities>;
  probeResourceLimits(
    image: string,
    policy: typeof SANDBOX_POLICY,
  ): Promise<ResourceProbeResult>;
  create(spec: DockerContainerSpec): Promise<string>;
  start(containerId: string): Promise<void>;
  inspect(containerId: string): Promise<DockerInspection>;
  exec(
    containerId: string,
    command: string,
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<SandboxCommandResult>;
  stop(containerId: string): Promise<void>;
}

export interface SandboxHandle {
  containerId: string;
  runId: string;
}

export interface SandboxPreflight {
  ready: boolean;
  reason?:
    | "docker_unavailable"
    | "rootless_docker_required"
    | "cgroup_v2_required"
    | "cgroup_controllers_not_delegated"
    | "probe_image_not_configured"
    | "resource_probe_failed";
}

export class SandboxUnavailableError extends Error {
  constructor(public readonly reason: SandboxPreflight["reason"]) {
    super(`Sandbox execution disabled: ${reason ?? "preflight_failed"}`);
    this.name = "SandboxUnavailableError";
  }
}

function safeImageName(image: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,255}$/.test(image);
}

function safeMountPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= 4096 &&
    !/[\0\r\n,]/.test(path) &&
    path.startsWith("/")
  );
}

function outputWithinLimit(output: SandboxCommandResult): SandboxCommandResult {
  let remaining = SANDBOX_POLICY.maxOutputBytes;
  let outputTruncated = output.outputTruncated;
  const truncate = (value: string): string => {
    const buffer = Buffer.from(value, "utf8");
    if (buffer.byteLength <= remaining) {
      remaining -= buffer.byteLength;
      return value;
    }
    outputTruncated = true;
    const clipped = buffer.subarray(0, Math.max(0, remaining)).toString("utf8");
    remaining = 0;
    return clipped;
  };
  return {
    exitCode: output.exitCode,
    stdout: truncate(output.stdout),
    stderr: truncate(output.stderr),
    outputTruncated,
  };
}

export class RootlessDockerSandbox {
  private readonly active = new Map<string, SandboxHandle>();

  constructor(
    private readonly driver: DockerDriver,
    private readonly options: { probeImage?: string },
  ) {}

  async preflight(): Promise<SandboxPreflight> {
    if (!this.options.probeImage || !safeImageName(this.options.probeImage)) {
      return { ready: false, reason: "probe_image_not_configured" };
    }

    let host: SandboxHostCapabilities;
    try {
      host = await this.driver.inspectHost();
    } catch {
      return { ready: false, reason: "docker_unavailable" };
    }
    if (!host.dockerAvailable) return { ready: false, reason: "docker_unavailable" };
    if (!host.rootless) return { ready: false, reason: "rootless_docker_required" };
    if (host.cgroupVersion !== "2") return { ready: false, reason: "cgroup_v2_required" };
    const delegated = new Set(host.delegatedControllers);
    if (!["cpu", "memory", "pids"].every((controller) => delegated.has(controller))) {
      return { ready: false, reason: "cgroup_controllers_not_delegated" };
    }

    try {
      const probe = await this.driver.probeResourceLimits(
        this.options.probeImage,
        SANDBOX_POLICY,
      );
      if (!Object.values(probe).every(Boolean)) {
        return { ready: false, reason: "resource_probe_failed" };
      }
      return { ready: true };
    } catch {
      return { ready: false, reason: "resource_probe_failed" };
    }
  }

  async start(input: {
    runId: string;
    image: string;
    workspacePath: string;
    baselinePath: string;
    approvedCommands: readonly string[];
  }): Promise<SandboxHandle> {
    const preflight = await this.preflight();
    if (!preflight.ready) throw new SandboxUnavailableError(preflight.reason);
    if (!safeImageName(input.image)) throw new Error("Sandbox image name is invalid");
    if (!safeMountPath(input.workspacePath) || !safeMountPath(input.baselinePath)) {
      throw new Error("Sandbox mount paths must be absolute and contain no delimiters");
    }
    if (input.workspacePath === input.baselinePath) {
      throw new Error("Workspace and baseline mounts must be distinct");
    }
    if (
      input.approvedCommands.length > 64 ||
      input.approvedCommands.some((command) => !command.trim() || command.length > 4096)
    ) {
      throw new Error("Sandbox approved command list is invalid");
    }

    const spec: DockerContainerSpec = {
      runId: input.runId,
      image: input.image,
      cpuCores: SANDBOX_POLICY.cpuCores,
      memoryBytes: SANDBOX_POLICY.memoryBytes,
      memorySwapBytes: SANDBOX_POLICY.memorySwapBytes,
      pidsLimit: SANDBOX_POLICY.pidsLimit,
      networkMode: SANDBOX_POLICY.networkMode,
      user: SANDBOX_POLICY.user,
      readOnlyRootFilesystem: SANDBOX_POLICY.readOnlyRootFilesystem,
      capabilities: [],
      noNewPrivileges: SANDBOX_POLICY.noNewPrivileges,
      privileged: false,
      tmpfs: { "/tmp": "rw,noexec,nosuid,nodev,size=16m" },
      mounts: [
        { source: input.workspacePath, target: "/workspace", readOnly: false },
        { source: input.baselinePath, target: "/baseline", readOnly: true },
      ],
      approvedCommands: [...input.approvedCommands],
    };

    let containerId: string | undefined;
    try {
      containerId = await this.driver.create(spec);
      const created = await this.driver.inspect(containerId);
      if (!this.specMatches(created.spec, spec)) {
        throw new Error("Docker did not apply the requested sandbox restrictions");
      }
      await this.driver.start(containerId);
      const started = await this.driver.inspect(containerId);
      if (!started.running || !this.specMatches(started.spec, spec)) {
        throw new Error("Sandbox did not start with the requested restrictions");
      }
      const handle = { containerId, runId: input.runId };
      this.active.set(containerId, handle);
      return handle;
    } catch (error) {
      if (containerId) await this.driver.stop(containerId).catch(() => undefined);
      throw error;
    }
  }

  private specMatches(actual: DockerContainerSpec, expected: DockerContainerSpec): boolean {
    return (
      actual.image === expected.image &&
      actual.cpuCores === expected.cpuCores &&
      actual.memoryBytes === expected.memoryBytes &&
      actual.memorySwapBytes === expected.memorySwapBytes &&
      actual.pidsLimit === expected.pidsLimit &&
      actual.networkMode === "none" &&
      actual.user === "10001:10001" &&
      actual.readOnlyRootFilesystem &&
      actual.capabilities.length === 0 &&
      actual.noNewPrivileges &&
      !actual.privileged &&
      JSON.stringify(actual.tmpfs) === JSON.stringify(expected.tmpfs) &&
      actual.mounts.length === 2 &&
      actual.mounts.some((mount) =>
        mount.source === expected.mounts[0].source &&
        mount.target === "/workspace" &&
        !mount.readOnly,
      ) &&
      actual.mounts.some((mount) =>
        mount.source === expected.mounts[1].source &&
        mount.target === "/baseline" &&
        mount.readOnly,
      )
    );
  }

  async execute(
    handle: SandboxHandle,
    command: string,
    externalSignal?: AbortSignal,
  ): Promise<SandboxCommandResult> {
    const active = this.active.get(handle.containerId);
    if (!active || active.runId !== handle.runId) throw new Error("Sandbox handle is not active");
    if (externalSignal?.aborted) {
      await this.stop(handle);
      throw new Error("Sandbox command cancelled");
    }
    const created = await this.driver.inspect(handle.containerId);
    if (externalSignal?.aborted) {
      await this.stop(handle);
      throw new Error("Sandbox command cancelled");
    }
    if (!created.spec.approvedCommands.includes(command)) {
      throw new Error("Command is not in the approved sandbox command list");
    }

    const controller = new AbortController();
    let stopPromise: Promise<void> | undefined;
    const stopOnAbort = () => {
      stopPromise ??= this.stop(handle);
      void stopPromise.catch(() => undefined);
    };
    controller.signal.addEventListener("abort", stopOnAbort, { once: true });
    const externalAbort = () => controller.abort(externalSignal?.reason);
    externalSignal?.addEventListener("abort", externalAbort, { once: true });
    if (externalSignal?.aborted) externalAbort();
    const timeout = setTimeout(() => {
      controller.abort("sandbox_timeout");
    }, SANDBOX_POLICY.timeoutMs);

    try {
      const result = await this.driver.exec(handle.containerId, command, {
        signal: controller.signal,
        timeoutMs: SANDBOX_POLICY.timeoutMs,
      });
      if (controller.signal.aborted) {
        throw new Error("Sandbox command interrupted");
      }
      return outputWithinLimit(result);
    } catch (error) {
      if (controller.signal.aborted) {
        await stopPromise;
        throw new Error(
          controller.signal.reason === "sandbox_timeout"
            ? "Sandbox command timed out"
            : "Sandbox command cancelled",
        );
      }
      throw error;
    } finally {
      clearTimeout(timeout);
      controller.signal.removeEventListener("abort", stopOnAbort);
      externalSignal?.removeEventListener("abort", externalAbort);
    }
  }

  async inspect(handle: SandboxHandle): Promise<DockerInspection> {
    if (!this.active.has(handle.containerId)) throw new Error("Sandbox handle is not active");
    return this.driver.inspect(handle.containerId);
  }

  async stop(handle: SandboxHandle): Promise<void> {
    if (!this.active.has(handle.containerId)) return;
    this.active.delete(handle.containerId);
    await this.driver.stop(handle.containerId);
  }
}
