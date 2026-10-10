import { mkdir, mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { GuardianReview } from "../guardian/types";
import { CodingToolEvidence, WorkerJobState, WorkerStatus } from "../worker/types";
import { buildOperationalSnapshot } from "./projection";
import { DEFAULT_OPS_HOST, createOpsServer, startOpsServer } from "./server";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "amon-ops-"));
  tempDirs.push(dir);
  return dir;
}

function workerStatus(): WorkerStatus {
  return {
    workerId: "worker-local",
    hostname: "host.local",
    status: "offline",
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "v20.20.2",
    cwd: "/workspace/amon-agents",
    resources: { cpuCount: 8, totalMemoryMb: 16384, freeMemoryMb: 1000 },
    workspace: { root: "/workspace", available: true },
    tools: [
      { name: "git", available: true, version: "git version", path: "/usr/bin/git" },
      { name: "opencode", available: true, version: "1.17.20", path: "/secret/path/opencode" },
    ],
    ollama: { available: true, reachable: true, endpoint: "http://localhost:11434", activeModel: "model", installedModels: [] },
    startedAt: "2026-10-10T00:00:00.000Z",
    lastHeartbeatAt: "2026-10-10T00:00:01.000Z",
  };
}

function codingEvidence(overrides: Partial<CodingToolEvidence> = {}): CodingToolEvidence {
  return {
    repoPath: "/workspace/amon-agents",
    worktreePath: "/workspace/.amon/worktrees/repo/job",
    branch: "worker/job",
    headSha: "abc",
    gitStatusBefore: "",
    tool: "opencode",
    toolVersion: "1.17.20",
    startedAt: "2026-10-10T00:00:02.000Z",
    exitCode: 0,
    stdout: "secret output",
    stderr: "secret error",
    finishedAt: "2026-10-10T00:00:03.000Z",
    durationMs: 1000,
    gitStatusAfter: "?? sandbox/file.md",
    diffStat: "",
    changedFiles: ["sandbox/file.md"],
    diff: "secret diff",
    worktreeHeadShaAfter: "abc",
    worktreeBranchAfter: "worker/job",
    expectedFile: "sandbox/file.md",
    expectedContentMatched: true,
    humanReview: false,
    ...overrides,
  };
}

function job(overrides: Partial<WorkerJobState> = {}, evidence: CodingToolEvidence = codingEvidence()): WorkerJobState {
  return {
    jobId: "JARVIS-004D-RUN-004",
    action: "run_coding_tool",
    repo: "/workspace/amon-agents",
    worktreePath: evidence.worktreePath,
    tool: evidence.tool,
    status: "done",
    startedAt: "2026-10-10T00:00:02.000Z",
    finishedAt: "2026-10-10T00:00:03.000Z",
    durationMs: 1000,
    exitCode: 0,
    evidence,
    transitions: [],
    ...overrides,
  };
}

