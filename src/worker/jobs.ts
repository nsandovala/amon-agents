import { execFile as execFileCallback } from "child_process";
import { existsSync as defaultExistsSync } from "fs";
import { mkdir, realpath, writeFile } from "fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { resolveWorkspaceRoot } from "./host";
import { InspectRepoEvidence, WorkerJob, WorkerJobState, WorkerJobStatus } from "./types";

const GIT_TIMEOUT_MS = 3000;
const ALLOWED_ACTIONS = new Set(["inspect_repo"]);

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
  persist?: (state: WorkerJobState, path: string) => Promise<void>;
  now?: () => Date;
}

export class WorkerJobError extends Error {
  constructor(message: string, public readonly state?: WorkerJobState) {
    super(message);
    this.name = "WorkerJobError";
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

export function getWorkerJobPath(jobId: string, cwd = process.cwd()): string {
  validateJobId(jobId);
  return join(cwd, "outputs", "worker", "jobs", `${jobId}.json`);
}

export function createWorkerJob(input: { jobId?: unknown; action?: unknown; repo?: unknown }, now: () => Date = () => new Date()): WorkerJob {
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

  return {
    jobId,
    action: input.action.trim() as WorkerJob["action"],
    repo: input.repo.trim(),
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

    state.evidence = await inspectRepo(job, {
      cwd,
      env: deps.env ?? process.env,
      existsSync,
      realpath: deps.realpath ?? realpath,
      execFile: deps.execFile ?? defaultExecFile,
      now,
    });
    state.exitCode = 0;
    state.finishedAt = iso(now);
    state.durationMs = Math.max(0, now().getTime() - startedMs);
    transition(state, "done", state.finishedAt);
    await persist(state, jobPath);
    return state;
  } catch (err) {
    state.exitCode = 1;
    state.error = (err as Error).message || "Worker job failed";
    state.finishedAt = iso(now);
    state.durationMs = Math.max(0, now().getTime() - startedMs);
    transition(state, "failed", state.finishedAt);
    await persist(state, jobPath);
    return state;
  }
}

export function formatWorkerJobSummary(state: WorkerJobState): string {
  const evidence = state.evidence;
  const lines = [
    "",
    "  AMON Worker Job",
    "  ────────────────────────",
    `  ${"Job:".padEnd(10)}${state.jobId}`,
    `  ${"Action:".padEnd(10)}${state.action}`,
    `  ${"Status:".padEnd(10)}${state.status}`,
    `  ${"Repo:".padEnd(10)}${evidence?.repoPath ?? state.repo}`,
    `  ${"Branch:".padEnd(10)}${evidence?.branch ?? "n/a"}`,
    `  ${"HEAD:".padEnd(10)}${evidence?.headSha ?? "n/a"}`,
    `  ${"Dirty:".padEnd(10)}${evidence ? (evidence.dirty ? "yes" : "no") : "n/a"}`,
    `  ${"Duration:".padEnd(10)}${state.durationMs ?? 0}ms`,
    `  ${"ExitCode:".padEnd(10)}${state.exitCode ?? "n/a"}`,
  ];

  if (state.error) {
    lines.push(`  ${"Error:".padEnd(10)}${state.error}`);
  }

  lines.push("  ────────────────────────", "");
  return `${lines.join("\n")}\n`;
}
