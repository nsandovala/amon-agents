import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkerJob,
  getWorkerJobPath,
  JobExecFileFn,
  runWorkerJob,
  WorkerJobError,
} from "./jobs";
import { PrepareWorktreeEvidence, WorkerJobState } from "./types";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "amon-worker-job-"));
  tempDirs.push(dir);
  return dir;
}

function clock(): () => Date {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 9, 9, 12, 0, tick++));
}

function gitMock(options: { dirty?: boolean } = {}): JobExecFileFn {
  return async (command, args) => {
    expect(command).toBe("git");
    expect(args[0]).toBe("-C");
    const gitArgs = args.slice(2).join(" ");
    if (gitArgs === "rev-parse --is-inside-work-tree") {
      return { stdout: "true\n", stderr: "", exitCode: 0 };
    }
    if (gitArgs === "branch --show-current") {
      return { stdout: "feat/jarvis-004-worker-host-mvp\n", stderr: "", exitCode: 0 };
    }
    if (gitArgs === "rev-parse HEAD") {
      return { stdout: "a61552abcdef1234567890\n", stderr: "", exitCode: 0 };
    }
    if (gitArgs === "status --short") {
      return { stdout: options.dirty ? " M src/worker/jobs.ts\n" : "", stderr: "", exitCode: 0 };
    }
    if (gitArgs === "status --branch --short") {
      return {
        stdout: options.dirty
          ? "## feat/jarvis-004-worker-host-mvp\n M src/worker/jobs.ts\n"
          : "## feat/jarvis-004-worker-host-mvp\n",
        stderr: "",
        exitCode: 0,
      };
    }
    throw new Error(`unexpected git args: ${gitArgs}`);
  };
}

function prepareWorktreeGitMock(calls: Array<{ command: string; args: string[] }>): JobExecFileFn {
  return async (command, args) => {
    calls.push({ command, args });
    expect(command).toBe("git");
    if (args[0] !== "-C") {
      expect(args).toEqual(["check-ref-format", "--branch", "worker/JARVIS-004C"]);
      return { stdout: "worker/JARVIS-004C\n", stderr: "", exitCode: 0 };
    }

    const repo = args[1];
    const gitArgs = args.slice(2).join(" ");
    if (gitArgs === "rev-parse --is-inside-work-tree") {
      return { stdout: "true\n", stderr: "", exitCode: 0 };
    }
    if (gitArgs === "show-ref --verify refs/heads/worker/JARVIS-004C") {
      return { stdout: "", stderr: "", exitCode: 1 };
    }
    if (gitArgs === "worktree list --porcelain") {
      return { stdout: `worktree ${repo}\nHEAD a61552abcdef1234567890\nbranch refs/heads/feat/jarvis-004-worker-host-mvp\n`, stderr: "", exitCode: 0 };
    }
    if (gitArgs === "branch --show-current") {
      return {
        stdout: repo === "/workspace/.amon/worktrees/amon-agents/JARVIS-004C" ? "worker/JARVIS-004C\n" : "feat/jarvis-004-worker-host-mvp\n",
        stderr: "",
        exitCode: 0,
      };
    }
    if (gitArgs === "rev-parse HEAD") {
      return { stdout: "a61552abcdef1234567890\n", stderr: "", exitCode: 0 };
    }
    if (gitArgs === "worktree add -b worker/JARVIS-004C /workspace/.amon/worktrees/amon-agents/JARVIS-004C a61552abcdef1234567890") {
      return { stdout: "", stderr: "Preparing worktree\n", exitCode: 0 };
    }
    if (gitArgs === "status --short") {
      return { stdout: "", stderr: "", exitCode: 0 };
    }
    throw new Error(`unexpected git args: ${gitArgs}`);
  };
}

function baseDeps(overrides: Partial<Parameters<typeof runWorkerJob>[1]> = {}): NonNullable<Parameters<typeof runWorkerJob>[1]> {
  const cwd = "/workspace/amon-agents";
  return {
    cwd,
    env: { AMON_WORKSPACE_ROOT: "/workspace" } as NodeJS.ProcessEnv,
    existsSync: (path) => path === "/workspace" || path === "/workspace/amon-agents",
    realpath: async (path) => path,
    execFile: gitMock({ dirty: true }),
    persist: async () => undefined,
    now: clock(),
    ...overrides,
  };
}

