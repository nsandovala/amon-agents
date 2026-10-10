import { execFile as execFileCallback } from "child_process";
import { existsSync as defaultExistsSync } from "fs";
import { mkdir, realpath, writeFile } from "fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "path";
import { resolveWorkspaceRoot } from "./host";
import {
  InspectRepoEvidence,
  PrepareWorktreeEvidence,
  WorkerJob,
  WorkerJobAction,
  WorkerJobEvidence,
  WorkerJobState,
  WorkerJobStatus,
} from "./types";

const GIT_TIMEOUT_MS = 3000;
const ALLOWED_ACTIONS = new Set<WorkerJobAction>(["inspect_repo", "prepare_worktree"]);

export interface JobExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type JobExecFileFn = (
  command: string,
  args: string[],
  options: { timeout: number }
) => Promise<JobExecResult>;

export interface WorkerJobDeps {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  existsSync?: (path: string) => boolean;
  realpath?: (path: string) => Promise<string>;
  execFile?: JobExecFileFn;
  mkdir?: (path: string, options: { recursive: true }) => Promise<unknown>;
  persist?: (state: WorkerJobState, path: string) => Promise<void>;
  now?: () => Date;
}

export class WorkerJobError extends Error {
  constructor(message: string, public readonly state?: WorkerJobState) {
    super(message);
    this.name = "WorkerJobError";
  }
}

class WorkerJobExecutionError extends Error {
  constructor(message: string, public readonly evidence?: WorkerJobEvidence) {
    super(message);
    this.name = "WorkerJobExecutionError";
  }
}

function defaultExecFile(command: string, args: string[], options: { timeout: number }): Promise<JobExecResult> {
  return new Promise((resolvePromise) => {
    execFileCallback(
      command,
      args,
      { encoding: "utf8", timeout: options.timeout, windowsHide: true },
      (err, stdout, stderr) => {
        const errorWithCode = err as NodeJS.ErrnoException & { code?: number | string } | null;
        const exitCode = errorWithCode
          ? typeof errorWithCode.code === "number"
            ? errorWithCode.code
            : 1
          : 0;
        resolvePromise({ stdout: stdout ?? "", stderr: stderr ?? "", exitCode });
      }
    );
  });
}

async function defaultPersist(state: WorkerJobState, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function iso(now: () => Date): string {
  return now().toISOString();
}

function trimOutput(value: string): string {
  return value.trim();
}

function transition(state: WorkerJobState, status: WorkerJobStatus, at: string): void {
  state.status = status;
  state.transitions.push({ status, at });
}

function validateJobId(jobId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(jobId)) {
    throw new WorkerJobError("Invalid jobId: expected 1-128 safe filename characters");
  }
}

