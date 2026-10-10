import { describe, expect, it, vi } from "vitest";
import {
  buildWorkerStatus,
  detectOllamaStatus,
  detectTools,
  ExecFileFn,
  getWorkerId,
  resolveWorkspaceRoot,
  WorkerHeartbeat,
} from "./host";
import { WorkerStatus } from "./types";

function makeStatus(overrides: Partial<WorkerStatus> = {}): WorkerStatus {
  return {
    workerId: "test-host-darwin-arm64",
    hostname: "test-host",
    status: "online",
    platform: "darwin",
    arch: "arm64",
    nodeVersion: "v20.20.2",
    cwd: "/repo",
    resources: {
      cpuCount: 8,
      totalMemoryMb: 16384,
      freeMemoryMb: 4096,
    },
    workspace: {
      root: "/workspace",
      available: true,
    },
    tools: [],
    ollama: {
      available: false,
      reachable: false,
      endpoint: "http://localhost:11434",
      activeModel: "qwen2.5-coder:3b",
      installedModels: [],
    },
    startedAt: "2026-10-09T00:00:00.000Z",
    lastHeartbeatAt: "2026-10-09T00:00:00.000Z",
    ...overrides,
  };
}

describe("worker host", () => {
  it("resolves workspace root from AMON_WORKSPACE_ROOT override", () => {
    const workspace = resolveWorkspaceRoot({
      env: { AMON_WORKSPACE_ROOT: "/custom/workspace" } as NodeJS.ProcessEnv,
      cwd: "/repo",
      existsSync: (path) => path === "/custom/workspace",
    });

    expect(workspace).toEqual({ root: "/custom/workspace", available: true });
  });

  it("detects tools with mocked path and version probes", async () => {
    const execFile: ExecFileFn = async (command, args) => {
      if (command === "which" && args[0] === "git") {
        return { stdout: "/usr/bin/git\n", stderr: "" };
      }
      if (command === "git") {
        return { stdout: "git version 2.50.0\n", stderr: "" };
      }
      throw new Error("not found");
    };

    const tools = await detectTools({ platform: "darwin", execFile });
    const git = tools.find((tool) => tool.name === "git");
    const claude = tools.find((tool) => tool.name === "claude");

    expect(git).toMatchObject({
      name: "git",
      available: true,
      version: "git version 2.50.0",
      path: "/usr/bin/git",
    });
    expect(claude).toMatchObject({ name: "claude", available: false });
  });

  it("builds a structured worker snapshot", async () => {
    const execFile: ExecFileFn = async (command, args) => {
      if (command === "which") {
        return { stdout: `/usr/local/bin/${args[0]}\n`, stderr: "" };
      }
      return { stdout: `${command} version test\n`, stderr: "" };
    };
    const fetchFn = vi.fn(async () => new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder:3b" }] }), { status: 200 })) as unknown as typeof fetch;

    const status = await buildWorkerStatus({
      env: {
        AMON_WORKSPACE_ROOT: "/workspace",
        OLLAMA_MODEL: "qwen2.5-coder:3b",
      } as NodeJS.ProcessEnv,
      cwd: "/repo/amon-agents",
      existsSync: (path) => path === "/workspace",
      execFile,
      fetchFn,
      hostname: () => "Mac M1",
      platform: "darwin",
      arch: "arm64",
      nodeVersion: "v20.20.2",
      cpuCount: 8,
      totalMemoryBytes: 16 * 1024 * 1024 * 1024,
      freeMemoryBytes: 4 * 1024 * 1024 * 1024,
      now: () => new Date("2026-10-09T12:00:00.000Z"),
    });

    expect(status).toMatchObject({
      workerId: "mac-m1-darwin-arm64",
      hostname: "Mac M1",
      status: "online",
      platform: "darwin",
      arch: "arm64",
      nodeVersion: "v20.20.2",
      cwd: "/repo/amon-agents",
      resources: {
        cpuCount: 8,
        totalMemoryMb: 16384,
        freeMemoryMb: 4096,
      },
      workspace: {
        root: "/workspace",
        available: true,
      },
      ollama: {
        available: true,
        reachable: true,
        activeModel: "qwen2.5-coder:3b",
        installedModels: ["qwen2.5-coder:3b"],
      },
      startedAt: "2026-10-09T12:00:00.000Z",
      lastHeartbeatAt: "2026-10-09T12:00:00.000Z",
    });
    expect(status.tools).toHaveLength(9);
  });

  it("updates heartbeat timestamp and persists the snapshot", async () => {
    const persisted: WorkerStatus[] = [];
    const status = makeStatus();
    const heartbeat = new WorkerHeartbeat(status, {
      statusPath: "/tmp/worker-status.json",
      now: () => new Date("2026-10-09T00:00:05.000Z"),
      persist: async (snapshot) => {
        persisted.push({ ...snapshot });
      },
    });

    await heartbeat.heartbeat();

    expect(heartbeat.getStatus().lastHeartbeatAt).toBe("2026-10-09T00:00:05.000Z");
    expect(persisted.at(-1)?.lastHeartbeatAt).toBe("2026-10-09T00:00:05.000Z");
  });

  it("stops cleanly and marks worker offline", async () => {
    const persisted: WorkerStatus[] = [];
    const emitted: string[] = [];
    const clearIntervalFn = vi.fn() as unknown as typeof clearInterval;
    const setIntervalFn = vi.fn(() => 123 as unknown as ReturnType<typeof setInterval>) as unknown as typeof setInterval;
    const heartbeat = new WorkerHeartbeat(makeStatus(), {
      now: () => new Date("2026-10-09T00:00:10.000Z"),
      setIntervalFn,
      clearIntervalFn,
      persist: async (snapshot) => {
        persisted.push({ ...snapshot });
      },
      emit: async (type) => {
        emitted.push(type);
      },
    });

    await heartbeat.start();
    const stopped = await heartbeat.stop();

    expect(stopped.status).toBe("offline");
    expect(stopped.lastHeartbeatAt).toBe("2026-10-09T00:00:10.000Z");
    expect(clearIntervalFn).toHaveBeenCalled();
    expect(persisted.at(-1)?.status).toBe("offline");
    expect(emitted).toContain("worker.stopped");
  });

  it("keeps workerId stable for the same node inputs", () => {
    const input = {
      env: {} as NodeJS.ProcessEnv,
      hostname: "Mac M1",
      platform: "darwin",
      arch: "arm64",
    };

    expect(getWorkerId(input)).toBe(getWorkerId(input));
    expect(getWorkerId(input)).toBe("mac-m1-darwin-arm64");
  });

  it("does not break when Ollama is absent", async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;

    const ollama = await detectOllamaStatus({
      env: { OLLAMA_MODEL: "qwen2.5-coder:3b" } as NodeJS.ProcessEnv,
      tool: { name: "ollama", available: false },
      fetchFn,
    });

    expect(ollama).toMatchObject({
      available: false,
      reachable: false,
      activeModel: "qwen2.5-coder:3b",
      installedModels: [],
    });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
