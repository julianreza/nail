import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import {
  SANDBOX_POLICY,
  type DockerContainerSpec,
  type DockerDriver,
  type DockerInspection,
  type ResourceProbeResult,
  type SandboxCommandResult,
  type SandboxHostCapabilities,
} from "./runtime";

interface DockerInspectRecord {
  State?: { Running?: boolean };
  Config?: { User?: string; Image?: string };
  HostConfig?: {
    NanoCpus?: number;
    CpuQuota?: number;
    CpuPeriod?: number;
    Memory?: number;
    MemorySwap?: number;
    PidsLimit?: number;
    NetworkMode?: string;
    ReadonlyRootfs?: boolean;
    CapDrop?: string[];
    SecurityOpt?: string[];
    Privileged?: boolean;
    Binds?: string[] | null;
    Tmpfs?: Record<string, string> | null;
  };
  Mounts?: Array<{ Type?: string; Source?: string; Destination?: string; RW?: boolean }>;
}

interface DockerInfoRecord {
  SecurityOptions?: string[];
  CgroupVersion?: string;
  CgroupDriver?: string;
}

interface CommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

const MAX_DOCKER_OUTPUT_BYTES = 10 * 1024 * 1024;
const SANDBOX_PROBE_SCRIPT = [
  "set -eu",
  "test \"$(id -u)\" = \"10001\"",
  "test \"$(cat /sys/fs/cgroup/cpu.max)\" = \"100000 100000\"",
  "test \"$(cat /sys/fs/cgroup/memory.max)\" = \"805306368\"",
  "test \"$(cat /sys/fs/cgroup/memory.swap.max)\" = \"0\"",
  "test \"$(cat /sys/fs/cgroup/pids.max)\" = \"128\"",
  "awk 'NR > 1 && $2 == \"00000000\" { route = 1 } END { exit route ? 1 : 0 }' /proc/net/route",
].join(" && ");

function execDocker(
  args: string[],
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    execFile(
      "docker",
      args,
      {
        encoding: "utf8",
        maxBuffer: MAX_DOCKER_OUTPUT_BYTES,
        timeout: options.timeoutMs,
        signal: options.signal,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const exitCode = error
          ? typeof error.code === "number"
            ? error.code
            : -1
          : 0;
        resolve({
          exitCode,
          stdout: String(stdout ?? ""),
          stderr: String(stderr ?? error?.message ?? ""),
        });
      },
    );
  });
}

async function dockerOk(args: string[], options?: { signal?: AbortSignal; timeoutMs?: number }): Promise<string> {
  const result = await execDocker(args, options);
  if (result.exitCode !== 0) {
    throw new Error(`Docker command failed (${result.exitCode})`);
  }
  return result.stdout;
}

function controllersForCurrentCgroup(): string[] {
  try {
    const entry = readFileSync("/proc/self/cgroup", "utf8")
      .split("\n")
      .find((line) => line.startsWith("0::"));
    if (!entry) return [];
    const relativeCgroup = entry.slice(3).replace(/^\/+/, "");
    const current = `/sys/fs/cgroup/${relativeCgroup}`;
    const available = readFileSync(`${current}/cgroup.controllers`, "utf8")
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const delegated = readFileSync(`${current}/cgroup.subtree_control`, "utf8")
      .trim()
      .split(/\s+/)
      .map((value) => value.replace(/^\+/, ""))
      .filter(Boolean);
    const delegatedSet = new Set(delegated);
    return available.filter((controller) => delegatedSet.has(controller));
  } catch {
    return [];
  }
}

function parseInspect(raw: string): DockerInspectRecord {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error("Unexpected Docker inspect result");
  }
  return parsed[0] as DockerInspectRecord;
}

function effectiveCpuLimit(host: NonNullable<DockerInspectRecord["HostConfig"]>): number {
  if (host.NanoCpus && host.NanoCpus > 0) return host.NanoCpus / 1_000_000_000;
  if (host.CpuQuota && host.CpuPeriod) return host.CpuQuota / host.CpuPeriod;
  return 0;
}

