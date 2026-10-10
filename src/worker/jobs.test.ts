import { mkdtemp, readFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createWorkerJob,
  defaultExecFile,
  getWorkerJobPath,
  JobExecFileFn,
  runWorkerJob,
  WorkerJobError,
} from "./jobs";
import { CodingToolEvidence, PrepareWorktreeEvidence, WorkerJobState } from "./types";

const tempDirs: string[] = [];
const codingRepo = "/workspace/amon-agents";
const codingWorktree = "/workspace/.amon/worktrees/amon-agents/JARVIS-004D-SMOKE-001";
const codingBranch = "worker/jarvis-004d-smoke-001";
const codingHead = "26d5bbfabcdef1234567890";
const codingFile = "sandbox/JARVIS-004D-SMOKE.md";
const codingContent = "# JARVIS-004D Smoke\n\nAMON Worker controlled coding tool execution succeeded.\n";
const codingTask = `Create only ${codingFile} with the exact provided content.`;

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

function codingToolDeps(
  options: {
    exists?: (path: string) => boolean;
    realpath?: (path: string) => Promise<string>;
    beforeStatus?: string;
    changedFiles?: string[];
    toolExitCode?: number;
    toolStdout?: string;
    toolStderr?: string;
    toolMissing?: boolean;
    invalidWorktree?: boolean;
    headAfter?: string;
    branchAfter?: string;
    fileContent?: string;
    env?: NodeJS.ProcessEnv;
  } = {}
): NonNullable<Parameters<typeof runWorkerJob>[1]> & { calls: Array<{ command: string; args: string[]; cwd?: string }> } {
  const calls: Array<{ command: string; args: string[]; cwd?: string }> = [];
  let statusCalls = 0;
  const changedFiles = options.changedFiles ?? [codingFile];
  const deps = baseDeps({
    env: options.env ?? ({ AMON_WORKSPACE_ROOT: "/workspace" } as NodeJS.ProcessEnv),
    existsSync:
      options.exists ??
      ((path) =>
        path === "/workspace" ||
        path === codingRepo ||
        path === "/workspace/.amon/worktrees" ||
        path === codingWorktree),
    realpath: options.realpath ?? (async (path) => path),
    readFile: async (path) => {
      expect(path).toBe(`${codingWorktree}/${codingFile}`);
      return options.fileContent ?? codingContent;
    },
    execFile: async (command, args, execOptions) => {
      calls.push({ command, args, cwd: execOptions.cwd });
      if (command === "opencode") {
        if (args.join(" ") === "--version") {
          return options.toolMissing
            ? { stdout: "", stderr: "opencode not found", exitCode: 1 }
            : { stdout: "1.17.20\n", stderr: "", exitCode: 0 };
        }
        expect(args[0]).toBe("run");
        expect(args[1]).toBe("--pure");
        return {
          stdout: options.toolStdout ?? "created smoke file\n",
          stderr: options.toolStderr ?? "",
          exitCode: options.toolExitCode ?? 0,
        };
      }

      expect(command).toBe("git");
      expect(args[0]).toBe("-C");
      expect(args[1]).toBe(codingWorktree);
      const gitArgs = args.slice(2).join(" ");
      if (gitArgs === "rev-parse --is-inside-work-tree") {
        return { stdout: options.invalidWorktree ? "false\n" : "true\n", stderr: "", exitCode: options.invalidWorktree ? 1 : 0 };
      }
      if (gitArgs === "branch --show-current") {
        return { stdout: `${statusCalls > 0 ? options.branchAfter ?? codingBranch : codingBranch}\n`, stderr: "", exitCode: 0 };
      }
      if (gitArgs === "rev-parse HEAD") {
        return { stdout: `${statusCalls > 0 ? options.headAfter ?? codingHead : codingHead}\n`, stderr: "", exitCode: 0 };
      }
      if (gitArgs === "status --short") {
        const stdout = statusCalls === 0 ? options.beforeStatus ?? "" : changedFiles.map((file) => `?? ${file}`).join("\n");
        statusCalls += 1;
        return { stdout: stdout ? `${stdout}\n` : "", stderr: "", exitCode: 0 };
      }
      if (gitArgs === "status --short --untracked-files=all") {
        const stdout = changedFiles.map((file) => `?? ${file}`).join("\n");
        return { stdout: stdout ? `${stdout}\n` : "", stderr: "", exitCode: 0 };
      }
      if (gitArgs === "diff --stat") {
        return { stdout: " sandbox/JARVIS-004D-SMOKE.md | 3 +++\n 1 file changed, 3 insertions(+)\n", stderr: "", exitCode: 0 };
      }
      if (gitArgs === "diff --name-only") {
        return { stdout: `${changedFiles.join("\n")}\n`, stderr: "", exitCode: 0 };
      }
      if (gitArgs === `diff -- ${codingFile}`) {
        return { stdout: `diff --git a/${codingFile} b/${codingFile}\n`, stderr: "", exitCode: 0 };
      }
      throw new Error(`unexpected git args: ${gitArgs}`);
    },
  });
  return { ...deps, calls };
}

