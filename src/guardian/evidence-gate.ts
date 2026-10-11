import { existsSync as defaultExistsSync } from "fs";
import { mkdir, readFile } from "fs/promises";
import { atomicWriteFile } from "../utils/fs-helpers";
import { dirname, isAbsolute, join, relative, resolve } from "path";
import { resolveWorkspaceRoot } from "../worker/host";
import { CodingToolEvidence, WorkerJobEvidence, WorkerJobState } from "../worker/types";
import { GuardianFinding, GuardianReview, GuardianReviewContext, GuardianReviewInput, GuardianVerdict } from "./types";

export const GUARDIAN_POLICY_VERSION = "guardian-evidence-v0.1" as const;

const SUPPORTED_CODING_TOOLS = new Set(["opencode"]);

export interface GuardianReviewDeps {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  existsSync?: (path: string) => boolean;
  readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
  writeFile?: (path: string, data: string, encoding: BufferEncoding) => Promise<void>;
  mkdir?: (path: string, options: { recursive: true }) => Promise<unknown>;
  now?: () => Date;
}

export class GuardianReviewError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GuardianReviewError";
  }
}

function validateSafeId(name: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new GuardianReviewError(`Invalid ${name}: expected 1-128 safe filename characters`);
  }
}

export function getGuardianReviewPath(reviewId: string, cwd = process.cwd()): string {
  validateSafeId("reviewId", reviewId);
  return join(cwd, "outputs", "guardian", "reviews", `${reviewId}.json`);
}