describe("worker jobs", () => {
  it("creates a valid job contract", () => {
    const job = createWorkerJob(
      {
        jobId: "WORKER-SMOKE-001",
        action: "inspect_repo",
        repo: "/workspace/amon-agents",
      },
      () => new Date("2026-10-09T12:00:00.000Z")
    );

    expect(job).toEqual({
      jobId: "WORKER-SMOKE-001",
      action: "inspect_repo",
      repo: "/workspace/amon-agents",
      createdAt: "2026-10-09T12:00:00.000Z",
    });
  });

  it("creates a prepare_worktree job contract", () => {
    const job = createWorkerJob(
      {
        jobId: "JARVIS-004C",
        action: "prepare_worktree",
        repo: "/workspace/amon-agents",
        branch: "worker/JARVIS-004C",
      },
      () => new Date("2026-10-09T12:00:00.000Z")
    );

    expect(job).toEqual({
      jobId: "JARVIS-004C",
      action: "prepare_worktree",
      repo: "/workspace/amon-agents",
      branch: "worker/JARVIS-004C",
      createdAt: "2026-10-09T12:00:00.000Z",
    });
  });

  it("requires a worker branch for prepare_worktree", () => {
    expect(() =>
      createWorkerJob({
        jobId: "JARVIS-004C",
        action: "prepare_worktree",
        repo: "/workspace/amon-agents",
      })
    ).toThrow("Missing required branch");
  });

  it("rejects protected prepare_worktree branches", () => {
    expect(() =>
      createWorkerJob({
        jobId: "JARVIS-004C",
        action: "prepare_worktree",
        repo: "/workspace/amon-agents",
        branch: "main",
      })
    ).toThrow("Protected branch rejected");
  });

  it("rejects unknown actions explicitly", async () => {
    const persisted: WorkerJobState[] = [];
    const state = await runWorkerJob(
      { jobId: "BAD-ACTION", action: "shell_command" as never, repo: "/workspace/amon-agents" },
      baseDeps({
        persist: async (snapshot) => {
          persisted.push(structuredClone(snapshot));
        },
      })
    );

    expect(state.status).toBe("failed");
    expect(state.error).toContain("Unsupported worker job action");
    expect(persisted.map((item) => item.status)).toEqual(["queued", "running", "failed"]);
  });

  it("fails when repo does not exist", async () => {
    const state = await runWorkerJob(
      { jobId: "MISSING-REPO", action: "inspect_repo", repo: "/workspace/missing" },
      baseDeps({ existsSync: (path) => path === "/workspace" })
    );

    expect(state.status).toBe("failed");
    expect(state.error).toContain("Repo does not exist");
  });

  it("fails when repo is outside workspace", async () => {
    const state = await runWorkerJob(
      { jobId: "OUTSIDE-REPO", action: "inspect_repo", repo: "/other/repo" },
      baseDeps({
        existsSync: (path) => path === "/workspace" || path === "/other/repo",
      })
    );

    expect(state.status).toBe("failed");
    expect(state.error).toContain("outside workspace");
  });

  it("blocks workspace traversal through resolved real paths", async () => {
    const state = await runWorkerJob(
      { jobId: "TRAVERSAL", action: "inspect_repo", repo: "/workspace/link" },
      baseDeps({
        existsSync: (path) => path === "/workspace" || path === "/workspace/link",
        realpath: async (path) => (path === "/workspace/link" ? "/private/outside" : path),
      })
    );

    expect(state.status).toBe("failed");
    expect(state.error).toContain("outside workspace");
  });

  it("captures branch, HEAD and dirty status for a valid git repo", async () => {
    const state = await runWorkerJob(
      { jobId: "VALID-GIT", action: "inspect_repo", repo: "/workspace/amon-agents" },
      baseDeps()
    );

    expect(state.status).toBe("done");
    expect(state.exitCode).toBe(0);
    expect(state.evidence).toMatchObject({
      repoPath: "/workspace/amon-agents",
      repoExists: true,
      isGitRepo: true,
      branch: "feat/jarvis-004-worker-host-mvp",
      headSha: "a61552abcdef1234567890",
      dirty: true,
    });
    expect(state.evidence).toMatchObject({ gitStatusShort: expect.stringContaining("src/worker/jobs.ts") });
  });

  it("passes queued to running to done", async () => {
    const persisted: WorkerJobState[] = [];
    const state = await runWorkerJob(
      { jobId: "LIFECYCLE-DONE", action: "inspect_repo", repo: "/workspace/amon-agents" },
      baseDeps({
        persist: async (snapshot) => {
          persisted.push(structuredClone(snapshot));
        },
      })
    );

    expect(state.transitions.map((item) => item.status)).toEqual(["queued", "running", "done"]);
    expect(persisted.map((item) => item.status)).toEqual(["queued", "running", "done"]);
  });

  it("passes queued to running to failed on read-only git error", async () => {
    const state = await runWorkerJob(
      { jobId: "LIFECYCLE-FAIL", action: "inspect_repo", repo: "/workspace/amon-agents" },
      baseDeps({
        execFile: async (command, args, options) => {
          if (args.slice(2).join(" ") === "rev-parse --is-inside-work-tree") {
            return gitMock()(command, args, options);
          }
          return { stdout: "", stderr: "fatal: denied", exitCode: 1 };
        },
      })
    );

    expect(state.status).toBe("failed");
    expect(state.transitions.map((item) => item.status)).toEqual(["queued", "running", "failed"]);
    expect(state.error).toContain("fatal: denied");
  });

  it("persists output JSON", async () => {
    const cwd = await makeTempDir();
    const workspace = join(cwd, "workspace");
    const repo = join(workspace, "repo");
    const state = await runWorkerJob(
      { jobId: "PERSISTED", action: "inspect_repo", repo },
      {
        cwd,
        env: { AMON_WORKSPACE_ROOT: workspace } as NodeJS.ProcessEnv,
        existsSync: (path) => path === workspace || path === repo,
        realpath: async (path) => path,
        execFile: gitMock({ dirty: false }),
        now: clock(),
      }
    );

    const raw = await readFile(getWorkerJobPath("PERSISTED", cwd), "utf8");
    const parsed = JSON.parse(raw) as WorkerJobState;
    expect(parsed.status).toBe("done");
    expect(parsed.jobId).toBe(state.jobId);
    expect(parsed.evidence).toMatchObject({ dirty: false });
  });

  it("prepares an isolated worktree and captures evidence", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const mkdirCalls: Array<{ path: string; recursive: true }> = [];
    const state = await runWorkerJob(
      {
        jobId: "JARVIS-004C",
        action: "prepare_worktree",
        repo: "/workspace/amon-agents",
        branch: "worker/JARVIS-004C",
      },
      baseDeps({
        existsSync: (path) => path === "/workspace" || path === "/workspace/amon-agents",
        execFile: prepareWorktreeGitMock(calls),
        mkdir: async (path, options) => {
          mkdirCalls.push({ path, recursive: options.recursive });
        },
      })
    );

    expect(state.status).toBe("done");
    expect(state.branch).toBe("worker/JARVIS-004C");
    expect(state.evidence).toMatchObject({
      repoPath: "/workspace/amon-agents",
      sourceBranch: "feat/jarvis-004-worker-host-mvp",
      sourceHeadSha: "a61552abcdef1234567890",
      worktreePath: "/workspace/.amon/worktrees/amon-agents/JARVIS-004C",
      worktreeBranch: "worker/JARVIS-004C",
      worktreeHeadSha: "a61552abcdef1234567890",
      worktreeStatusShort: "",
      created: true,
    } satisfies Partial<PrepareWorktreeEvidence>);
    expect(mkdirCalls).toEqual([{ path: dirname("/workspace/.amon/worktrees/amon-agents/JARVIS-004C"), recursive: true }]);
    expect(calls.some((call) => call.args.join(" ").includes("worktree add -b worker/JARVIS-004C"))).toBe(true);
  });

  it("fails prepare_worktree without overwriting an existing destination", async () => {
    const state = await runWorkerJob(
      {
        jobId: "JARVIS-004C",
        action: "prepare_worktree",
        repo: "/workspace/amon-agents",
        branch: "worker/JARVIS-004C",
      },
      baseDeps({
        existsSync: (path) =>
          path === "/workspace" ||
          path === "/workspace/amon-agents" ||
          path === "/workspace/.amon/worktrees/amon-agents/JARVIS-004C",
        execFile: prepareWorktreeGitMock([]),
      })
    );

    expect(state.status).toBe("failed");
    expect(state.error).toContain("Worktree destination already exists");
    expect(state.evidence).toMatchObject({
      worktreePath: "/workspace/.amon/worktrees/amon-agents/JARVIS-004C",
      created: false,
    });
  });

  it("does not silently overwrite the same jobId", async () => {
    const persist = vi.fn(async () => undefined);

    await expect(
      runWorkerJob(
        { jobId: "DUPLICATE", action: "inspect_repo", repo: "/workspace/amon-agents" },
        baseDeps({
          existsSync: (path) => path === "/workspace" || path === "/workspace/amon-agents" || path.endsWith("DUPLICATE.json"),
          persist,
        })
      )
    ).rejects.toThrow(WorkerJobError);
    expect(persist).not.toHaveBeenCalled();
  });

  it("uses execFile arguments without shell interpolation", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const repo = "/workspace/repo; rm -rf .";
    await runWorkerJob(
      { jobId: "ARGS-SAFE", action: "inspect_repo", repo },
      baseDeps({
        existsSync: (path) => path === "/workspace" || path === repo,
        execFile: async (command, args, options) => {
          calls.push({ command, args });
          return gitMock()(command, args, options);
        },
      })
    );

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.command).toBe("git");
      expect(call.args[0]).toBe("-C");
      expect(call.args[1]).toBe(repo);
      expect(call.args.join(" ")).not.toContain("git -C");
    }
  });

  it("uses prepare_worktree execFile arguments without shell interpolation", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    await runWorkerJob(
      {
        jobId: "JARVIS-004C",
        action: "prepare_worktree",
        repo: "/workspace/amon-agents",
        branch: "worker/JARVIS-004C",
      },
      baseDeps({
        existsSync: (path) => path === "/workspace" || path === "/workspace/amon-agents",
        execFile: prepareWorktreeGitMock(calls),
        mkdir: async () => undefined,
      })
    );

    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) {
      expect(call.command).toBe("git");
      expect(call.args.join(" ")).not.toContain("git -C");
    }
    expect(calls).toContainEqual({
      command: "git",
      args: [
        "-C",
        "/workspace/amon-agents",
        "worktree",
        "add",
        "-b",
        "worker/JARVIS-004C",
        "/workspace/.amon/worktrees/amon-agents/JARVIS-004C",
        "a61552abcdef1234567890",
      ],
    });
  });
});
