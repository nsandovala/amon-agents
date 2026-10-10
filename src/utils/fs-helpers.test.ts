import { existsSync } from "fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { atomicWriteFile } from "./fs-helpers";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
  tempDirs.length = 0;
});

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "amon-atomic-"));
  tempDirs.push(dir);
  return dir;
}

// ─── Group 1: Happy path ──────────────────────────────────────────────────────

describe("atomicWriteFile — happy path", () => {
  it("writes content to the destination path", async () => {
    const dir = await makeTempDir();
    const destPath = join(dir, "state.json");
    await atomicWriteFile(destPath, '{"status":"done"}\n');
    const content = await readFile(destPath, "utf8");
    expect(JSON.parse(content)).toEqual({ status: "done" });
  });

  it("creates parent directories that do not exist", async () => {
    const dir = await makeTempDir();
    const destPath = join(dir, "sub", "deep", "state.json");
    await atomicWriteFile(destPath, '{"ok":true}\n');
    expect(JSON.parse(await readFile(destPath, "utf8"))).toEqual({ ok: true });
  });

  it("leaves no .tmp files after success", async () => {
    const dir = await makeTempDir();
    const destPath = join(dir, "state.json");
    await atomicWriteFile(destPath, '{"x":1}\n');
    const files = await readdir(dir);
    expect(files).toEqual(["state.json"]);
  });

  it("atomically replaces an existing file", async () => {
    const dir = await makeTempDir();
    const destPath = join(dir, "state.json");
    await writeFile(destPath, '{"status":"queued"}\n', "utf8");
    await atomicWriteFile(destPath, '{"status":"done"}\n');
    expect(JSON.parse(await readFile(destPath, "utf8"))).toMatchObject({ status: "done" });
  });

  it("content is immediately readable after return", async () => {
    const dir = await makeTempDir();
    const destPath = join(dir, "state.json");
    const payload = JSON.stringify({ jobId: "TEST-001", status: "done" }, null, 2) + "\n";
    await atomicWriteFile(destPath, payload);
    const parsed = JSON.parse(await readFile(destPath, "utf8"));
    expect(parsed.jobId).toBe("TEST-001");
    expect(parsed.status).toBe("done");
  });

  it("uses the injected uuidFn for the temp file name", async () => {
    const dir = await makeTempDir();
    const destPath = join(dir, "state.json");
    let capturedTmpPath = "";
    await atomicWriteFile(destPath, '{"ok":true}\n', {
      uuidFn: () => "fixed-uuid-for-test",
      renameFn: async (src, dst) => {
        capturedTmpPath = src;
        const { rename } = await import("fs/promises");
        await rename(src, dst);
      },
    });
    expect(capturedTmpPath).toMatch(/state\.json\.fixed-uuid-for-test\.tmp$/);
    const files = await readdir(dir);
    expect(files).toEqual(["state.json"]);
  });
});

// ─── Group 2: Fault injection — writeFile failure ────────────────────────────