function codingJob(overrides: Partial<Parameters<typeof runWorkerJob>[0]> = {}): Parameters<typeof runWorkerJob>[0] {
  return {
    jobId: "JARVIS-004D-RUN-001",
    action: "run_coding_tool",
    repo: codingRepo,
    worktreePath: codingWorktree,
    tool: "opencode",
    task: codingTask,
    ...overrides,
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

  it("prepare_worktree can use an explicit worktree destination", async () => {
    const calls: Array<{ command: string; args: string[] }> = [];
    const state = await runWorkerJob(
      {
        jobId: "JARVIS-004C-PREPARE",
        action: "prepare_worktree",
        repo: "/workspace/amon-agents",
        branch: "worker/JARVIS-004C",
        worktreePath: "/workspace/.amon/worktrees/amon-agents/JARVIS-004C",
      },
      baseDeps({
        existsSync: (path) => path === "/workspace" || path === "/workspace/amon-agents" || path === "/workspace/.amon/worktrees",
        execFile: prepareWorktreeGitMock(calls),
        mkdir: async () => undefined,
      })
    );

    expect(state.status).toBe("done");
    expect(state.evidence).toMatchObject({ worktreePath: "/workspace/.amon/worktrees/amon-agents/JARVIS-004C" });
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

  it("creates a valid run_coding_tool contract", () => {
    const job = createWorkerJob(
      {
        jobId: "JARVIS-004D-RUN-001",
        action: "run_coding_tool",
        repo: codingRepo,
        worktreePath: codingWorktree,
        tool: "opencode",
        task: codingTask,
      },
      () => new Date("2026-10-09T12:00:00.000Z")
    );

    expect(job).toMatchObject({
      jobId: "JARVIS-004D-RUN-001",
      action: "run_coding_tool",
      repo: codingRepo,
      worktreePath: codingWorktree,
      tool: "opencode",
      task: codingTask,
      createdAt: "2026-10-09T12:00:00.000Z",
    });
  });

  it("rejects run_coding_tool missing worktree", () => {
    expect(() => createWorkerJob({ jobId: "JARVIS-004D-RUN-001", action: "run_coding_tool", repo: codingRepo, tool: "opencode" })).toThrow(
      "Missing required worktreePath"
    );
  });

  it("rejects run_coding_tool missing tool", () => {
    expect(() => createWorkerJob({ jobId: "JARVIS-004D-RUN-001", action: "run_coding_tool", repo: codingRepo, worktreePath: codingWorktree })).toThrow(
      "Missing required tool"
    );
  });

  it("rejects unsupported coding tools", () => {
    for (const tool of ["claude", "codex", "bash", "sh", "zsh", "powershell", "python", "node", "shell_command"]) {
      expect(() => createWorkerJob({ jobId: "JARVIS-004D-RUN-001", action: "run_coding_tool", repo: codingRepo, worktreePath: codingWorktree, tool })).toThrow(
        "Unsupported coding tool"
      );
    }
  });

  it("rejects run_coding_tool worktrees outside the worktree root", async () => {
    const deps = codingToolDeps({
      realpath: async (path) => (path === codingWorktree ? "/outside/worktree" : path),
    });
    const state = await runWorkerJob(codingJob(), deps);

    expect(state.status).toBe("failed");
    expect(state.error).toContain("outside worktree root");
  });

  it("rejects the main repo path as the coding worktree", async () => {
    const deps = codingToolDeps({
      env: { AMON_WORKSPACE_ROOT: "/workspace", AMON_WORKTREE_ROOT: "/workspace" } as NodeJS.ProcessEnv,
      exists: (path) => path === "/workspace" || path === codingRepo,
    });
    const state = await runWorkerJob(codingJob({ worktreePath: codingRepo }), deps);

    expect(state.status).toBe("failed");
    expect(state.error).toContain("must not be the main repo path");
  });

  it("rejects invalid git worktrees", async () => {
    const state = await runWorkerJob(codingJob(), codingToolDeps({ invalidWorktree: true }));

    expect(state.status).toBe("failed");
    expect(state.error).toContain("Invalid git worktree");
  });

  it("rejects dirty worktrees before running the tool", async () => {
    const deps = codingToolDeps({ beforeStatus: " M src/worker/jobs.ts" });
    const state = await runWorkerJob(codingJob(), deps);

    expect(state.status).toBe("failed");
    expect(state.error).toContain("must be clean");
    expect(deps.calls.some((call) => call.command === "opencode" && call.args[0] === "run")).toBe(false);
  });

  it("rejects missing opencode before execution", async () => {
    const deps = codingToolDeps({ toolMissing: true });
    const state = await runWorkerJob(codingJob(), deps);

    expect(state.status).toBe("failed");
    expect(state.error).toContain("Coding tool unavailable");
    expect(deps.calls.some((call) => call.command === "opencode" && call.args[0] === "run")).toBe(false);
  });

  it("uses separated tool args with cwd exactly set to the worktree", async () => {
    const deps = codingToolDeps();
    const state = await runWorkerJob(codingJob(), deps);
    const toolRun = deps.calls.find((call) => call.command === "opencode" && call.args[0] === "run");

    expect(state.status).toBe("done");
    expect(toolRun).toEqual({ command: "opencode", args: ["run", "--pure", "--dir", codingWorktree, codingTask], cwd: codingWorktree });
    expect(toolRun?.args.join(" ")).not.toContain("opencode run");
  });

  it("fails and preserves evidence when the coding tool times out", async () => {
    const state = await runWorkerJob(codingJob(), codingToolDeps({ env: { AMON_WORKSPACE_ROOT: "/workspace", AMON_WORKER_TOOL_TIMEOUT_MS: "1" } as NodeJS.ProcessEnv, toolExitCode: 1, toolStderr: "Command timed out" }));

    expect(state.status).toBe("failed");
    expect(state.error).toContain("Coding tool exited with code 1");
    expect(state.evidence).toMatchObject({ stderr: "Command timed out", exitCode: 1 });
  });

  it("fails and preserves stdout/stderr on non-zero tool exit", async () => {
    const state = await runWorkerJob(codingJob(), codingToolDeps({ toolExitCode: 2, toolStdout: "partial output", toolStderr: "tool denied" }));

    expect(state.status).toBe("failed");
    expect(state.evidence).toMatchObject({ stdout: "partial output", stderr: "tool denied", exitCode: 2 });
  });

  it("captures git diff and changed files", async () => {
    const state = await runWorkerJob(codingJob(), codingToolDeps());

    expect(state.status).toBe("done");
    expect(state.evidence).toMatchObject({
      diffStat: expect.stringContaining("1 file changed"),
      changedFiles: [codingFile],
      diff: expect.stringContaining(codingFile),
    } satisfies Partial<CodingToolEvidence>);
  });

  it("verifies HEAD before equals HEAD after", async () => {
    const state = await runWorkerJob(codingJob(), codingToolDeps());

    expect(state.status).toBe("done");
    expect(state.evidence).toMatchObject({ headSha: codingHead, worktreeHeadShaAfter: codingHead });
  });

  it("fails for unexpected changed files and marks human review", async () => {
    const state = await runWorkerJob(codingJob(), codingToolDeps({ changedFiles: [codingFile, "src/worker/jobs.ts"] }));

    expect(state.status).toBe("failed");
    expect(state.error).toContain("Unexpected changed files");
    expect(state.evidence).toMatchObject({ changedFiles: [codingFile, "src/worker/jobs.ts"], humanReview: true });
  });

  it("fails when the expected smoke file content is not exact", async () => {
    const state = await runWorkerJob(codingJob(), codingToolDeps({ fileContent: "wrong\n" }));

    expect(state.status).toBe("failed");
    expect(state.error).toContain("content mismatch");
    expect(state.evidence).toMatchObject({ expectedContentMatched: false, humanReview: true });
  });

  it("marks exact expected file output as done", async () => {
    const state = await runWorkerJob(codingJob(), codingToolDeps());

    expect(state.status).toBe("done");
    expect(state.evidence).toMatchObject({
      expectedFile: codingFile,
      expectedContentMatched: true,
      changedFiles: [codingFile],
      humanReview: false,
    });
  });

  it("fails if the tool changes HEAD", async () => {
    const state = await runWorkerJob(codingJob(), codingToolDeps({ headAfter: "ffffffffffffffff" }));

    expect(state.status).toBe("failed");
    expect(state.error).toContain("HEAD changed");
    expect(state.evidence).toMatchObject({ humanReview: true });
  });

  it("does not use shell interpolation for run_coding_tool", async () => {
    const deps = codingToolDeps();
    await runWorkerJob(codingJob({ task: "create file; git commit -am bad" }), deps);

    for (const call of deps.calls) {
      expect(call.command).not.toMatch(/\s/);
      expect(call.command).not.toBe("sh");
      expect(call.command).not.toBe("bash");
      expect(call.command).not.toBe("zsh");
      expect(call.args.join(" ")).not.toContain(`${call.command} `);
    }
  });

  it("runs worker commands non-interactively by closing stdin", async () => {
    const result = await defaultExecFile(
      process.execPath,
      [
        "-e",
        "process.stdin.resume(); process.stdin.on('end', () => { process.stdout.write('stdin closed\\n'); process.exit(0); }); setTimeout(() => process.exit(2), 1000);",
      ],
      { timeout: 3000 }
    );

    expect(result).toEqual({ stdout: "stdin closed\n", stderr: "", exitCode: 0 });
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