export class DockerCliDriver implements DockerDriver {
  private readonly requestedSpecs = new Map<string, DockerContainerSpec>();

  async inspectHost(): Promise<SandboxHostCapabilities> {
    try {
      const infoText = await dockerOk(["info", "--format", "{{json .}}"]);
      const info = JSON.parse(infoText) as DockerInfoRecord;
      const securityOptions = info.SecurityOptions ?? [];
      return {
        dockerAvailable: true,
        rootless: securityOptions.some((item) => item.toLowerCase().includes("rootless")),
        cgroupVersion: info.CgroupVersion === "2" ? "2" : info.CgroupVersion === "1" ? "1" : "unknown",
        delegatedControllers: controllersForCurrentCgroup(),
      };
    } catch {
      return {
        dockerAvailable: false,
        rootless: false,
        cgroupVersion: "unknown",
        delegatedControllers: [],
      };
    }
  }

  async probeResourceLimits(
    image: string,
    policy: typeof SANDBOX_POLICY,
  ): Promise<ResourceProbeResult> {
    const containerName = `nail-preflight-${randomUUID()}`;
    let containerId: string | undefined;
    try {
      const create = await dockerOk([
        "create",
        "--pull=never",
        `--name=${containerName}`,
        `--cpu-period=100000`,
        `--cpu-quota=${Math.round(policy.cpuCores * 100000)}`,
        `--memory=${policy.memoryBytes}`,
        `--memory-swap=${policy.memorySwapBytes}`,
        `--pids-limit=${policy.pidsLimit}`,
        "--network=none",
        `--user=${policy.user}`,
        "--read-only",
        "--cap-drop=ALL",
        "--security-opt=no-new-privileges:true",
        "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m",
        "--entrypoint=/bin/sh",
        image,
        "-c",
        SANDBOX_PROBE_SCRIPT,
      ]);
      containerId = create.trim();
      if (!containerId) throw new Error("Docker did not return a probe container ID");
      const probeInspect = parseInspect(
        await dockerOk(["inspect", "--format", "{{json .}}", containerId]),
      );
      const host = probeInspect.HostConfig ?? {};
      const mounts = probeInspect.Mounts ?? [];
      const hostMounts = mounts.filter((mount) => mount.Type === "bind" || mount.Type === "volume");
      const config = probeInspect.Config ?? {};
      const tmpfs = host.Tmpfs ?? {};
      const configSafe =
        !host.Privileged &&
        host.NetworkMode === "none" &&
        config.User === policy.user &&
        host.ReadonlyRootfs === true &&
        (host.Binds?.length ?? 0) === 0 &&
        hostMounts.length === 0 &&
        tmpfs["/tmp"] === "rw,noexec,nosuid,nodev,size=16m" &&
        (host.CapDrop ?? []).includes("ALL") &&
        (host.SecurityOpt ?? []).some((entry) => entry.includes("no-new-privileges"));
      const run = await execDocker(["start", "--attach", containerId], { timeoutMs: 30_000 });
      return {
        cpuLimitEffective: configSafe && effectiveCpuLimit(host) === policy.cpuCores && run.exitCode === 0,
        memoryLimitEffective: configSafe && host.Memory === policy.memoryBytes && run.exitCode === 0,
        pidsLimitEffective: configSafe && host.PidsLimit === policy.pidsLimit && run.exitCode === 0,
        swapDisabled: configSafe && host.MemorySwap === policy.memorySwapBytes && run.exitCode === 0,
        networkIsolated: configSafe && host.NetworkMode === "none" && run.exitCode === 0,
        nonRoot: configSafe && config.User === policy.user && run.exitCode === 0,
        hostFilesystemDenied: configSafe && hostMounts.length === 0,
        metadataDenied: configSafe && host.NetworkMode === "none",
        credentialsAbsent: configSafe && (host.Binds?.length ?? 0) === 0 && hostMounts.length === 0,
      };
    } finally {
      if (containerId) {
        await execDocker(["rm", "--force", containerId], { timeoutMs: 10_000 });
      } else {
        await execDocker(["rm", "--force", containerName], { timeoutMs: 10_000 });
      }
    }
  }