function validateBranchName(branch: string): void {
  if (branch.trim().length === 0) {
    throw new WorkerJobError("Missing required branch for prepare_worktree");
  }
  if (branch === "HEAD" || branch.startsWith("refs/") || branch.includes("..")) {
    throw new WorkerJobError(`Invalid worker branch: ${branch}`);
  }
  if (["main", "master", "develop"].includes(branch)) {
    throw new WorkerJobError(`Protected branch rejected: ${branch}`);
  }
  if (branch.startsWith("release/") || branch.startsWith("prod/") || branch.startsWith("production/")) {
    throw new WorkerJobError(`Protected branch rejected: ${branch}`);
  }
  if (!/^worker\/[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(branch)) {
    throw new WorkerJobError(`Branch must match worker/<safe-id>: ${branch}`);
  }
}

export function getWorkerJobPath(jobId: string, cwd = process.cwd()): string {
  validateJobId(jobId);
  return join(cwd, "outputs", "worker", "jobs", `${jobId}.json`);
}

export function createWorkerJob(input: { jobId?: unknown; action?: unknown; repo?: unknown; branch?: unknown }, now: () => Date = () => new Date()): WorkerJob {
  if (typeof input.jobId !== "string" || input.jobId.trim().length === 0) {
    throw new WorkerJobError("Missing required jobId");
  }
  if (typeof input.action !== "string" || input.action.trim().length === 0) {
    throw new WorkerJobError("Missing required action");
  }
  if (typeof input.repo !== "string" || input.repo.trim().length === 0) {
    throw new WorkerJobError("Missing required repo");
  }

  const jobId = input.jobId.trim();
  validateJobId(jobId);
  const action = input.action.trim() as WorkerJob["action"];
  const branch = typeof input.branch === "string" ? input.branch.trim() : undefined;

  if (action === "prepare_worktree") {
    if (!branch) {
      throw new WorkerJobError("Missing required branch for prepare_worktree");
    }
    validateBranchName(branch);
  }

  return {
    jobId,
    action,
    repo: input.repo.trim(),
    ...(branch ? { branch } : {}),
    createdAt: iso(now),
  };
}

function isInsideWorkspace(repoRealPath: string, workspaceRealPath: string): boolean {
  const rel = relative(workspaceRealPath, repoRealPath);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function resolveRepoInWorkspace(job: WorkerJob, deps: Required<Pick<WorkerJobDeps, "cwd" | "env" | "existsSync" | "realpath">>): Promise<string> {
  const workspace = resolveWorkspaceRoot({ env: deps.env, cwd: deps.cwd, existsSync: deps.existsSync });
  if (!workspace.root || !workspace.available) {
    throw new Error("Workspace unavailable");
  }

  const repoPath = resolve(deps.cwd, job.repo);
  if (!deps.existsSync(repoPath)) {
    throw new Error(`Repo does not exist: ${repoPath}`);
  }

  const [repoRealPath, workspaceRealPath] = await Promise.all([
    deps.realpath(repoPath),
    deps.realpath(workspace.root),
  ]);

  if (!isInsideWorkspace(repoRealPath, workspaceRealPath)) {
    throw new Error(`Repo is outside workspace: ${repoRealPath}`);
  }

  return repoRealPath;
}

async function git(execFile: JobExecFileFn, repo: string, args: string[]): Promise<JobExecResult> {
  return execFile("git", ["-C", repo, ...args], { timeout: GIT_TIMEOUT_MS });
}

async function gitGlobal(execFile: JobExecFileFn, args: string[]): Promise<JobExecResult> {
  return execFile("git", args, { timeout: GIT_TIMEOUT_MS });
}

async function inspectRepo(job: WorkerJob, deps: Required<Pick<WorkerJobDeps, "cwd" | "env" | "existsSync" | "realpath" | "execFile" | "now">>): Promise<InspectRepoEvidence> {
  const repoPath = await resolveRepoInWorkspace(job, deps);
  const timestamp = iso(deps.now);
  const inside = await git(deps.execFile, repoPath, ["rev-parse", "--is-inside-work-tree"]);
  const isGitRepo = inside.exitCode === 0 && trimOutput(inside.stdout) === "true";
  if (!isGitRepo) {
    throw new Error(`Repo is not a git work tree: ${repoPath}`);
  }

  const [branch, head, statusShort, statusBranch] = await Promise.all([
    git(deps.execFile, repoPath, ["branch", "--show-current"]),
    git(deps.execFile, repoPath, ["rev-parse", "HEAD"]),
    git(deps.execFile, repoPath, ["status", "--short"]),
    git(deps.execFile, repoPath, ["status", "--branch", "--short"]),
  ]);

  for (const result of [branch, head, statusShort, statusBranch]) {
    if (result.exitCode !== 0) {
      throw new Error(trimOutput(result.stderr) || "Git read-only command failed");
    }
  }

  return {
    repoPath,
    repoExists: true,
    isGitRepo: true,
    branch: trimOutput(branch.stdout) || null,
    headSha: trimOutput(head.stdout) || null,
    gitStatusShort: trimOutput(statusShort.stdout),
    gitStatusBranch: trimOutput(statusBranch.stdout),
    dirty: trimOutput(statusShort.stdout).length > 0,
    timestamp,
  };
}

function sanitizeSegment(value: string): string {
  const sanitized = value
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return sanitized || "repo";
}

function getWorktreeRoot(options: { env: NodeJS.ProcessEnv; cwd: string; workspaceRoot: string }): string {
  const explicit = options.env.AMON_WORKTREE_ROOT?.trim();
  if (explicit) {
    return resolve(options.cwd, explicit);
  }
  return join(options.workspaceRoot, ".amon", "worktrees");
}

function assertPathInside(path: string, root: string, message: string): void {
  if (!isInsideWorkspace(path, root)) {
    throw new Error(message);
  }
}

async function resolveWorkspace(deps: Required<Pick<WorkerJobDeps, "cwd" | "env" | "existsSync" | "realpath">>): Promise<string> {
  const workspace = resolveWorkspaceRoot({ env: deps.env, cwd: deps.cwd, existsSync: deps.existsSync });
  if (!workspace.root || !workspace.available) {
    throw new Error("Workspace unavailable");
  }
  return deps.realpath(workspace.root);
}

async function buildWorktreePath(options: {
  job: WorkerJob;
  repoPath: string;
  workspaceRoot: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  existsSync: (path: string) => boolean;
  realpath: (path: string) => Promise<string>;
}): Promise<{ root: string; path: string }> {
  const root = getWorktreeRoot({ env: options.env, cwd: options.cwd, workspaceRoot: options.workspaceRoot });
  const rootForBoundary = options.existsSync(root) ? await options.realpath(root) : root;
  const repoName = sanitizeSegment(basename(options.repoPath));
  const worktreePath = resolve(rootForBoundary, repoName, options.job.jobId);
  assertPathInside(worktreePath, rootForBoundary, `Worktree destination escapes root: ${worktreePath}`);
  return { root: rootForBoundary, path: worktreePath };
}

function parseWorktreeBranches(output: string): Set<string> {
  const branches = new Set<string>();
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("branch refs/heads/")) {
      branches.add(trimmed.slice("branch refs/heads/".length));
    }
  }
  return branches;
}

