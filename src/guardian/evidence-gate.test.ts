import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { getGuardianReviewPath, GUARDIAN_POLICY_VERSION, reviewWorkerJobEvidence, runGuardianReview } from "./evidence-gate";
import { CodingToolEvidence, WorkerJobState } from "../worker/types";

const tempDirs: string[] = [];
const worktreeRoot = "/workspace/.amon/worktrees";
const worktreePath = "/workspace/.amon/worktrees/amon-agents/JARVIS-004D-SMOKE-003";
const headSha = "26d5bbf509de9c856ea5dc36dd7aa3ee17ad8290";

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "amon-guardian-"));
  tempDirs.push(dir);
  return dir;
}

function codingEvidence(overrides: Partial<CodingToolEvidence> = {}): CodingToolEvidence {
  return {
    repoPath: "/workspace/amon-agents",
    worktreePath,
    branch: "worker/jarvis-004d-smoke-003",
    headSha,
    gitStatusBefore: "",
    tool: "opencode",
    toolVersion: "1.17.20",
    startedAt: "2026-10-10T03:59:26.228Z",
    exitCode: 0,
    stdout: "Created `sandbox/JARVIS-004D-SMOKE.md`.\n",
    stderr: "",
    finishedAt: "2026-10-10T03:59:36.505Z",
    durationMs: 10277,
    gitStatusAfter: "?? sandbox/JARVIS-004D-SMOKE.md",
    diffStat: "",
    changedFiles: ["sandbox/JARVIS-004D-SMOKE.md"],
    diff: "",
    worktreeHeadShaAfter: headSha,
    worktreeBranchAfter: "worker/jarvis-004d-smoke-003",
    expectedFile: "sandbox/JARVIS-004D-SMOKE.md",
    expectedContentMatched: true,
    humanReview: false,
    ...overrides,
  };
}

function workerJob(overrides: Partial<WorkerJobState> = {}, evidenceOverrides: Partial<CodingToolEvidence> = {}): WorkerJobState {
  return {
    jobId: "JARVIS-004D-RUN-004",
    action: "run_coding_tool",
    repo: "/workspace/amon-agents",
    worktreePath,
    tool: "opencode",
    status: "done",
    exitCode: 0,
    transitions: [
      { status: "queued", at: "2026-10-10T03:59:25.543Z" },
      { status: "running", at: "2026-10-10T03:59:25.548Z" },
      { status: "done", at: "2026-10-10T03:59:36.549Z" },
    ],
    evidence: codingEvidence(evidenceOverrides),
    ...overrides,
  };
}

function review(job: WorkerJobState) {
  return reviewWorkerJobEvidence(
    { workerJob: job, worktreeRoot },
    { reviewId: "GUARDIAN-TEST", workerJobId: job.jobId, reviewedAt: "2026-10-10T04:00:00.000Z" }
  );
}

