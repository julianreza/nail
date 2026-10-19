import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApprovalService, type ApprovalScope } from "../../../lib/server/runs/approval-service";
import { openDatabase, createRepositories } from "../../../lib/server/db/database";
import {
  assertBaselineMatches,
  createCheckpoint,
  createRunWorkspace,
} from "../../../lib/server/projects/workspace-service";

const temporaryDirectories: string[] = [];
const allowedPermissions = ["workspace:read", "workspace:write", "terminal:execute"];

function createTempDirectory(): string {
  const path = mkdtempSync(join(tmpdir(), "nail-workspace-test-"));
  temporaryDirectories.push(path);
  return path;
}

function createGitRepository(parent: string) {
  const sourcePath = join(parent, "source-repo");
  mkdirSync(sourcePath, { recursive: true });
  execFileSync("git", ["init", "--quiet"], { cwd: sourcePath });
  execFileSync("git", ["config", "user.name", "Nail Test"], { cwd: sourcePath });
  execFileSync("git", ["config", "user.email", "nail-test@example.invalid"], { cwd: sourcePath });
  mkdirSync(join(sourcePath, "src"), { recursive: true });
  writeFileSync(join(sourcePath, "src", "app.ts"), "export const value = 1;\n");
  execFileSync("git", ["add", "src/app.ts"], { cwd: sourcePath });
  execFileSync("git", ["commit", "--quiet", "-m", "initial"], { cwd: sourcePath });
  const baselineCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: sourcePath,
    encoding: "utf8",
  }).trim();
  return { sourcePath, baselineCommit };
}

function approvedScope(baselineCommit: string | null): ApprovalScope {
  return {
    planVersion: 1,
    baselineCommit,
    setupCommands: ["bun install"],
    verificationCommands: ["bun run lint"],
    permissions: ["workspace:read", "workspace:write", "terminal:execute"],
    costLimitMicrounits: 2_000_000,
  };
}

function createApprovedRun(
  database: ReturnType<typeof openDatabase>,
  runId: string,
  baselineCommit: string | null,
) {
  const repositories = createRepositories(database);
  if (!repositories.projects.getById("project-1")) {
    repositories.projects.create({
      id: "project-1",
      name: "Nail",
      baselineCommit,
    });
  }
  repositories.runs.create({
    id: runId,
    projectId: "project-1",
    state: "draft",
    planVersion: 1,
    baselineCommit,
  });
  const approvals = createApprovalService(database, { allowedPermissions });
  const approval = approvals.submitForApproval(runId, approvedScope(baselineCommit));
  approvals.decide(approval.id, {
    decision: "approved",
    expectedFingerprint: approval.payloadFingerprint,
  });
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop()!, { recursive: true, force: true });
  }
});

