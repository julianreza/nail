import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  cpSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Database } from "../db/database";
import { createApprovalService, type ApprovalScope } from "../runs/approval-service";
import { createRepositories, type WorkspaceRecord } from "../db/repositories";
import { withTransaction } from "../db/database";

export interface WorkspaceOptions {
  runId: string;
  projectId: string;
  sourcePath: string | null;
  workspaceRoot: string;
  baselineCommit: string | null;
  scope: ApprovalScope;
  allowedPermissions: readonly string[];
}

export interface ChangedFile {
  path: string;
  status: "added" | "modified" | "deleted";
  beforeHash: string | null;
  afterHash: string | null;
}

export interface WorkspaceCreationResult extends WorkspaceRecord {
  commands: {
    setupCommands: string[];
    verificationCommands: string[];
  };
}

const GIT_SHA_PATTERN = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i;

function isPathWithin(parentPath: string, candidatePath: string): boolean {
  const relativePath = relative(parentPath, candidatePath);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

function resolveWorkspaceRoot(path: string): string {
  if (!path || !isAbsolute(path)) {
    throw new Error("Workspace root must be an absolute path");
  }
  const absolutePath = resolve(path);
  const missingSegments: string[] = [];
  let existingAncestor = absolutePath;
  while (!existsSync(existingAncestor)) {
    const parent = dirname(existingAncestor);
    if (parent === existingAncestor) throw new Error("Workspace root cannot be resolved");
    missingSegments.unshift(basename(existingAncestor));
    existingAncestor = parent;
  }
  return resolve(realpathSync(existingAncestor), ...missingSegments);
}

function gitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function runGit(repositoryPath: string, args: string[], encoding: "utf8" | "buffer" = "utf8") {
  return execFileSync(
    "git",
    ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", ...args],
    {
      cwd: repositoryPath,
      encoding,
      env: gitEnvironment(),
      timeout: 10_000,
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
}

function validateGitBaseline(sourcePath: string, expectedBaseline: string): string[] {
  if (!GIT_SHA_PATTERN.test(expectedBaseline)) {
    throw new Error("Baseline must be a full Git commit hash");
  }
  const gitDirectory = join(sourcePath, ".git");
  if (!lstatSync(gitDirectory).isDirectory()) {
    throw new Error("Git worktrees and repositories without a local .git directory are not supported yet");
  }
  const alternates = join(gitDirectory, "objects", "info", "alternates");
  if (existsSync(alternates) && readFileSync(alternates, "utf8").trim().length > 0) {
    throw new Error("Repositories with external object alternates are not supported");
  }
  if (existsSync(join(gitDirectory, "commondir"))) {
    throw new Error("Linked Git worktrees are not supported");
  }

  const head = (runGit(sourcePath, ["rev-parse", "--verify", "HEAD^{commit}"]) as string).trim();
  assertBaselineMatches(expectedBaseline, head);
  const status = runGit(sourcePath, ["status", "--porcelain=v1", "--untracked-files=all"]) as string;
  if (status.length > 0) {
    throw new Error("Source repository must be clean before creating a run workspace");
  }

  const trackedFiles = runGit(sourcePath, ["ls-files", "-z"], "buffer") as Buffer;
  return trackedFiles
    .toString("utf8")
    .split("\0")
    .filter((path) => path.length > 0);
}

export function assertBaselineMatches(
  expectedBaseline: string | null,
  actualBaseline: string | null,
): void {
  if (expectedBaseline !== actualBaseline) {
    throw new Error("Repository baseline changed; request a new approval before using this workspace");
  }
}

function copyTrackedFileTree(
  sourceRoot: string,
  destinationRoot: string,
  trackedFiles: readonly string[],
): void {
  mkdirSync(destinationRoot, { recursive: true, mode: 0o700 });
  for (const file of trackedFiles) {
    const parts = file.split(/[\\/]/);
    if (isAbsolute(file) || parts.some((part) => part === ".." || part.length === 0)) {
      throw new Error("Repository contains an unsafe tracked path");
    }
    const source = resolve(sourceRoot, file);
    const destination = resolve(destinationRoot, file);
    if (!isPathWithin(sourceRoot, source) || !isPathWithin(destinationRoot, destination)) {
      throw new Error("Tracked path escapes the repository workspace");
    }

    const stat = lstatSync(source);
    mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
    if (stat.isSymbolicLink()) {
      symlinkSync(readlinkSync(source), destination);
    } else if (stat.isFile()) {
      copyFileSync(source, destination);
      chmodSync(destination, stat.mode & 0o777);
    } else {
      throw new Error("Git submodules and special files are not supported for workspace import yet");
    }
  }
}

function enumerateFiles(root: string, current = root): Map<string, string> {
  const files = new Map<string, string>();
  for (const name of readdirSync(current)) {
    if (current === root && name === ".git") continue;
    const absolute = join(current, name);
    const relativePath = relative(root, absolute).split(sep).join("/");
    const stat = lstatSync(absolute);
    if (stat.isDirectory()) {
      for (const [path, hash] of enumerateFiles(root, absolute)) files.set(path, hash);
    } else if (stat.isSymbolicLink()) {
      files.set(relativePath, createHash("sha256").update(`symlink:${readlinkSync(absolute)}`).digest("hex"));
    } else if (stat.isFile()) {
      files.set(relativePath, hashFile(absolute));
    } else {
      throw new Error("Workspace contains an unsupported special file");
    }
  }
  return files;
}

function hashFile(path: string): string {
  const file = readFileSync(path);
  return createHash("sha256").update(file).digest("hex");
}

function changedFilesBetween(baselinePath: string, workspacePath: string): ChangedFile[] {
  const baselineFiles = enumerateFiles(baselinePath);
  const workspaceFiles = enumerateFiles(workspacePath);
  const paths = [...new Set([...baselineFiles.keys(), ...workspaceFiles.keys()])].sort();
  const changes: ChangedFile[] = [];
  for (const path of paths) {
    const beforeHash = baselineFiles.get(path) ?? null;
    const afterHash = workspaceFiles.get(path) ?? null;
    if (beforeHash === afterHash) continue;
    changes.push({
      path,
      status: beforeHash === null ? "added" : afterHash === null ? "deleted" : "modified",
      beforeHash,
      afterHash,
    });
  }
  return changes;
}

export async function createRunWorkspace(
  database: Database,
  options: WorkspaceOptions,
): Promise<WorkspaceCreationResult> {
  const repositories = createRepositories(database);
  const run = (await repositories.runs.getById(options.runId));
  const project = (await repositories.projects.getById(options.projectId));
  if (!run || !project || run.projectId !== project.id) {
    throw new Error("Run and project must exist and belong together");
  }
  if (run.state !== "queued" && run.state !== "running") {
    throw new Error("A run must be approved and queued before workspace creation");
  }
  assertBaselineMatches(run.baselineCommit, options.baselineCommit);
  assertBaselineMatches(project.baselineCommit, options.baselineCommit);

  const approvals = createApprovalService(database, {
    allowedPermissions: options.allowedPermissions,
  });
  if (!(await approvals.isExecutionApproved(run.id, options.scope))) {
    throw new Error("Workspace creation requires an approval for this plan and baseline");
  }

  let workspaceRoot = resolveWorkspaceRoot(options.workspaceRoot);
  let sourceRoot: string | null = null;
  let trackedFiles: string[] = [];
  if (options.sourcePath !== null) {
    sourceRoot = realpathSync(options.sourcePath);
    if (
      isPathWithin(sourceRoot, workspaceRoot) ||
      isPathWithin(workspaceRoot, sourceRoot)
    ) {
      throw new Error("Workspace root and source repository must be separate directories");
    }
    if (!options.baselineCommit) {
      throw new Error("Git repositories require an explicit baseline commit");
    }
    trackedFiles = validateGitBaseline(sourceRoot, options.baselineCommit);
  } else if (options.baselineCommit !== null) {
    throw new Error("Empty projects must use a null baseline");
  }

  mkdirSync(workspaceRoot, { recursive: true, mode: 0o700 });
  workspaceRoot = realpathSync(workspaceRoot);
  if (
    sourceRoot &&
    (isPathWithin(sourceRoot, workspaceRoot) || isPathWithin(workspaceRoot, sourceRoot))
  ) {
    throw new Error("Workspace root and source repository must be separate directories");
  }
  const workspaceId = randomUUID();
  const runDirectory = join(workspaceRoot, "runs", workspaceId);
  const baselinePath = join(runDirectory, "baseline");
  const workspacePath = join(runDirectory, "working");
  mkdirSync(runDirectory, { recursive: true, mode: 0o700 });

  try {
    if (sourceRoot !== null) {
      copyTrackedFileTree(sourceRoot, baselinePath, trackedFiles);
      copyTrackedFileTree(baselinePath, workspacePath, trackedFiles);
      cpSync(join(sourceRoot, ".git"), join(workspacePath, ".git"), {
        recursive: true,
        dereference: false,
        verbatimSymlinks: true,
      });
    } else {
      mkdirSync(baselinePath, { recursive: true, mode: 0o700 });
      mkdirSync(workspacePath, { recursive: true, mode: 0o700 });
      execFileSync("git", ["init", "--quiet", "--initial-branch=main", "--template="], {
        cwd: workspacePath,
        env: gitEnvironment(),
        timeout: 10_000,
        stdio: ["ignore", "pipe", "pipe"],
      });
    }

    const record = (await withTransaction(database, async () => {
      const currentRun = (await repositories.runs.getById(options.runId));
      if (
        !currentRun ||
        (currentRun.state !== "queued" && currentRun.state !== "running")
      ) {
        throw new Error("Run state changed before workspace creation");
      }
      assertBaselineMatches(currentRun.baselineCommit, options.baselineCommit);
      return (await repositories.workspaces.create({
        id: workspaceId,
        runId: options.runId,
        projectId: options.projectId,
        sourcePath: sourceRoot,
        workspacePath,
        baselinePath,
        baselineCommit: options.baselineCommit,
        setupCommands: options.scope.setupCommands,
        verificationCommands: options.scope.verificationCommands,
      }));
    }));

    return {
      ...record,
      commands: {
        setupCommands: [...options.scope.setupCommands],
        verificationCommands: [...options.scope.verificationCommands],
      },
    };
  } catch (error) {
    rmSync(runDirectory, { recursive: true, force: true });
    throw error;
  }
}

export async function createCheckpoint(
  database: Database,
  input: { runId: string; taskId?: string | null },
) {
  const repositories = createRepositories(database);
  const workspace = (await repositories.workspaces.getByRunId(input.runId));
  if (!workspace || workspace.state !== "ready") {
    throw new Error("Run does not have an active workspace");
  }
  if (input.taskId) {
    const task = (await repositories.tasks.getById(input.taskId));
    if (!task || task.runId !== input.runId) {
      throw new Error("Checkpoint task must belong to the run");
    }
  }

  const changedFiles = changedFilesBetween(workspace.baselinePath, workspace.workspacePath);
  const snapshotPath = join(dirname(workspace.workspacePath), "checkpoints", `${randomUUID()}.json`);
  mkdirSync(dirname(snapshotPath), { recursive: true, mode: 0o700 });
  const snapshot = {
    runId: input.runId,
    taskId: input.taskId ?? null,
    baselineCommit: workspace.baselineCommit,
    changedFiles,
    files: Object.fromEntries(enumerateFiles(workspace.workspacePath)),
  };
  writeFileSync(snapshotPath, JSON.stringify(snapshot, null, 2), {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });

  try {
    const checkpoint = (await repositories.checkpoints.create({
      id: randomUUID(),
      runId: input.runId,
      taskId: input.taskId ?? null,
      baselineCommit: workspace.baselineCommit,
      snapshotPath,
      changedFilesJson: JSON.stringify(changedFiles),
    }));
    return { ...checkpoint, changedFiles, snapshotPath };
  } catch (error) {
    rmSync(snapshotPath, { force: true });
    throw error;
  }
}