describe("guardian evidence gate", () => {
  it("returns PASS for valid coding tool evidence", () => {
    const result = review(workerJob());

    expect(result.verdict).toBe("PASS");
    expect(result.findings).toEqual([]);
    expect(result.policyVersion).toBe(GUARDIAN_POLICY_VERSION);
    expect(result.summary).toBe("PASS: 0 findings (0 blocking, 0 human_review, 0 warnings)");
  });

  it("blocks failed worker jobs", () => {
    const result = review(workerJob({ status: "failed" }));

    expect(result.verdict).toBe("BLOCKED");
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "JOB_NOT_DONE", severity: "error" })]));
  });

  it("blocks non-zero tool exits", () => {
    const result = review(workerJob({}, { exitCode: 2 }));

    expect(result.verdict).toBe("BLOCKED");
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "TOOL_EXIT_NONZERO" })]));
  });

  it("requires human review for missing evidence", () => {
    const result = review(workerJob({ evidence: undefined }));

    expect(result.verdict).toBe("HUMAN_REVIEW");
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "EVIDENCE_MISSING" })]));
  });

  it("requires human review for missing exitCode", () => {
    const result = review(workerJob({}, { exitCode: undefined as never }));

    expect(result.verdict).toBe("HUMAN_REVIEW");
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "TOOL_EXIT_MISSING" })]));
  });

  it("blocks worktrees outside the configured root", () => {
    const result = review(workerJob({}, { worktreePath: "/workspace/amon-agents" }));

    expect(result.verdict).toBe("BLOCKED");
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "WORKTREE_OUTSIDE_ROOT" })]));
  });

  it("blocks branches that do not start with worker/", () => {
    const result = review(workerJob({}, { branch: "main", worktreeBranchAfter: "main" }));

    expect(result.verdict).toBe("BLOCKED");
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "BRANCH_POLICY_VIOLATION" })]));
  });

  it("blocks branch changes", () => {
    const result = review(workerJob({}, { worktreeBranchAfter: "worker/other" }));

    expect(result.verdict).toBe("BLOCKED");
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "BRANCH_CHANGED" })]));
  });

  it("blocks HEAD changes", () => {
    const result = review(workerJob({}, { worktreeHeadShaAfter: "ffffffff" }));

    expect(result.verdict).toBe("BLOCKED");
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "HEAD_CHANGED" })]));
  });

  it("requires human review for missing changedFiles", () => {
    const evidence = codingEvidence() as unknown as Record<string, unknown>;
    delete evidence.changedFiles;
    const result = review(workerJob({ evidence: evidence as unknown as CodingToolEvidence }));

    expect(result.verdict).toBe("HUMAN_REVIEW");
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "EVIDENCE_MISSING" })]));
  });

  it("blocks unsafe absolute changed paths", () => {
    const result = review(workerJob({}, { changedFiles: ["/tmp/pwned"], gitStatusAfter: "?? /tmp/pwned" }));

    expect(result.verdict).toBe("BLOCKED");
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "UNSAFE_CHANGED_PATH" })]));
  });

  it("blocks changed paths with traversal", () => {
    const result = review(workerJob({}, { changedFiles: ["../outside.md"], gitStatusAfter: "?? ../outside.md" }));

    expect(result.verdict).toBe("BLOCKED");
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "UNSAFE_CHANGED_PATH" })]));
  });

  it("blocks .git changed paths", () => {
    const result = review(workerJob({}, { changedFiles: [".git/config"], gitStatusAfter: "?? .git/config" }));

    expect(result.verdict).toBe("BLOCKED");
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "UNSAFE_CHANGED_PATH" })]));
  });

  it("blocks expected content mismatches", () => {
    const result = review(workerJob({}, { expectedContentMatched: false }));

    expect(result.verdict).toBe("BLOCKED");
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "EXPECTED_CONTENT_MISMATCH" })]));
  });

  it("requires human review when worker evidence requests it", () => {
    const result = review(workerJob({}, { humanReview: true }));

    expect(result.verdict).toBe("HUMAN_REVIEW");
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "HUMAN_REVIEW_REQUIRED" })]));
  });

  it("requires human review for inconsistent git status evidence", () => {
    const result = review(workerJob({}, { gitStatusAfter: "" }));

    expect(result.verdict).toBe("HUMAN_REVIEW");
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "STATUS_EVIDENCE_MISMATCH" })]));
  });

  it("prioritizes BLOCKED over HUMAN_REVIEW", () => {
    const result = review(workerJob({}, { exitCode: 1, humanReview: true }));

    expect(result.verdict).toBe("BLOCKED");
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "TOOL_EXIT_NONZERO" })]));
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "HUMAN_REVIEW_REQUIRED" })]));
  });

  it("persists reviews", async () => {
    const cwd = await makeTempDir();
    await mkdir(join(cwd, "outputs", "worker", "jobs"), { recursive: true });
    await writeFile(join(cwd, "outputs", "worker", "jobs", "JARVIS-004D-RUN-004.json"), `${JSON.stringify(workerJob(), null, 2)}\n`, "utf8");

    const result = await runGuardianReview(
      { reviewId: "GUARDIAN-004E-SMOKE-001", workerJobId: "JARVIS-004D-RUN-004" },
      {
        cwd,
        env: { AMON_WORKTREE_ROOT: worktreeRoot } as NodeJS.ProcessEnv,
        existsSync: (path) => path === getGuardianReviewPath("GUARDIAN-004E-SMOKE-001", cwd) ? false : true,
        now: () => new Date("2026-10-10T04:00:00.000Z"),
      }
    );

    const persisted = JSON.parse(await readFile(getGuardianReviewPath("GUARDIAN-004E-SMOKE-001", cwd), "utf8"));
    expect(result.verdict).toBe("PASS");
    expect(persisted).toMatchObject({ reviewId: "GUARDIAN-004E-SMOKE-001", workerJobId: "JARVIS-004D-RUN-004", verdict: "PASS" });
  });

  it("rejects duplicate review IDs without overwriting", async () => {
    const cwd = await makeTempDir();
    const reviewPath = getGuardianReviewPath("DUPLICATE", cwd);

    await expect(
      runGuardianReview(
        { reviewId: "DUPLICATE", workerJobId: "JARVIS-004D-RUN-004" },
        { cwd, existsSync: (path) => path === reviewPath }
      )
    ).rejects.toThrow("already exists");
  });

  it("does not mutate original worker evidence", () => {
    const job = workerJob();
    const before = structuredClone(job);

    review(job);

    expect(job).toEqual(before);
  });

  it("uses deterministic summaries", () => {
    expect(review(workerJob()).summary).toBe(review(workerJob()).summary);
  });

  it("uses exact policy version", () => {
    expect(review(workerJob()).policyVersion).toBe("guardian-evidence-v0.1");
  });

  it("does not treat inspect_repo evidence as coding tool evidence", () => {
    const result = review({
      ...workerJob(),
      action: "inspect_repo",
      evidence: { repoPath: "/workspace/amon-agents", repoExists: true, isGitRepo: true, branch: "main", headSha, gitStatusShort: "", gitStatusBranch: "## main", dirty: false, timestamp: "2026-10-10T04:00:00.000Z" },
    });

    expect(result.verdict).toBe("HUMAN_REVIEW");
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "UNSUPPORTED_ACTION" })]));
  });

  it("does not treat prepare_worktree evidence as coding tool evidence", () => {
    const result = review({
      ...workerJob(),
      action: "prepare_worktree",
      evidence: { repoPath: "/workspace/amon-agents", sourceBranch: "main", sourceHeadSha: headSha, worktreePath, worktreeBranch: "worker/x", worktreeHeadSha: headSha, worktreeStatusShort: "", created: true, timestamp: "2026-10-10T04:00:00.000Z" },
    });

    expect(result.verdict).toBe("HUMAN_REVIEW");
    expect(result.findings).toEqual(expect.arrayContaining([expect.objectContaining({ code: "UNSUPPORTED_ACTION" })]));
  });

  it("does not invoke LLMs or process mutation in pure review", () => {
    const result = review(workerJob());

    expect(result.verdict).toBe("PASS");
    expect(result.findings).toEqual([]);
  });
});
