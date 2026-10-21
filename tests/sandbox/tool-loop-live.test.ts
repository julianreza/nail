import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { openDatabase, createRepositories } from "../../lib/server/db/database";
import { createApprovalService } from "../../lib/server/runs/approval-service";
import { claimNextJob } from "../../lib/server/queue/queue-service";
import { runTaskToolLoop } from "../../lib/server/orchestration/tool-loop";
import { DockerCliDriver } from "../../worker/sandbox/docker-cli-driver";
import { RootlessDockerSandbox } from "../../worker/sandbox/runtime";

const live = process.env.NAIL_LIVE_SANDBOX === "1";

describe.skipIf(!live)("live rootless sandbox tool loop (explicit opt-in)", () => {
  it("feeds an actual container command result to a fixture model and cleans up", async () => {
    const root = mkdtempSync(join(tmpdir(), "nail-live-tool-loop-"));
    const workspacePath = join(root, "workspace");
    const baselinePath = join(root, "baseline");
    mkdirSync(workspacePath);
    mkdirSync(baselinePath);
    const db = (await openDatabase(join(root, "db-database")));
    const image = process.env.NAIL_SANDBOX_PROBE_IMAGE ?? "alpine:3.20";
    const sandbox = new RootlessDockerSandbox(new DockerCliDriver(), { probeImage: image });
    let handle: Awaited<ReturnType<typeof sandbox.start>> | undefined;
    try {
      const preflight = await sandbox.preflight();
      expect(preflight).toEqual({ ready: true });
      const repos = createRepositories(db);
      (await repos.projects.create({ id: "p", name: "Live fixture" }));
      (await repos.runs.create({ id: "r", projectId: "p", state: "draft" }));
      const scope = {
        planVersion: 1, baselineCommit: null, setupCommands: [],
        verificationCommands: ["id -u"], permissions: ["terminal:execute"], costLimitMicrounits: 100,
      };
      const approvalService = createApprovalService(db, { allowedPermissions: scope.permissions });
      const approval = (await approvalService.submitForApproval("r", scope));
      (await approvalService.decide(approval.id, { decision: "approved", expectedFingerprint: approval.payloadFingerprint }));
      (await claimNextJob(db, { workerId: "live-worker", now: new Date().toISOString(), leaseDurationMs: 60_000 }));
      (await repos.tasks.create({ id: "t", runId: "r", title: "Read sandbox UID", state: "running" }));
      handle = await sandbox.start({ runId: "r", image, workspacePath, baselinePath, approvedCommands: ["id -u"] });
      const activeHandle = handle;
      let calls = 0;
      const result = await runTaskToolLoop({
        database: db, runId: "r", taskId: "t", workerId: "live-worker", scope,
        allowedPermissions: scope.permissions, maxModelRequests: 2, maxToolCalls: 1,
        model: async (messages) => {
          calls += 1;
          if (calls === 1) return { content: null, toolCalls: [{ id: "uid-call", type: "function", function: { name: "run_command", arguments: '{"command":"id -u"}' } }] };
          const evidence = JSON.parse(messages.at(-1)!.content!) as { exitCode: number; stdout: string };
          expect(evidence).toMatchObject({ exitCode: 0, stdout: "10001\n" });
          return { content: "UID verified by the fixture", toolCalls: [] };
        },
        executeInSandbox: (command, signal) => sandbox.execute(activeHandle, command, signal),
      });
      expect(result.reason).toBe("model_finished");
      expect((await repos.runs.getById("r"))?.state).toBe("running");
      const completed = (await repos.events.listAfter("r", 0)).find((event) => event.eventType === "tool.completed");
      expect(completed?.payload).toMatchObject({ command: "id -u", stdout: "10001\n", exitCode: 0 });
      await sandbox.stop(handle);
      expect(execFileSync("docker", ["ps", "-a", "--filter", `id=${handle.containerId}`, "--format", "{{.ID}}"], { encoding: "utf8" }).trim()).toBe("");
    } finally {
      if (handle) await sandbox.stop(handle);
      (await db.close());
      rmSync(root, { recursive: true, force: true });
    }
  }, 120_000);
});