describe("atomicWriteFile — writeFile failure", () => {
  it("propagates error when writeFileFn throws", async () => {
    const dir = await makeTempDir();
    const destPath = join(dir, "state.json");
    await expect(
      atomicWriteFile(destPath, '{"x":1}\n', {
        uuidFn: () => "fail-write",
        writeFileFn: async () => { throw new Error("ENOSPC: disk full"); },
      })
    ).rejects.toThrow("ENOSPC: disk full");
  });

  it("destination is untouched when writeFileFn throws", async () => {
    const dir = await makeTempDir();
    const destPath = join(dir, "state.json");
    try {
      await atomicWriteFile(destPath, '{"x":1}\n', {
        writeFileFn: async () => { throw new Error("ENOSPC"); },
      });
    } catch { /* expected */ }
    expect(existsSync(destPath)).toBe(false);
  });

  it("temp file is removed when writeFileFn throws", async () => {
    const dir = await makeTempDir();
    const destPath = join(dir, "state.json");
    try {
      await atomicWriteFile(destPath, '{"x":1}\n', {
        uuidFn: () => "cleanup-write-fail",
        writeFileFn: async (tmpPath) => {
          // Partially create the file, then fail
          await writeFile(tmpPath, "partial", "utf8");
          throw new Error("ENOSPC");
        },
      });
    } catch { /* expected */ }
    const files = await readdir(dir);
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

// ─── Group 3: Fault injection — rename failure ───────────────────────────────

describe("atomicWriteFile — rename failure", () => {
  it("propagates error when renameFn throws", async () => {
    const dir = await makeTempDir();
    const destPath = join(dir, "state.json");
    await expect(
      atomicWriteFile(destPath, '{"x":1}\n', {
        uuidFn: () => "fail-rename",
        renameFn: async () => { throw new Error("EROFS: read-only file system"); },
      })
    ).rejects.toThrow("EROFS");
  });

  it("destination is untouched when renameFn throws", async () => {
    const dir = await makeTempDir();
    const destPath = join(dir, "state.json");
    try {
      await atomicWriteFile(destPath, '{"x":1}\n', {
        renameFn: async () => { throw new Error("EROFS"); },
      });
    } catch { /* expected */ }
    expect(existsSync(destPath)).toBe(false);
  });

  it("temp file is removed when renameFn throws", async () => {
    const dir = await makeTempDir();
    const destPath = join(dir, "state.json");
    try {
      await atomicWriteFile(destPath, '{"x":1}\n', {
        uuidFn: () => "cleanup-rename-fail",
        renameFn: async () => { throw new Error("EROFS"); },
      });
    } catch { /* expected */ }
    const files = await readdir(dir);
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

// ─── Group 4: Cleanup failure (orphaned temp) ────────────────────────────────

describe("atomicWriteFile — cleanup failure", () => {
  it("propagates the original rename error when unlink also fails", async () => {
    const dir = await makeTempDir();
    const destPath = join(dir, "state.json");
    await expect(
      atomicWriteFile(destPath, '{"x":1}\n', {
        uuidFn: () => "double-fail",
        renameFn: async () => { throw new Error("EXDEV: cross-device link"); },
        unlinkFn: async () => { throw new Error("EBUSY: resource busy"); },
      })
    ).rejects.toThrow("EXDEV: cross-device link");
  });

  it("does not swallow the original error when cleanup fails", async () => {
    const dir = await makeTempDir();
    const destPath = join(dir, "state.json");
    let caught: Error | undefined;
    try {
      await atomicWriteFile(destPath, '{"x":1}\n', {
        renameFn: async () => { throw new Error("ORIGINAL_ERROR"); },
        unlinkFn: async () => { throw new Error("CLEANUP_ERROR"); },
      });
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toBe("ORIGINAL_ERROR");
  });
});

// ─── Group 5: Concurrency ────────────────────────────────────────────────────

describe("atomicWriteFile — concurrency", () => {
  it("concurrent writes produce a valid JSON document with no corruption", async () => {
    const dir = await makeTempDir();
    const destPath = join(dir, "state.json");

    await Promise.allSettled([
      atomicWriteFile(destPath, '{"writer":"A"}\n'),
      atomicWriteFile(destPath, '{"writer":"B"}\n'),
    ]);

    // File must exist and be valid JSON — exactly the no-corruption guarantee
    const content = await readFile(destPath, "utf8");
    const parsed = JSON.parse(content);
    expect(["A", "B"]).toContain(parsed.writer);
  });

  it("no .tmp files remain after concurrent writes", async () => {
    const dir = await makeTempDir();
    const destPath = join(dir, "state.json");

    await Promise.allSettled([
      atomicWriteFile(destPath, '{"writer":"A"}\n'),
      atomicWriteFile(destPath, '{"writer":"B"}\n'),
      atomicWriteFile(destPath, '{"writer":"C"}\n'),
    ]);

    const files = await readdir(dir);
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

// ─── Group 6: Integration with defaultPersist and persistWorkerStatus ────────

describe("atomicWriteFile — integration", () => {
  it("defaultPersist writes a complete parseable WorkerJobState to disk", async () => {
    // This test exercises the real defaultPersist() path through runWorkerJob.
    // It intentionally replicates the existing "persists output JSON" test
    // structure to verify atomicWriteFile is a transparent replacement.
    const { runWorkerJob, getWorkerJobPath } = await import("../worker/jobs");

    const dir = await makeTempDir();
    const workspace = join(dir, "workspace");
    const repo = join(workspace, "repo");
    await mkdir(workspace, { recursive: true });

    const state = await runWorkerJob(
      { jobId: "ATOMIC-INTEGRATION-001", action: "inspect_repo", repo },
      {
        cwd: dir,
        env: { AMON_WORKSPACE_ROOT: workspace } as NodeJS.ProcessEnv,
        existsSync: (path) => path === workspace || path === repo,
        realpath: async (path) => path,
        execFile: async (_cmd, args) => {
          const gitArgs = args.slice(2).join(" ");
          if (gitArgs === "rev-parse --is-inside-work-tree") return { stdout: "true\n", stderr: "", exitCode: 0 };
          if (gitArgs === "branch --show-current") return { stdout: "main\n", stderr: "", exitCode: 0 };
          if (gitArgs === "rev-parse HEAD") return { stdout: "abc123\n", stderr: "", exitCode: 0 };
          if (gitArgs === "status --short") return { stdout: "", stderr: "", exitCode: 0 };
          if (gitArgs === "status --branch --short") return { stdout: "## main\n", stderr: "", exitCode: 0 };
          return { stdout: "", stderr: "", exitCode: 0 };
        },
        now: () => new Date("2026-10-10T00:00:00.000Z"),
        // No persist override → uses defaultPersist → atomicWriteFile
      }
    );

    const raw = await readFile(getWorkerJobPath("ATOMIC-INTEGRATION-001", dir), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.jobId).toBe("ATOMIC-INTEGRATION-001");
    expect(parsed.status).toBe("done");
    expect(state.jobId).toBe(parsed.jobId);

    // No temp files
    const { readdir: rd } = await import("fs/promises");
    const jobsDir = join(dir, "outputs", "worker", "jobs");
    const files = await rd(jobsDir);
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("persistWorkerStatus writes a complete parseable WorkerStatus to disk", async () => {
    const { persistWorkerStatus } = await import("../worker/host");
    const dir = await makeTempDir();
    const statusPath = join(dir, "worker-status.json");

    const fakeStatus = {
      workerId: "test-worker",
      hostname: "localhost",
      status: "online" as const,
      platform: "darwin" as NodeJS.Platform,
      arch: "arm64",
      nodeVersion: process.version,
      cwd: dir,
      resources: { cpuCount: 8, totalMemoryMb: 16384, freeMemoryMb: 8192 },
      workspace: { root: dir, available: true },
      tools: [],
      ollama: { available: false, reachable: false, endpoint: "http://localhost:11434", activeModel: "", installedModels: [] },
      startedAt: new Date().toISOString(),
      lastHeartbeatAt: new Date().toISOString(),
    };

    await persistWorkerStatus(fakeStatus, statusPath);

    const parsed = JSON.parse(await readFile(statusPath, "utf8"));
    expect(parsed.workerId).toBe("test-worker");
    expect(parsed.status).toBe("online");

    // No temp files
    const files = await readdir(dir);
    expect(files.filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});