function assertGitSuccess(result: JobExecResult, message: string): void {
  if (result.exitCode !== 0) {
    throw new Error(trimOutput(result.stderr) || message);
  }
}

async function executeJob(
  job: WorkerJob,
  deps: Required<Pick<WorkerJobDeps, "cwd" | "env" | "existsSync" | "realpath" | "execFile" | "mkdir" | "now">>
): Promise<WorkerJobEvidence> {
  if (job.action === "inspect_repo") {
    return inspectRepo(job, deps);
  }
  if (job.action === "prepare_worktree") {
    return prepareWorktree(job, deps);
  }
  throw new Error(`Unsupported worker job action: ${job.action}`);
}

async function prepareWorktree(job: WorkerJob, deps: Required<Pick<WorkerJobDeps, "cwd" | "env" | "existsSync" | "realpath" | "execFile" | "mkdir" | "now">>): Promise<PrepareWorktreeEvidence> {
  if (!job.branch) {
    throw new Error("Missing required branch for prepare_worktree");
  }
  validateBranchName(job.branch);

  const repoPath = await resolveRepoInWorkspace(job, deps);
  const workspaceRoot = await resolveWorkspace(deps);
  const timestamp = iso(deps.now);
  const inside = await git(deps.execFile, repoPath, ["rev-parse", "--is-inside-work-tree"]);
  const isGitRepo = inside.exitCode === 0 && trimOutput(inside.stdout) === "true";
  if (!isGitRepo) {
    throw new Error(`Repo is not a git work tree: ${repoPath}`);
  }

  const refCheck = await gitGlobal(deps.execFile, ["check-ref-format", "--branch", job.branch]);
  assertGitSuccess(refCheck, `Invalid git branch ref: ${job.branch}`);

  const { path: worktreePath } = await buildWorktreePath({
    job,
    repoPath,
    workspaceRoot,
    cwd: deps.cwd,
    env: deps.env,
    existsSync: deps.existsSync,
    realpath: deps.realpath,
  });

  const evidence: PrepareWorktreeEvidence = {
    repoPath,
    sourceBranch: null,
    sourceHeadSha: null,
    worktreePath,
    worktreeBranch: null,
    worktreeHeadSha: null,
    worktreeStatusShort: null,
    created: false,
    timestamp,
  };

  if (deps.existsSync(worktreePath)) {
    throw new WorkerJobExecutionError(`Worktree destination already exists: ${worktreePath}`, evidence);
  }

  const branchExists = await git(deps.execFile, repoPath, ["show-ref", "--verify", `refs/heads/${job.branch}`]);
  if (branchExists.exitCode === 0) {
    throw new WorkerJobExecutionError(`Branch already exists: ${job.branch}`, evidence);
  }

  const worktrees = await git(deps.execFile, repoPath, ["worktree", "list", "--porcelain"]);
  assertGitSuccess(worktrees, "Unable to list git worktrees");
  if (parseWorktreeBranches(worktrees.stdout).has(job.branch)) {
    throw new WorkerJobExecutionError(`Branch already checked out in another worktree: ${job.branch}`, evidence);
  }

  const [sourceBranch, sourceHead] = await Promise.all([
    git(deps.execFile, repoPath, ["branch", "--show-current"]),
    git(deps.execFile, repoPath, ["rev-parse", "HEAD"]),
  ]);
  assertGitSuccess(sourceBranch, "Unable to read source branch");
  assertGitSuccess(sourceHead, "Unable to read source HEAD");
  evidence.sourceBranch = trimOutput(sourceBranch.stdout) || null;
  evidence.sourceHeadSha = trimOutput(sourceHead.stdout) || null;

  if (!evidence.sourceHeadSha) {
    throw new WorkerJobExecutionError("Source HEAD is empty", evidence);
  }

  await deps.mkdir(dirname(worktreePath), { recursive: true });

  const add = await git(deps.execFile, repoPath, ["worktree", "add", "-b", job.branch, worktreePath, evidence.sourceHeadSha]);
  if (add.exitCode !== 0) {
    throw new WorkerJobExecutionError(trimOutput(add.stderr) || "git worktree add failed", evidence);
  }
  evidence.created = true;

  const [insideWorktree, worktreeBranch, worktreeHead, worktreeStatus] = await Promise.all([
    git(deps.execFile, worktreePath, ["rev-parse", "--is-inside-work-tree"]),
    git(deps.execFile, worktreePath, ["branch", "--show-current"]),
    git(deps.execFile, worktreePath, ["rev-parse", "HEAD"]),
    git(deps.execFile, worktreePath, ["status", "--short"]),
  ]);

  for (const result of [insideWorktree, worktreeBranch, worktreeHead, worktreeStatus]) {
    if (result.exitCode !== 0) {
      throw new WorkerJobExecutionError(trimOutput(result.stderr) || "Worktree verification failed", evidence);
    }
  }

  if (trimOutput(insideWorktree.stdout) !== "true") {
    throw new WorkerJobExecutionError("Created path is not a git work tree", evidence);
  }

  evidence.worktreeBranch = trimOutput(worktreeBranch.stdout) || null;
  evidence.worktreeHeadSha = trimOutput(worktreeHead.stdout) || null;
  evidence.worktreeStatusShort = trimOutput(worktreeStatus.stdout);

  if (evidence.worktreeBranch !== job.branch) {
    throw new WorkerJobExecutionError(`Worktree branch mismatch: ${evidence.worktreeBranch ?? "(none)"}`, evidence);
  }
  if (evidence.worktreeHeadSha !== evidence.sourceHeadSha) {
    throw new WorkerJobExecutionError("Worktree HEAD does not match source HEAD", evidence);
  }
  if (evidence.worktreeStatusShort.length > 0) {
    throw new WorkerJobExecutionError("Worktree status is not clean", evidence);
  }

  return evidence;
}

