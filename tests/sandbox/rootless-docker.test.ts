import { describe, expect, it } from "vitest";
import { getDelegatedControllers, parseDockerInspectRecord } from "../../worker/sandbox/docker-cli-driver";
import {
  SANDBOX_POLICY,
  RootlessDockerSandbox,
  type DockerContainerSpec,
  type DockerDriver,
} from "../../worker/sandbox/runtime";

class FakeDockerDriver implements DockerDriver {
  host = {
    dockerAvailable: true,
    rootless: true,
    cgroupVersion: "2" as "1" | "2" | "unknown",
    delegatedControllers: ["cpu", "memory", "pids"],
  };
  probe = {
    cpuLimitEffective: true,
    memoryLimitEffective: true,
    pidsLimitEffective: true,
    swapDisabled: true,
    networkIsolated: true,
    nonRoot: true,
    hostFilesystemDenied: true,
    metadataDenied: true,
    credentialsAbsent: true,
  };
  createCalls: DockerContainerSpec[] = [];
  execCalls: string[] = [];
  stopped: string[] = [];
  stopFinished: string[] = [];
  stopDelayMs = 0;
  running = false;
  inspected?: DockerContainerSpec;
  onExec?: () => void;

  async inspectHost() {
    return this.host;
  }

  async probeResourceLimits() {
    return this.probe;
  }

  async create(spec: DockerContainerSpec): Promise<string> {
    this.createCalls.push(spec);
    this.inspected = spec;
    return "container-1";
  }

  async start(): Promise<void> {
    this.running = true;
  }

  async inspect(): Promise<{ running: boolean; spec: DockerContainerSpec }> {
    return { running: this.running, spec: this.inspected! };
  }

  async exec(
    _containerId: string,
    command: string,
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<{ exitCode: number; stdout: string; stderr: string; outputTruncated: boolean }> {
    this.execCalls.push(command);
    this.onExec?.();
    return await new Promise((resolve) => {
      const finish = () =>
        resolve({ exitCode: -1, stdout: "", stderr: "cancelled", outputTruncated: false });
      if (options.signal.aborted) finish();
      else options.signal.addEventListener("abort", finish, { once: true });
    });
  }

  async stop(containerId: string): Promise<void> {
    this.stopped.push(containerId);
    this.running = false;
    if (this.stopDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.stopDelayMs));
    }
    this.stopFinished.push(containerId);
  }
}

describe("fail-closed rootless sandbox", () => {
  it("parses the single object emitted by Docker inspect format templates", () => {
    expect(parseDockerInspectRecord({ HostConfig: { NetworkMode: "none" } })).toMatchObject({
      HostConfig: { NetworkMode: "none" },
    });
    expect(parseDockerInspectRecord([{ State: { Running: true } }])).toMatchObject({
      State: { Running: true },
    });
  });

  it("requires delegated CPU, memory, and PID controllers", () => {
    expect(
      getDelegatedControllers("yes", ["cpu", "memory", "pids", "io"]),
    ).toEqual(["cpu", "memory", "pids"]);
    expect(getDelegatedControllers("no", ["cpu", "memory", "pids"])).toEqual([]);
  });

  it("refuses to start without rootless cgroup v2 and never falls back to host execution", async () => {
    const driver = new FakeDockerDriver();
    driver.host = {
      dockerAvailable: false,
      rootless: false,
      cgroupVersion: "unknown",
      delegatedControllers: [],
    };
    const sandbox = new RootlessDockerSandbox(driver, { probeImage: "trusted-probe:1" });

    await expect(sandbox.start({
      runId: "run-1",
      image: "project-image:1",
      workspacePath: "/work/run-1",
      baselinePath: "/work/run-1-baseline",
      approvedCommands: ["bun run test"],
    })).rejects.toThrow();
    expect(await sandbox.preflight()).toMatchObject({ ready: false });
    expect(driver.createCalls).toEqual([]);
    expect(driver.execCalls).toEqual([]);
  });

  it("uses fixed CPU, memory, PID, network, user, and mount constraints", async () => {
    const driver = new FakeDockerDriver();
    const sandbox = new RootlessDockerSandbox(driver, { probeImage: "trusted-probe:1" });
    const handle = await sandbox.start({
      runId: "run-1",
      image: "project-image:1",
      workspacePath: "/workspace/run-1",
      baselinePath: "/workspace/baseline-1",
      approvedCommands: ["bun run test"],
    });

    expect(SANDBOX_POLICY).toMatchObject({
      cpuCores: 1,
      memoryBytes: 805_306_368,
      pidsLimit: 128,
      timeoutMs: 900_000,
    });
    expect(driver.createCalls[0]).toMatchObject({
      cpuCores: 1,
      memoryBytes: 805_306_368,
      memorySwapBytes: 805_306_368,
      pidsLimit: 128,
      networkMode: "none",
      user: "10001:10001",
      readOnlyRootFilesystem: true,
      capabilities: [],
      noNewPrivileges: true,
      mounts: [
        { source: "/workspace/run-1", target: "/workspace", readOnly: false },
        { source: "/workspace/baseline-1", target: "/baseline", readOnly: true },
      ],
    });
    expect(handle.containerId).toBe("container-1");
  });

  it("executes only an exactly approved command and stops the whole container on cancellation", async () => {
    const driver = new FakeDockerDriver();
    driver.stopDelayMs = 30;
    const sandbox = new RootlessDockerSandbox(driver, { probeImage: "trusted-probe:1" });
    const handle = await sandbox.start({
      runId: "run-1",
      image: "project-image:1",
      workspacePath: "/workspace/run-1",
      baselinePath: "/workspace/baseline-1",
      approvedCommands: ["bun run test"],
    });

    await expect(sandbox.execute(handle, "bun install")).rejects.toThrow();
    expect(driver.execCalls).toEqual([]);

    const controller = new AbortController();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    driver.onExec = markStarted;
    const execution = sandbox.execute(handle, "bun run test", controller.signal);
    await started;
    controller.abort("owner_cancelled");
    await expect(execution).rejects.toThrow();
    expect(driver.execCalls).toEqual(["bun run test"]);
    expect(driver.stopped).toEqual(["container-1"]);
    expect(driver.stopFinished).toEqual(["container-1"]);
  });

  it("does not start an approved command when cancellation was already requested", async () => {
    const driver = new FakeDockerDriver();
    const sandbox = new RootlessDockerSandbox(driver, { probeImage: "trusted-probe:1" });
    const handle = await sandbox.start({
      runId: "run-1",
      image: "project-image:1",
      workspacePath: "/workspace/run-1",
      baselinePath: "/workspace/baseline-1",
      approvedCommands: ["bun run test"],
    });
    const controller = new AbortController();
    controller.abort("owner_cancelled");

    await expect(sandbox.execute(handle, "bun run test", controller.signal)).rejects.toThrow();
    expect(driver.execCalls).toEqual([]);
    expect(driver.stopped).toEqual(["container-1"]);
  });

  it("fails preflight if any effective limit or network isolation probe fails", async () => {
    const driver = new FakeDockerDriver();
    driver.probe.networkIsolated = false;
    const sandbox = new RootlessDockerSandbox(driver, { probeImage: "trusted-probe:1" });

    expect(await sandbox.preflight()).toMatchObject({
      ready: false,
      reason: "resource_probe_failed",
    });
    await expect(sandbox.start({
      runId: "run-2",
      image: "project-image:1",
      workspacePath: "/workspace/run-2",
      baselinePath: "/workspace/baseline-2",
      approvedCommands: [],
    })).rejects.toThrow();
    expect(driver.createCalls).toEqual([]);
  });
});