function getWorkerJobPath(workerJobId: string, cwd = process.cwd()): string {
  validateSafeId("workerJobId", workerJobId);
  return join(cwd, "outputs", "worker", "jobs", `${workerJobId}.json`);
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function getWorktreeRoot(options: { cwd: string; env: NodeJS.ProcessEnv; existsSync: (path: string) => boolean }): string {
  const explicit = options.env.AMON_WORKTREE_ROOT?.trim();
  if (explicit) {
    return resolve(options.cwd, explicit);
  }

  const workspace = resolveWorkspaceRoot({ cwd: options.cwd, env: options.env, existsSync: options.existsSync });
  if (!workspace.root || !workspace.available) {
    return resolve(options.cwd, ".amon", "worktrees");
  }
  return join(workspace.root, ".amon", "worktrees");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isCodingToolEvidence(evidence: WorkerJobEvidence | undefined): evidence is CodingToolEvidence {
  return Boolean(evidence && "tool" in evidence && "changedFiles" in evidence && "worktreePath" in evidence);
}

function finding(finding: GuardianFinding): GuardianFinding {
  return finding;
}

function unsafePathReason(path: string): string | null {
  if (path.length === 0) return "empty path";
  if (isAbsolute(path)) return "absolute path";
  const parts = path.split(/[\\/]+/).filter(Boolean);
  if (parts.includes("..")) return "path traversal";
  if (parts.includes(".git")) return ".git path";
  return null;
}

function statusMentionsChangedFiles(status: string | null, changedFiles: string[]): boolean {
  if (changedFiles.length === 0) return true;
  if (!status || status.trim().length === 0) return false;
  return changedFiles.every((file) => status.includes(file));
}

function verdictFor(findings: GuardianFinding[]): GuardianVerdict {
  if (findings.some((item) => item.severity === "error")) return "BLOCKED";
  if (findings.some((item) => item.severity === "human_review")) return "HUMAN_REVIEW";
  if (findings.some((item) => item.severity === "warn")) return "WARN";
  return "PASS";
}

function summarize(verdict: GuardianVerdict, findings: GuardianFinding[]): string {
  const blocking = findings.filter((item) => item.severity === "error").length;
  const humanReview = findings.filter((item) => item.severity === "human_review").length;
  const warnings = findings.filter((item) => item.severity === "warn").length;
  return `${verdict}: ${findings.length} findings (${blocking} blocking, ${humanReview} human_review, ${warnings} warnings)`;
}

function reviewCodingToolEvidence(context: GuardianReviewContext): GuardianFinding[] {
  const findings: GuardianFinding[] = [];
  const job = context.workerJob;
  const evidence = job.evidence;

  if (job.status === "failed") {
    findings.push(finding({ code: "JOB_NOT_DONE", severity: "error", message: "Worker job status is failed", field: "status", expected: "done", actual: job.status }));
  } else if (job.status !== "done") {
    findings.push(finding({ code: "JOB_STATUS_INCOMPLETE", severity: "human_review", message: "Worker job status is not complete", field: "status", expected: "done", actual: job.status }));
  }

  if (!isCodingToolEvidence(evidence)) {
    findings.push(finding({ code: "EVIDENCE_MISSING", severity: "human_review", message: "Coding tool evidence is missing or has the wrong shape", field: "evidence" }));
    return findings;
  }

  if (evidence.exitCode === null || evidence.exitCode === undefined) {
    findings.push(finding({ code: "TOOL_EXIT_MISSING", severity: "human_review", message: "Tool exitCode is missing", field: "evidence.exitCode" }));
  } else if (evidence.exitCode !== 0) {
    findings.push(finding({ code: "TOOL_EXIT_NONZERO", severity: "error", message: "Tool exitCode is non-zero", field: "evidence.exitCode", expected: 0, actual: evidence.exitCode }));
  }

  const worktreePath = typeof evidence.worktreePath === "string" ? resolve(evidence.worktreePath) : "";
  const worktreeRoot = resolve(context.worktreeRoot);
  if (!worktreePath || !isInside(worktreeRoot, worktreePath)) {
    findings.push(finding({ code: "WORKTREE_OUTSIDE_ROOT", severity: "error", message: "Worktree path is outside the configured worktree root", field: "evidence.worktreePath", expected: worktreeRoot, actual: evidence.worktreePath }));
  }

  if (!evidence.branch || !evidence.branch.startsWith("worker/")) {
    findings.push(finding({ code: "BRANCH_POLICY_VIOLATION", severity: "error", message: "Worktree branch must start with worker/", field: "evidence.branch", expected: "worker/*", actual: evidence.branch }));
  }
  if (!evidence.worktreeBranchAfter || !evidence.worktreeBranchAfter.startsWith("worker/")) {
    findings.push(finding({ code: "BRANCH_POLICY_VIOLATION", severity: "error", message: "Post-run branch must start with worker/", field: "evidence.worktreeBranchAfter", expected: "worker/*", actual: evidence.worktreeBranchAfter }));
  }
  if (evidence.branch && evidence.worktreeBranchAfter && evidence.branch !== evidence.worktreeBranchAfter) {
    findings.push(finding({ code: "BRANCH_CHANGED", severity: "error", message: "Worktree branch changed during execution", field: "evidence.worktreeBranchAfter", expected: evidence.branch, actual: evidence.worktreeBranchAfter }));
  }

  if (!evidence.headSha || !evidence.worktreeHeadShaAfter) {
    findings.push(finding({ code: "HEAD_MISSING", severity: "human_review", message: "HEAD evidence is missing", field: "evidence.headSha" }));
  } else if (evidence.headSha !== evidence.worktreeHeadShaAfter) {
    findings.push(finding({ code: "HEAD_CHANGED", severity: "error", message: "Worktree HEAD changed during execution", field: "evidence.worktreeHeadShaAfter", expected: evidence.headSha, actual: evidence.worktreeHeadShaAfter }));
  }

  if (!SUPPORTED_CODING_TOOLS.has(evidence.tool)) {
    findings.push(finding({ code: "TOOL_UNKNOWN", severity: "human_review", message: "Coding tool is not recognized by Guardian policy", field: "evidence.tool", expected: [...SUPPORTED_CODING_TOOLS], actual: evidence.tool }));
  }

  if (!Array.isArray(evidence.changedFiles)) {
    findings.push(finding({ code: "CHANGED_FILES_MISSING", severity: "human_review", message: "changedFiles is missing", field: "evidence.changedFiles" }));
  } else if (evidence.changedFiles.length === 0) {
    findings.push(finding({ code: "CHANGED_FILES_EMPTY", severity: "human_review", message: "changedFiles is empty for a coding task", field: "evidence.changedFiles" }));
  } else {
    for (const changedFile of evidence.changedFiles) {
      const reason = typeof changedFile === "string" ? unsafePathReason(changedFile) : "non-string path";
      if (reason) {
        findings.push(finding({ code: "UNSAFE_CHANGED_PATH", severity: "error", message: `Changed file path is unsafe: ${reason}`, field: "evidence.changedFiles", actual: changedFile }));
      }
    }
  }

  if (evidence.expectedContentMatched === undefined || evidence.expectedContentMatched === null) {
    findings.push(finding({ code: "EXPECTED_CONTENT_MISSING", severity: "human_review", message: "Expected content match evidence is missing", field: "evidence.expectedContentMatched" }));
  } else if (evidence.expectedContentMatched !== true) {
    findings.push(finding({ code: "EXPECTED_CONTENT_MISMATCH", severity: "error", message: "Expected output content did not match", field: "evidence.expectedContentMatched", expected: true, actual: evidence.expectedContentMatched }));
  }

  if (evidence.humanReview === true) {
    findings.push(finding({ code: "HUMAN_REVIEW_REQUIRED", severity: "human_review", message: "Worker evidence requested human review", field: "evidence.humanReview", expected: false, actual: true }));
  }

  if (Array.isArray(evidence.changedFiles) && !statusMentionsChangedFiles(evidence.gitStatusAfter, evidence.changedFiles)) {
    findings.push(finding({ code: "STATUS_EVIDENCE_MISMATCH", severity: "human_review", message: "gitStatusAfter does not mention all changedFiles", field: "evidence.gitStatusAfter", expected: evidence.changedFiles, actual: evidence.gitStatusAfter }));
  }

  return findings;
}

export function reviewWorkerJobEvidence(context: GuardianReviewContext, options: { reviewId: string; workerJobId: string; reviewedAt: string }): GuardianReview {
  const findings: GuardianFinding[] = [];
  const job = context.workerJob;

  if (job.action !== "run_coding_tool") {
    findings.push(finding({ code: "UNSUPPORTED_ACTION", severity: "human_review", message: "Guardian MVP only reviews run_coding_tool jobs", field: "action", expected: "run_coding_tool", actual: job.action }));
  } else {
    findings.push(...reviewCodingToolEvidence(context));
  }

  const verdict = verdictFor(findings);
  return {
    reviewId: options.reviewId,
    workerJobId: options.workerJobId,
    verdict,
    reviewedAt: options.reviewedAt,
    policyVersion: GUARDIAN_POLICY_VERSION,
    findings,
    summary: summarize(verdict, findings),
  };
}

export async function runGuardianReview(input: GuardianReviewInput, deps: GuardianReviewDeps = {}): Promise<GuardianReview> {
  if (!input.reviewId || !input.workerJobId) {
    throw new GuardianReviewError("Missing required reviewId or workerJobId");
  }
  validateSafeId("reviewId", input.reviewId);
  validateSafeId("workerJobId", input.workerJobId);

  const cwd = deps.cwd ?? process.cwd();
  const env = deps.env ?? process.env;
  const existsSync = deps.existsSync ?? defaultExistsSync;
  const read = deps.readFile ?? readFile;
  const write: (path: string, data: string, encoding: BufferEncoding) => Promise<void> =
    deps.writeFile ?? ((path, data, _enc) => atomicWriteFile(path, data));
  const makeDir = deps.mkdir ?? mkdir;
  const now = deps.now ?? (() => new Date());
  const reviewPath = getGuardianReviewPath(input.reviewId, cwd);

  if (existsSync(reviewPath)) {
    throw new GuardianReviewError(`Guardian review already exists: ${reviewPath}`);
  }

  const raw = await read(getWorkerJobPath(input.workerJobId, cwd), "utf8");
  const parsed = JSON.parse(raw) as unknown;
  if (!isRecord(parsed)) {
    throw new GuardianReviewError("Worker job evidence is not a JSON object");
  }

  const review = reviewWorkerJobEvidence(
    {
      workerJob: parsed as unknown as WorkerJobState,
      worktreeRoot: getWorktreeRoot({ cwd, env, existsSync }),
    },
    {
      reviewId: input.reviewId,
      workerJobId: input.workerJobId,
      reviewedAt: now().toISOString(),
    }
  );

  await makeDir(dirname(reviewPath), { recursive: true });
  await write(reviewPath, `${JSON.stringify(review, null, 2)}\n`, "utf8");
  return review;
}

export function formatGuardianReviewSummary(review: GuardianReview): string {
  const blocking = review.findings.filter((item) => item.severity === "error").length;
  const reason = review.findings[0]?.message;
  const lines = [
    "",
    "  AMON Guardian",
    "  ────────────────────────",
    `  ${"Review:".padEnd(10)}${review.reviewId}`,
    `  ${"Job:".padEnd(10)}${review.workerJobId}`,
    `  ${"Verdict:".padEnd(10)}${review.verdict}`,
    `  ${"Policy:".padEnd(10)}${review.policyVersion}`,
    `  ${"Findings:".padEnd(10)}${blocking} blocking`,
  ];

  if (reason && review.verdict !== "PASS") {
    lines.push(`  ${"Reason:".padEnd(10)}${reason}`);
  }

  lines.push("  ────────────────────────", "");
  return `${lines.join("\n")}\n`;
}