function review(overrides: Partial<GuardianReview> = {}): GuardianReview {
  return {
    reviewId: "GUARDIAN-004E-SMOKE-001",
    workerJobId: "JARVIS-004D-RUN-004",
    verdict: "PASS",
    reviewedAt: "2026-10-10T00:00:04.000Z",
    policyVersion: "guardian-evidence-v0.1",
    findings: [],
    summary: "PASS: 0 findings (0 blocking, 0 human_review, 0 warnings)",
    ...overrides,
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeFixture(cwd: string, options: { worker?: WorkerStatus; jobs?: WorkerJobState[]; reviews?: GuardianReview[]; malformedJob?: boolean } = {}): Promise<void> {
  if (options.worker) {
    await writeJson(join(cwd, "outputs", "worker", "worker-status.json"), options.worker);
  }
  for (const item of options.jobs ?? []) {
    await writeJson(join(cwd, "outputs", "worker", "jobs", `${item.jobId}.json`), item);
  }
  for (const item of options.reviews ?? []) {
    await writeJson(join(cwd, "outputs", "guardian", "reviews", `${item.reviewId}.json`), item);
  }
  if (options.malformedJob) {
    await mkdir(join(cwd, "outputs", "worker", "jobs"), { recursive: true });
    await writeFile(join(cwd, "outputs", "worker", "jobs", "BROKEN.json"), "{ nope", "utf8");
  }
}

describe("operational projection", () => {
  it("builds an empty system snapshot", async () => {
    const cwd = await makeTempDir();
    const snapshot = await buildOperationalSnapshot({ cwd, now: () => new Date("2026-10-10T00:00:00.000Z") });

    expect(snapshot).toEqual({
      generatedAt: "2026-10-10T00:00:00.000Z",
      systemStatus: "ok",
      workers: [],
      jobs: [],
      guardianReviews: [],
      agents: [
        { agentId: "jarvis", role: "orchestrator", state: "available" },
        { agentId: "claudio", role: "owner", state: "available" },
        { agentId: "guardian", role: "security_qa_gate", state: "available" },
      ],
    });
  });

  it("projects worker status without tool paths", async () => {
    const cwd = await makeTempDir();
    await writeFixture(cwd, { worker: workerStatus() });
    const snapshot = await buildOperationalSnapshot({ cwd });

    expect(snapshot.workers[0]).toMatchObject({ workerId: "worker-local", status: "offline", platform: "darwin", arch: "arm64" });
    expect(JSON.stringify(snapshot)).not.toContain("/secret/path");
  });

  it("projects coding jobs without stdout or stderr", async () => {
    const cwd = await makeTempDir();
    await writeFixture(cwd, { jobs: [job()] });
    const snapshot = await buildOperationalSnapshot({ cwd });

    expect(snapshot.jobs[0]).toMatchObject({ jobId: "JARVIS-004D-RUN-004", action: "run_coding_tool", status: "done", tool: "opencode" });
    expect(JSON.stringify(snapshot)).not.toContain("secret output");
    expect(JSON.stringify(snapshot)).not.toContain("secret error");
    expect(JSON.stringify(snapshot)).not.toContain("secret diff");
  });

  it("maps Guardian PASS reviews onto jobs", async () => {
    const cwd = await makeTempDir();
    await writeFixture(cwd, { jobs: [job()], reviews: [review()] });

    const snapshot = await buildOperationalSnapshot({ cwd });

    expect(snapshot.jobs[0].guardianVerdict).toBe("PASS");
    expect(snapshot.guardianReviews[0]).toMatchObject({ verdict: "PASS", findingsCount: 0 });
  });

  it("maps Guardian HUMAN_REVIEW to Claudio waiting_human", async () => {
    const cwd = await makeTempDir();
    await writeFixture(cwd, { jobs: [job()], reviews: [review({ verdict: "HUMAN_REVIEW" })] });

    const snapshot = await buildOperationalSnapshot({ cwd });

    expect(snapshot.jobs[0].requiresHumanReview).toBe(true);
    expect(snapshot.agents.find((agent) => agent.agentId === "claudio")?.state).toBe("waiting_human");
  });

  it("maps Guardian BLOCKED to Claudio blocked", async () => {
    const cwd = await makeTempDir();
    await writeFixture(cwd, { jobs: [job()], reviews: [review({ verdict: "BLOCKED" })] });

    const snapshot = await buildOperationalSnapshot({ cwd });

    expect(snapshot.jobs[0].guardianVerdict).toBe("BLOCKED");
    expect(snapshot.agents.find((agent) => agent.agentId === "claudio")?.state).toBe("blocked");
  });

  it("maps Claudio working when a coding job is running", async () => {
    const cwd = await makeTempDir();
    await writeFixture(cwd, { jobs: [job({ status: "running", finishedAt: undefined })] });

    const snapshot = await buildOperationalSnapshot({ cwd });

    expect(snapshot.agents.find((agent) => agent.agentId === "claudio")?.state).toBe("working");
  });

  it("does not expose secrets or environment values", async () => {
    const cwd = await makeTempDir();
    await writeFixture(cwd, { worker: workerStatus(), jobs: [job()] });
    const snapshot = await buildOperationalSnapshot({ cwd });
    const serialized = JSON.stringify(snapshot);

    expect(serialized).not.toContain("process.env");
    expect(serialized).not.toContain("OPENAI_API_KEY");
    expect(serialized).not.toContain("secret");
  });

  it("uses a deterministic schema", async () => {
    const cwd = await makeTempDir();
    await writeFixture(cwd, { worker: workerStatus(), jobs: [job()], reviews: [review()] });
    const snapshot = await buildOperationalSnapshot({ cwd, now: () => new Date("2026-10-10T00:00:00.000Z") });

    expect(Object.keys(snapshot)).toEqual(["generatedAt", "systemStatus", "workers", "jobs", "guardianReviews", "agents"]);
  });

  it("handles malformed persisted files safely", async () => {
    const cwd = await makeTempDir();
    await writeFixture(cwd, { jobs: [job()], malformedJob: true });

    const snapshot = await buildOperationalSnapshot({ cwd });

    expect(snapshot.systemStatus).toBe("degraded");
    expect(snapshot.jobs).toHaveLength(1);
  });

  it("handles missing outputs safely", async () => {
    const cwd = await makeTempDir();
    const snapshot = await buildOperationalSnapshot({ cwd });

    expect(snapshot.systemStatus).toBe("ok");
    expect(snapshot.workers).toEqual([]);
    expect(snapshot.jobs).toEqual([]);
    expect(snapshot.guardianReviews).toEqual([]);
  });
});

describe("ops HTTP server", () => {
  it("defaults to local bind", async () => {
    expect(DEFAULT_OPS_HOST).toBe("127.0.0.1");
  });

  it("serves GET /api/ops/snapshot", async () => {
    const cwd = await makeTempDir();
    await writeFixture(cwd, { jobs: [job()], reviews: [review()] });
    const started = await startOpsServer({ cwd, port: 0, now: () => new Date("2026-10-10T00:00:00.000Z") });
    try {
      const response = await fetch(`http://${started.host}:${started.port}/api/ops/snapshot`);
      const body = (await response.json()) as { jobs: Array<{ jobId: string }> };

      expect(response.status).toBe(200);
      expect(body.jobs[0].jobId).toBe("JARVIS-004D-RUN-004");
    } finally {
      await started.close();
    }
  });

  it("rejects non-GET methods", async () => {
    const server = createOpsServer();
    const started = await startOpsServer({ port: 0 });
    void server;
    try {
      const response = await fetch(`http://${started.host}:${started.port}/api/ops/snapshot`, { method: "POST" });
      expect(response.status).toBe(405);
    } finally {
      await started.close();
    }
  });

  it("has no mutation route", async () => {
    const started = await startOpsServer({ port: 0 });
    try {
      const response = await fetch(`http://${started.host}:${started.port}/api/ops/jobs`, { method: "POST" });
      expect([404, 405]).toContain(response.status);
    } finally {
      await started.close();
    }
  });
});
