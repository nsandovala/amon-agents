import { readdir, readFile } from "fs/promises";
import { join } from "path";
import { GuardianReview, GuardianVerdict } from "../guardian/types";
import { CodingToolEvidence, WorkerJobState, WorkerStatus } from "../worker/types";
import { AgentProjection, GuardianProjection, JobProjection, OperationalSnapshot, WorkerProjection } from "./types";

export interface OperationalProjectionDeps {
  cwd?: string;
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  readdir?: (path: string) => Promise<string[]>;
  now?: () => Date;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCodingToolEvidence(value: unknown): value is CodingToolEvidence {
  return isRecord(value) && "tool" in value && "changedFiles" in value;
}

async function readJson<T>(path: string, read: (path: string, encoding: BufferEncoding) => Promise<string>): Promise<T | null> {
  try {
    return JSON.parse(await read(path, "utf8")) as T;
  } catch {
    return null;
  }
}

async function readJsonFiles<T>(dir: string, deps: Required<Pick<OperationalProjectionDeps, "readFile" | "readdir">>): Promise<{ items: T[]; malformed: number }> {
  let names: string[];
  try {
    names = await deps.readdir(dir);
  } catch {
    return { items: [], malformed: 0 };
  }

  const items: T[] = [];
  let malformed = 0;
  for (const name of names.filter((item) => item.endsWith(".json")).sort()) {
    const item = await readJson<T>(join(dir, name), deps.readFile);
    if (item) {
      items.push(item);
    } else {
      malformed += 1;
    }
  }
  return { items, malformed };
}

function projectWorker(status: WorkerStatus): WorkerProjection {
  return {
    workerId: status.workerId,
    status: status.status,
    platform: status.platform,
    arch: status.arch,
    workspace: status.workspace,
    lastHeartbeat: status.lastHeartbeatAt,
    tools: status.tools.map((tool) => ({
      name: tool.name,
      available: tool.available,
      ...(tool.version ? { version: tool.version } : {}),
    })),
  };
}

function projectReview(review: GuardianReview): GuardianProjection {
  return {
    reviewId: review.reviewId,
    workerJobId: review.workerJobId,
    verdict: review.verdict,
    policyVersion: review.policyVersion,
    reviewedAt: review.reviewedAt,
    findingsCount: review.findings.length,
  };
}

function latestVerdictFor(jobId: string, reviews: GuardianProjection[]): GuardianVerdict | undefined {
  return reviews
    .filter((review) => review.workerJobId === jobId)
    .sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt))
    .at(-1)?.verdict;
}

function projectJob(job: WorkerJobState, reviews: GuardianProjection[]): JobProjection {
  const evidence = isCodingToolEvidence(job.evidence) ? job.evidence : undefined;
  const guardianVerdict = latestVerdictFor(job.jobId, reviews);
  const requiresHumanReview = Boolean(evidence?.humanReview) || guardianVerdict === "HUMAN_REVIEW";
  return {
    jobId: job.jobId,
    action: job.action,
    status: job.status,
    repo: job.repo,
    ...(job.worktreePath ? { worktreePath: job.worktreePath } : {}),
    ...(job.tool ? { tool: job.tool } : {}),
    ...(job.startedAt ? { startedAt: job.startedAt } : {}),
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    ...(typeof job.durationMs === "number" ? { durationMs: job.durationMs } : {}),
    ...(guardianVerdict ? { guardianVerdict } : {}),
    requiresHumanReview,
  };
}

function projectAgents(jobs: JobProjection[], reviews: GuardianProjection[]): AgentProjection[] {
  const hasBlocked = reviews.some((review) => review.verdict === "BLOCKED");
  const hasHumanReview = reviews.some((review) => review.verdict === "HUMAN_REVIEW");
  const hasRunningCodingTool = jobs.some((job) => job.action === "run_coding_tool" && job.status === "running");
  const claudioState = hasBlocked ? "blocked" : hasHumanReview ? "waiting_human" : hasRunningCodingTool ? "working" : "available";

  return [
    { agentId: "jarvis", role: "orchestrator", state: "available" },
    { agentId: "claudio", role: "owner", state: claudioState },
    { agentId: "guardian", role: "security_qa_gate", state: "available" },
  ];
}

export async function buildOperationalSnapshot(deps: OperationalProjectionDeps = {}): Promise<OperationalSnapshot> {
  const cwd = deps.cwd ?? process.cwd();
  const read = deps.readFile ?? readFile;
  const list = deps.readdir ?? readdir;
  const now = deps.now ?? (() => new Date());
  const requiredDeps = { readFile: read, readdir: list };
  let malformed = 0;

  const workerStatus = await readJson<WorkerStatus>(join(cwd, "outputs", "worker", "worker-status.json"), read);
  const jobsResult = await readJsonFiles<WorkerJobState>(join(cwd, "outputs", "worker", "jobs"), requiredDeps);
  const reviewsResult = await readJsonFiles<GuardianReview>(join(cwd, "outputs", "guardian", "reviews"), requiredDeps);
  malformed += jobsResult.malformed + reviewsResult.malformed;

  const guardianReviews = reviewsResult.items.map(projectReview);
  const jobs = jobsResult.items.map((job) => projectJob(job, guardianReviews));

  return {
    generatedAt: now().toISOString(),
    systemStatus: malformed > 0 ? "degraded" : "ok",
    workers: workerStatus ? [projectWorker(workerStatus)] : [],
    jobs,
    guardianReviews,
    agents: projectAgents(jobs, guardianReviews),
  };
}