describe("isolated run workspaces", () => {
  it("creates separate workspaces from an approved clean baseline and records checkpoints", () => {
    const root = createTempDirectory();
    const database = openDatabase(join(root, "db", "orchestrator.sqlite"));
    const repository = createGitRepository(root);
    try {
      createApprovedRun(database, "run-1", repository.baselineCommit);
      createApprovedRun(database, "run-2", repository.baselineCommit);
      const first = createRunWorkspace(database, {
        runId: "run-1",
        projectId: "project-1",
        sourcePath: repository.sourcePath,
        workspaceRoot: join(root, "workspaces"),
        baselineCommit: repository.baselineCommit,
        scope: approvedScope(repository.baselineCommit),
        allowedPermissions,
      });
      const second = createRunWorkspace(database, {
        runId: "run-2",
        projectId: "project-1",
        sourcePath: repository.sourcePath,
        workspaceRoot: join(root, "workspaces"),
        baselineCommit: repository.baselineCommit,
        scope: approvedScope(repository.baselineCommit),
        allowedPermissions,
      });

      expect(first.workspacePath).not.toBe(second.workspacePath);
      expect(first.commands.setupCommands).toEqual(["bun install"]);
      expect(readFileSync(join(first.workspacePath, "src", "app.ts"), "utf8")).toContain("value = 1");
      writeFileSync(join(first.workspacePath, "src", "app.ts"), "export const value = 2;\n");
      expect(readFileSync(join(second.workspacePath, "src", "app.ts"), "utf8")).toContain("value = 1");
      expect(readFileSync(join(repository.sourcePath, "src", "app.ts"), "utf8")).toContain("value = 1");

      createRepositories(database).tasks.create({
        id: "task-1",
        runId: "run-1",
        title: "First subtask",
      });
      const checkpoint = createCheckpoint(database, {
        runId: "run-1",
        taskId: "task-1",
      });
      expect(checkpoint.changedFiles).toEqual([
        expect.objectContaining({ path: "src/app.ts", status: "modified" }),
      ]);
      expect(readFileSync(checkpoint.snapshotPath, "utf8")).toContain("src/app.ts");
    } finally {
      database.close();
    }
  });

  it("rejects workspace creation without a matching approval or clean baseline", () => {
    const root = createTempDirectory();
    const database = openDatabase(join(root, "db", "orchestrator.sqlite"));
    const repository = createGitRepository(root);
    const repositories = createRepositories(database);
    repositories.projects.create({
      id: "project-1",
      name: "Nail",
      baselineCommit: repository.baselineCommit,
    });
    repositories.runs.create({
      id: "run-unapproved",
      projectId: "project-1",
      state: "draft",
      baselineCommit: repository.baselineCommit,
    });
    try {
      expect(() =>
        createRunWorkspace(database, {
          runId: "run-unapproved",
          projectId: "project-1",
          sourcePath: repository.sourcePath,
          workspaceRoot: join(root, "workspaces"),
          baselineCommit: repository.baselineCommit,
          scope: approvedScope(repository.baselineCommit),
          allowedPermissions,
        }),
      ).toThrow();
      expect(() => assertBaselineMatches("commit-a", "commit-b")).toThrow();

      writeFileSync(join(repository.sourcePath, "src", "app.ts"), "modified outside Git\n");
      createApprovedRun(database, "run-2", repository.baselineCommit);
      expect(() =>
        createRunWorkspace(database, {
          runId: "run-2",
          projectId: "project-1",
          sourcePath: repository.sourcePath,
          workspaceRoot: join(root, "workspaces"),
          baselineCommit: repository.baselineCommit,
          scope: approvedScope(repository.baselineCommit),
          allowedPermissions,
        }),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  it("requires an absolute workspace root", () => {
    const root = createTempDirectory();
    const database = openDatabase(join(root, "db", "orchestrator.sqlite"));
    const repository = createGitRepository(root);
    createApprovedRun(database, "run-1", repository.baselineCommit);
    try {
      expect(() =>
        createRunWorkspace(database, {
          runId: "run-1",
          projectId: "project-1",
          sourcePath: repository.sourcePath,
          workspaceRoot: "relative/workspaces",
          baselineCommit: repository.baselineCommit,
          scope: approvedScope(repository.baselineCommit),
          allowedPermissions,
        }),
      ).toThrow(/absolute path/);
    } finally {
      database.close();
    }
  });

  it("supports empty projects without initializing or committing a Git repository", () => {
    const root = createTempDirectory();
    const database = openDatabase(join(root, "db", "orchestrator.sqlite"));
    createApprovedRun(database, "run-empty", null);
    try {
      const workspace = createRunWorkspace(database, {
        runId: "run-empty",
        projectId: "project-1",
        sourcePath: null,
        workspaceRoot: join(root, "workspaces"),
        baselineCommit: null,
        scope: approvedScope(null),
        allowedPermissions,
      });
      expect(workspace.baselineCommit).toBeNull();
      expect(workspace.commands.verificationCommands).toEqual(["bun run lint"]);
    } finally {
      database.close();
    }
  });
});