  async create(spec: DockerContainerSpec): Promise<string> {
    const name = `nail-run-${randomUUID()}`;
    const mounts = spec.mounts.map(
      (mount) =>
        `type=bind,source=${mount.source},target=${mount.target}${mount.readOnly ? ",readonly" : ""}`,
    );
    const rawId = await dockerOk([
      "create",
      "--pull=never",
      `--name=${name}`,
      `--cpu-period=100000`,
      `--cpu-quota=${Math.round(spec.cpuCores * 100000)}`,
      `--memory=${spec.memoryBytes}`,
      `--memory-swap=${spec.memorySwapBytes}`,
      `--pids-limit=${spec.pidsLimit}`,
      `--network=${spec.networkMode}`,
      `--user=${spec.user}`,
      "--read-only",
      "--cap-drop=ALL",
      "--security-opt=no-new-privileges:true",
      "--tmpfs=/tmp:rw,noexec,nosuid,nodev,size=16m",
      `--mount=${mounts[0]}`,
      `--mount=${mounts[1]}`,
      "--workdir=/workspace",
      "--entrypoint=/bin/sh",
      spec.image,
      "-c",
      "while :; do /bin/sleep 3600; done",
    ]);
    const id = rawId.trim();
    if (!id) throw new Error("Docker did not return a container ID");
    this.requestedSpecs.set(id, spec);
    return id;
  }

  async start(containerId: string): Promise<void> {
    await dockerOk(["start", containerId]);
  }

  async inspect(containerId: string): Promise<DockerInspection> {
    const inspected = parseInspect(await dockerOk(["inspect", "--format", "{{json .}}", containerId]));
    const requested = this.requestedSpecs.get(containerId);
    if (!requested) throw new Error("Unknown sandbox container");
    const host = inspected.HostConfig ?? {};
    const mounts = (inspected.Mounts ?? []).filter(
      (mount) => mount.Type === "bind" || mount.Type === "volume",
    );
    const actualMounts = mounts.map((mount) => ({
      source: mount.Source ?? "",
      target: mount.Destination ?? "",
      readOnly: mount.RW === false,
    }));
    return {
      running: inspected.State?.Running === true,
      spec: {
        ...requested,
        image: inspected.Config?.Image ?? "",
        cpuCores: effectiveCpuLimit(host),
        memoryBytes: host.Memory ?? 0,
        memorySwapBytes: host.MemorySwap ?? 0,
        pidsLimit: host.PidsLimit ?? 0,
        networkMode: host.NetworkMode ?? "",
        user: inspected.Config?.User ?? "",
        readOnlyRootFilesystem: host.ReadonlyRootfs === true,
        capabilities: host.CapDrop?.includes("ALL") ? [] : ["capabilities-not-dropped"],
        noNewPrivileges: (host.SecurityOpt ?? []).some((entry) => entry.includes("no-new-privileges")),
        privileged: host.Privileged === true,
        tmpfs: host.Tmpfs ?? {},
        mounts: actualMounts as DockerContainerSpec["mounts"],
      },
    };
  }

  async exec(
    containerId: string,
    command: string,
    options: { signal: AbortSignal; timeoutMs: number },
  ): Promise<SandboxCommandResult> {
    const result = await execDocker(
      ["exec", "--user=10001:10001", "--workdir=/workspace", containerId, "/bin/sh", "-lc", command],
      { signal: options.signal, timeoutMs: options.timeoutMs },
    );
    return {
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      outputTruncated: false,
    };
  }

  async stop(containerId: string): Promise<void> {
    try {
      await execDocker(["kill", containerId], { timeoutMs: 10_000 });
    } finally {
      await execDocker(["rm", "--force", containerId], { timeoutMs: 10_000 });
      this.requestedSpecs.delete(containerId);
    }
  }
}