export async function runWorkerJob(job: WorkerJob, deps: WorkerJobDeps = {}): Promise<WorkerJobState> {
  const cwd = deps.cwd ?? process.cwd();
  const now = deps.now ?? (() => new Date());
  const existsSync = deps.existsSync ?? defaultExistsSync;
  const jobPath = getWorkerJobPath(job.jobId, cwd);

  if (existsSync(jobPath)) {
    throw new WorkerJobError(`Job evidence already exists: ${jobPath}`);
  }

  const queuedAt = iso(now);
  const state: WorkerJobState = {
    jobId: job.jobId,
    action: job.action,
    repo: job.repo,
    ...(job.branch ? { branch: job.branch } : {}),
    status: "queued",
    createdAt: job.createdAt,
    queuedAt,
    transitions: [{ status: "queued", at: queuedAt }],
  };

  const persist = deps.persist ?? defaultPersist;
  const startedMs = now().getTime();
  await persist(state, jobPath);

  const startedAt = iso(now);
  state.startedAt = startedAt;
  transition(state, "running", startedAt);
  await persist(state, jobPath);

  try {
    if (!ALLOWED_ACTIONS.has(job.action)) {
      throw new Error(`Unsupported worker job action: ${job.action}`);
    }

    state.evidence = await executeJob(job, {
      cwd,
      env: deps.env ?? process.env,
      existsSync,
      realpath: deps.realpath ?? realpath,
      execFile: deps.execFile ?? defaultExecFile,
      mkdir: deps.mkdir ?? mkdir,
      now,
    });
    state.exitCode = 0;
    state.finishedAt = iso(now);
    state.durationMs = Math.max(0, now().getTime() - startedMs);
    transition(state, "done", state.finishedAt);
    await persist(state, jobPath);
    return state;
  } catch (err) {
    if (err instanceof WorkerJobExecutionError && err.evidence) {
      state.evidence = err.evidence;
    }
    state.exitCode = 1;
    state.error = (err as Error).message || "Worker job failed";
    state.finishedAt = iso(now);
    state.durationMs = Math.max(0, now().getTime() - startedMs);
    transition(state, "failed", state.finishedAt);
    await persist(state, jobPath);
    return state;
  }
}

