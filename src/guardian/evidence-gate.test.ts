import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { getGuardianReviewPath, GUARDIAN_POLICY_VERSION, reviewWorkerJobEvidence, runGuardianReview } from "./evidence-gate";
import { CodingToolEvidence, WorkerJobState } from "../worker/types";
import { nextFixture } from './fixtures/next-release';

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

function nextWorkerCase() {
  const {build,policy} = nextFixture();
  const nextPolicy = {...policy.nextBuild,...policy,root:worktreePath,headSha,
    branch:'worker/jarvis-004d-smoke-003'};
  const evidence = {...build,root:worktreePath,headSha,worktreeHeadShaAfter:headSha,branch:nextPolicy.branch};
  const options = {reviewId:'NEXT-REVIEW',workerJobId:'JARVIS-004D-RUN-004',reviewedAt:policy.now,
    nextBuild:{evidence,policy:nextPolicy}};
  return {options};
}

describe("guardian evidence gate", () => {
  it('PR14 regression P1: blocks uncommitted worker output despite matching build HEAD', () => {
    const {options} = nextWorkerCase();
    const result = reviewWorkerJobEvidence({workerJob:workerJob(),worktreeRoot},options);
    expect(result.verdict).toBe('BLOCKED');
    expect(result.findings.map(f => f.code)).toContain('NEXT_WORKER_CONTENT_UNVERIFIED');
  });
  it('PR14 regression P2 clock: normal host clock does not require a separately sampled timestamp', async () => {
    const dir = await makeTempDir();
    const {options} = nextWorkerCase();
    options.nextBuild.policy.now = new Date(Date.now()-1000).toISOString();
    const job = workerJob({}, {changedFiles:[],gitStatusAfter:''});
    await mkdir(join(dir,'outputs/worker/jobs'),{recursive:true});
    await writeFile(join(dir,'outputs/worker/jobs/JARVIS-004D-RUN-004.json'),JSON.stringify(job));
    const before = Date.now();
    const result = await runGuardianReview({reviewId:'NEXT-REAL-CLOCK',workerJobId:job.jobId}, {
      cwd:dir,env:{AMON_WORKTREE_ROOT:worktreeRoot},nextBuild:options.nextBuild,
    });
    expect(Date.parse(result.reviewedAt)).toBeGreaterThanOrEqual(before);
    expect(Date.parse(result.reviewedAt)).toBeLessThanOrEqual(Date.now());
    // A clean no-change coding job still needs human review under the existing
    // Guardian policy; passing the Next checks must not weaken that requirement.
    expect(result.verdict).toBe('HUMAN_REVIEW');
    expect(result.findings.map(f => f.code)).toEqual(['CHANGED_FILES_EMPTY']);
  });
  it.each([
    {gitStatusAfter:' M app/page.tsx',changedFiles:['app/page.tsx']},
    {gitStatusAfter:'M  app/page.tsx',changedFiles:['app/page.tsx']},
    {gitStatusAfter:'?? app/new.tsx',changedFiles:['app/new.tsx']},
    {gitStatusAfter:' M app/page.tsx',changedFiles:[]},
    {gitStatusAfter:'',changedFiles:['app/page.tsx']},
    {gitStatusAfter:null,changedFiles:[]},
    {gitStatusAfter:'',changedFiles:undefined as never},
  ])('fails closed on dirty, contradictory or missing worker content identity %j', change => {
    const {options} = nextWorkerCase();
    const result = reviewWorkerJobEvidence({workerJob:workerJob({},change),worktreeRoot},options);
    expect(result.verdict).toBe('BLOCKED');
    expect(result.findings.map(f => f.code)).toContain('NEXT_WORKER_CONTENT_UNVERIFIED');
  });
  it.each([
    {startedAt:'2026-11-18T00:00:00.000Z',finishedAt:'2026-11-18T00:01:30.000Z'},
    {finishedAt:null},
    {finishedAt:'2026-02-30T00:00:00.000Z'},
    {finishedAt:'2026-10-01T00:00:00.000Z'},
    {startedAt:'invalid'},
  ])('rejects builds before worker completion or unknown worker chronology %j', change => {
    const {options} = nextWorkerCase();
    const job = workerJob({}, {changedFiles:[],gitStatusAfter:'',...change});
    const result = reviewWorkerJobEvidence({workerJob:job,worktreeRoot},options);
    expect(result.verdict).toBe('BLOCKED');
    expect(result.findings.map(f => f.code)).toContain('NEXT_WORKER_BUILD_CHRONOLOGY_UNVERIFIED');
    expect(result.findings.map(f => f.code)).not.toContain('NEXT_WORKER_CONTENT_UNVERIFIED');
  });
  it('requires the clean worker and the build to identify the same committed revision', () => {
    const {options} = nextWorkerCase();
    const clean = workerJob({}, {changedFiles:[],gitStatusAfter:''});
    const foreign = workerJob({}, {changedFiles:[],gitStatusAfter:'',headSha:'b'.repeat(40),worktreeHeadShaAfter:'b'.repeat(40)});
    expect(reviewWorkerJobEvidence({workerJob:foreign,worktreeRoot},options).findings.map(f => f.code))
      .toContain('NEXT_WORKER_CONTEXT_MISMATCH');
    options.nextBuild.evidence.headSha = 'b'.repeat(40);
    options.nextBuild.evidence.worktreeHeadShaAfter = 'b'.repeat(40);
    expect(reviewWorkerJobEvidence({workerJob:clean,worktreeRoot},options).findings.map(f => f.code))
      .toContain('NEXT_BUILD_REVISION_MISMATCH');
  });
  it('takes one host clock sample and does not mutate the original requirements', async () => {
    const {options} = nextWorkerCase();
    const trustedNow = options.reviewedAt;
    options.nextBuild.policy.now = '2026-11-18T00:01:59.999Z';
    Object.freeze(options.nextBuild.policy);
    const before = JSON.stringify(options.nextBuild);
    const dir = await makeTempDir();
    let calls = 0;
    const result = await runGuardianReview({reviewId:'NEXT-ONE-CLOCK',workerJobId:'JARVIS-004D-RUN-004'}, {
      cwd:dir,env:{AMON_WORKTREE_ROOT:worktreeRoot},nextBuild:options.nextBuild,
      readFile:async () => JSON.stringify(workerJob({}, {changedFiles:[],gitStatusAfter:''})),
      now:() => { calls++; return new Date(trustedNow); },
    });
    expect(calls).toBe(1);
    expect(result.reviewedAt).toBe(trustedNow);
    expect(result.findings.map(f => f.code)).toEqual(['CHANGED_FILES_EMPTY']);
    expect(JSON.stringify(options.nextBuild)).toBe(before);
  });
  it('keeps future build evidence blocked by the real host clock despite worker-supplied times', async () => {
    const dir = await makeTempDir();
    const {options} = nextWorkerCase();
    const future = new Date(Date.now()+60_000).toISOString();
    options.nextBuild.policy.now = future;
    options.nextBuild.evidence.finishedAt = future;
    options.nextBuild.evidence.result.createdAt = future;
    const job = {...workerJob({}, {changedFiles:[],gitStatusAfter:''}),now:future,reviewedAt:future,
      nextBuild:options.nextBuild};
    await mkdir(join(dir,'outputs/worker/jobs'),{recursive:true});
    await writeFile(join(dir,'outputs/worker/jobs/JARVIS-004D-RUN-004.json'),JSON.stringify(job));
    const result = await runGuardianReview({reviewId:'NEXT-UNTRUSTED-CLOCK',workerJobId:job.jobId}, {
      cwd:dir,env:{AMON_WORKTREE_ROOT:worktreeRoot},nextBuild:options.nextBuild,
    });
    expect(Date.parse(result.reviewedAt)).toBeLessThan(Date.parse(future));
    expect(result.verdict).toBe('BLOCKED');
    expect(result.findings.map(f => f.code)).toContain('NEXT_BUILD_INCOMPLETE');
  });
  it('preserves advisory freshness and rejects an invalid trusted review time', () => {
    const {options} = nextWorkerCase();
    const clean = workerJob({}, {changedFiles:[],gitStatusAfter:''});
    options.nextBuild.policy.advisories[0].retrievedAt = '2026-11-17T00:00:00.000Z';
    expect(reviewWorkerJobEvidence({workerJob:clean,worktreeRoot},options).findings.map(f => f.code))
      .toContain('NEXT_SECURITY_INSUFFICIENT');
    expect(reviewWorkerJobEvidence({workerJob:clean,worktreeRoot},{...options,reviewedAt:'invalid'}).findings.map(f => f.code))
      .toContain('NEXT_REQUIREMENTS_INVALID');
  });
  it('integrates host-required Next checks without granting acceptance from worker PASS', () => {
    const {build,policy} = nextFixture();
    const nextPolicy = {...policy.nextBuild,...policy,root:worktreePath,headSha,
      branch:'worker/jarvis-004d-smoke-003'};
    const evidence = {...build,root:worktreePath,headSha,worktreeHeadShaAfter:headSha,branch:nextPolicy.branch};
    const options = {reviewId:'NEXT-REVIEW',workerJobId:'JARVIS-004D-RUN-004',reviewedAt:policy.now,
      nextBuild:{evidence,policy:nextPolicy}};
    const clean = workerJob({}, {changedFiles:[],gitStatusAfter:''});
    const result = reviewWorkerJobEvidence({workerJob:clean,worktreeRoot},options);
    expect(result.verdict).toBe('HUMAN_REVIEW');
    expect(result.findings.map(f => f.code)).toEqual(['CHANGED_FILES_EMPTY']);
    for (const observed of [undefined,{...evidence,exitCode:1},{...evidence,buildNodeEnv:'development'}]) {
      const r = reviewWorkerJobEvidence({workerJob:workerJob(),worktreeRoot},
        {...options,nextBuild:{evidence:observed,policy:nextPolicy}});
      expect(r.verdict).toBe('BLOCKED');
      expect(r.findings.some(f => f.code.startsWith('NEXT_'))).toBe(true);
    }
    const foreign = reviewWorkerJobEvidence({workerJob:workerJob(),worktreeRoot},
      {...options,nextBuild:{evidence:build,policy:{...policy.nextBuild,...policy}}});
    expect(foreign.findings.map(f => f.code)).toContain('NEXT_WORKER_CONTEXT_MISMATCH');
  });
  it('persists Next failures through the existing host Guardian review entry point', async () => {
    const dir = await makeTempDir();
    const {build,policy} = nextFixture();
    const nextPolicy = {...policy.nextBuild,...policy,root:worktreePath,headSha,
      branch:'worker/jarvis-004d-smoke-003'};
    await mkdir(join(dir,'outputs/worker/jobs'),{recursive:true});
    await writeFile(join(dir,'outputs/worker/jobs/JARVIS-004D-RUN-004.json'),JSON.stringify(workerJob()));
    const result = await runGuardianReview({reviewId:'NEXT-HOST',workerJobId:'JARVIS-004D-RUN-004'}, {
      cwd:dir,env:{AMON_WORKTREE_ROOT:worktreeRoot},now:() => new Date(policy.now),
      nextBuild:{policy:nextPolicy,evidence:{...build,root:worktreePath,headSha,
        worktreeHeadShaAfter:headSha,branch:nextPolicy.branch,exitCode:1}},
    });
    expect(result.verdict).toBe('BLOCKED');
    expect(result.findings.map(f => f.code)).toContain('NEXT_BUILD_EXIT_FAILED');
    expect(JSON.parse(await readFile(getGuardianReviewPath('NEXT-HOST',dir),'utf8'))).toEqual(result);
  });
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