function isInspectRepoEvidence(evidence: WorkerJobEvidence | undefined): evidence is InspectRepoEvidence {
  return Boolean(evidence && "isGitRepo" in evidence);
}

function isPrepareWorktreeEvidence(evidence: WorkerJobEvidence | undefined): evidence is PrepareWorktreeEvidence {
  return Boolean(evidence && "worktreePath" in evidence);
}

export function formatWorkerJobSummary(state: WorkerJobState): string {
  const evidence = state.evidence;
  const inspectEvidence = isInspectRepoEvidence(evidence) ? evidence : undefined;
  const worktreeEvidence = isPrepareWorktreeEvidence(evidence) ? evidence : undefined;
  const lines = [
    "",
    "  AMON Worker Job",
    "  ────────────────────────",
    `  ${"Job:".padEnd(10)}${state.jobId}`,
    `  ${"Action:".padEnd(10)}${state.action}`,
    `  ${"Status:".padEnd(10)}${state.status}`,
    `  ${"Repo:".padEnd(10)}${evidence?.repoPath ?? state.repo}`,
    `  ${"Branch:".padEnd(10)}${inspectEvidence?.branch ?? worktreeEvidence?.worktreeBranch ?? state.branch ?? "n/a"}`,
    `  ${"HEAD:".padEnd(10)}${inspectEvidence?.headSha ?? worktreeEvidence?.worktreeHeadSha ?? "n/a"}`,
    `  ${"Dirty:".padEnd(10)}${inspectEvidence ? (inspectEvidence.dirty ? "yes" : "no") : worktreeEvidence ? "no" : "n/a"}`,
    `  ${"Duration:".padEnd(10)}${state.durationMs ?? 0}ms`,
    `  ${"ExitCode:".padEnd(10)}${state.exitCode ?? "n/a"}`,
  ];

  if (worktreeEvidence) {
    lines.splice(8, 0, `  ${"Worktree:".padEnd(10)}${worktreeEvidence.worktreePath}`);
  }

  if (state.error) {
    lines.push(`  ${"Error:".padEnd(10)}${state.error}`);
  }

  lines.push("  ────────────────────────", "");
  return `${lines.join("\n")}\n`;
}
