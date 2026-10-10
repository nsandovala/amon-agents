import { execFile as execFileCallback } from "child_process";
import { existsSync as defaultExistsSync } from "fs";
import { atomicWriteFile } from "../utils/fs-helpers";
import { arch as osArch, cpus, freemem, hostname as osHostname, platform as osPlatform, totalmem } from "os";
import { dirname, join, resolve } from "path";
import { WorkerOllamaStatus, WorkerStatus, WorkerToolStatus, WorkerWorkspace } from "./types";

const TOOL_NAMES = ["git", "gh", "node", "npm", "python3", "ollama", "opencode", "codex", "claude"] as const;
const DEFAULT_HEARTBEAT_MS = 5000;
const TOOL_TIMEOUT_MS = 2000;
const OLLAMA_TIMEOUT_MS = 3000;

export type WorkerToolName = (typeof TOOL_NAMES)[number];

export interface ExecFileResult {
  stdout: string;
  stderr: string;
}

export type ExecFileFn = (
  command: string,
  args: string[],
  options: { timeout: number }
) => Promise<ExecFileResult>;

export interface WorkerDetectionDeps {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  existsSync?: (path: string) => boolean;
  execFile?: ExecFileFn;
  fetchFn?: typeof fetch;
  hostname?: () => string;
  platform?: NodeJS.Platform;
  arch?: string;
  nodeVersion?: string;
  cpuCount?: number;
  totalMemoryBytes?: number;
  freeMemoryBytes?: number;
  now?: () => Date;
}

export interface WorkerHeartbeatOptions {
  intervalMs?: number;
  statusPath?: string;
  now?: () => Date;
  persist?: (status: WorkerStatus, statusPath: string) => Promise<void>;
  emit?: (type: "worker.started" | "worker.heartbeat" | "worker.stopped", status: WorkerStatus) => Promise<void>;
  setIntervalFn?: typeof setInterval;
  clearIntervalFn?: typeof clearInterval;
}

function defaultExecFile(command: string, args: string[], options: { timeout: number }): Promise<ExecFileResult> {
  return new Promise((resolvePromise, reject) => {
    execFileCallback(
      command,
      args,
      {
        encoding: "utf8",
        timeout: options.timeout,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) {
          reject(err);
          return;
        }
        resolvePromise({ stdout: stdout ?? "", stderr: stderr ?? "" });
      }
    );
  });
}

function firstLine(text: string): string | undefined {
  const line = text.split(/\r?\n/).map((v) => v.trim()).find(Boolean);
  return line && line.length > 0 ? line : undefined;
}

function safeIdPart(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

function mb(bytes: number): number {
  return Math.round(bytes / 1024 / 1024);
}

export function parseHeartbeatMs(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.AMON_WORKER_HEARTBEAT_MS?.trim();
  if (!raw) return DEFAULT_HEARTBEAT_MS;
  if (!/^\d+$/.test(raw)) return DEFAULT_HEARTBEAT_MS;
  const parsed = Number.parseInt(raw, 10);
  return parsed > 0 ? parsed : DEFAULT_HEARTBEAT_MS;
}

export function getWorkerStatusPath(cwd = process.cwd()): string {
  return join(cwd, "outputs", "worker", "worker-status.json");
}

export function resolveWorkspaceRoot(deps: Pick<WorkerDetectionDeps, "env" | "cwd" | "existsSync"> = {}): WorkerWorkspace {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const existsSync = deps.existsSync ?? defaultExistsSync;
  const explicit = env.AMON_WORKSPACE_ROOT?.trim();

  if (explicit) {
    const root = resolve(cwd, explicit);
    return { root, available: existsSync(root) };
  }

  const preferred = "/Volumes/AMON-DEV";
  if (existsSync(preferred)) {
    return { root: preferred, available: true };
  }

  const parent = dirname(cwd);
  if (parent && parent !== cwd && existsSync(parent)) {
    return { root: parent, available: true };
  }

  if (existsSync(cwd)) {
    return { root: cwd, available: true };
  }

  return { root: null, available: false };
}

export function getWorkerId(options: { env?: NodeJS.ProcessEnv; hostname: string; platform: string; arch: string }): string {
  const explicit = options.env?.AMON_WORKER_ID?.trim();
  if (explicit) return safeIdPart(explicit) || explicit;

  const parts = [options.hostname, options.platform, options.arch]
    .map(safeIdPart)
    .filter(Boolean);

  return parts.length > 0 ? parts.join("-") : "amon-worker";
}

function versionArgsFor(name: WorkerToolName): string[] {
  switch (name) {
    case "git":
    case "gh":
    case "node":
    case "npm":
    case "python3":
    case "ollama":
    case "opencode":
    case "codex":
    case "claude":
      return ["--version"];
  }
}

async function detectTool(name: WorkerToolName, deps: Required<Pick<WorkerDetectionDeps, "execFile">> & Pick<WorkerDetectionDeps, "platform">): Promise<WorkerToolStatus> {
  const locator = deps.platform === "win32" ? "where.exe" : "which";
  const pathArgs = deps.platform === "win32" ? [name] : [name];
  let toolPath: string | undefined;
  let version: string | undefined;

  try {
    const result = await deps.execFile(locator, pathArgs, { timeout: TOOL_TIMEOUT_MS });
    toolPath = firstLine(result.stdout) ?? firstLine(result.stderr);
  } catch {
    // Missing tools are expected on developer machines.
  }

  try {
    const result = await deps.execFile(name, versionArgsFor(name), { timeout: TOOL_TIMEOUT_MS });
    version = firstLine(`${result.stdout}\n${result.stderr}`);
  } catch {
    // Version probes are best-effort only.
  }

  return {
    name,
    available: Boolean(toolPath || version),
    ...(version ? { version } : {}),
    ...(toolPath ? { path: toolPath } : {}),
  };
}

export async function detectTools(deps: WorkerDetectionDeps = {}): Promise<WorkerToolStatus[]> {
  const execFile = deps.execFile ?? defaultExecFile;
  return Promise.all(
    TOOL_NAMES.map((name) => detectTool(name, { execFile, platform: deps.platform ?? osPlatform() }))
  );
}

function getActiveOllamaModel(env: NodeJS.ProcessEnv): string {
  return env.OLLAMA_MODEL || env.AMON_AGENTS_MODEL || "llama3";
}

async function fetchJsonWithTimeout(fetchFn: typeof fetch, url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), OLLAMA_TIMEOUT_MS);
  try {
    const response = await fetchFn(url, { method: "GET", signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

export async function detectOllamaStatus(options: {
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  tool?: WorkerToolStatus;
}): Promise<WorkerOllamaStatus> {
  const env = options.env ?? process.env;
  const endpoint = (env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");
  const activeModel = getActiveOllamaModel(env);
  const available = options.tool?.available ?? false;

  if (!available) {
    return {
      available: false,
      reachable: false,
      endpoint,
      activeModel,
      installedModels: [],
      detail: "ollama CLI not available",
    };
  }

  try {
    const data = (await fetchJsonWithTimeout(options.fetchFn ?? fetch, `${endpoint}/api/tags`)) as {
      models?: Array<{ name?: string }>;
    };
    const installedModels = (data.models ?? [])
      .map((model) => model.name)
      .filter((name): name is string => Boolean(name));

    return {
      available: true,
      reachable: true,
      endpoint,
      activeModel,
      installedModels,
    };
  } catch (err) {
    return {
      available: true,
      reachable: false,
      endpoint,
      activeModel,
      installedModels: [],
      detail: (err as Error).message || "ollama unreachable",
    };
  }
}

export async function buildWorkerStatus(deps: WorkerDetectionDeps = {}): Promise<WorkerStatus> {
  const env = deps.env ?? process.env;
  const cwd = deps.cwd ?? process.cwd();
  const hostname = deps.hostname ? deps.hostname() : osHostname();
  const platform = deps.platform ?? osPlatform();
  const arch = deps.arch ?? osArch();
  const now = deps.now ?? (() => new Date());
  const startedAt = now().toISOString();
  const tools = await detectTools(deps);
  const ollamaTool = tools.find((tool) => tool.name === "ollama");
  const ollama = await detectOllamaStatus({ env, fetchFn: deps.fetchFn, tool: ollamaTool });

  return {
    workerId: getWorkerId({ env, hostname, platform, arch }),
    hostname,
    status: "online",
    platform,
    arch,
    nodeVersion: deps.nodeVersion ?? process.version,
    cwd,
    resources: {
      cpuCount: deps.cpuCount ?? cpus().length,
      totalMemoryMb: mb(deps.totalMemoryBytes ?? totalmem()),
      freeMemoryMb: mb(deps.freeMemoryBytes ?? freemem()),
    },
    workspace: resolveWorkspaceRoot({ env, cwd, existsSync: deps.existsSync }),
    tools,
    ollama,
    startedAt,
    lastHeartbeatAt: startedAt,
  };
}

export async function persistWorkerStatus(status: WorkerStatus, statusPath = getWorkerStatusPath()): Promise<void> {
  await atomicWriteFile(statusPath, `${JSON.stringify(status, null, 2)}\n`);
}

export function formatWorkerSummary(status: WorkerStatus): string {
  const tool = (name: string): string => {
    const found = status.tools.find((item) => item.name === name);
    return found?.available ? "available" : "unavailable";
  };

  const lines = [
    "",
    "  AMON Worker",
    "  ────────────────────────",
    `  ${"Worker:".padEnd(12)}${status.workerId}`,
    `  ${"Status:".padEnd(12)}${status.status}`,
    `  ${"Workspace:".padEnd(12)}${status.workspace.root ?? "unavailable"}${status.workspace.available ? "" : " (unavailable)"}`,
    "",
    `  ${"Git:".padEnd(12)}${tool("git")}`,
    `  ${"OpenCode:".padEnd(12)}${tool("opencode")}`,
    `  ${"Codex:".padEnd(12)}${tool("codex")}`,
    `  ${"Claude:".padEnd(12)}${tool("claude")}`,
    `  ${"Ollama:".padEnd(12)}${status.ollama.reachable ? "reachable" : status.ollama.available ? "unreachable" : "unavailable"}`,
    `  ${"Model:".padEnd(12)}${status.ollama.activeModel}`,
    "  ────────────────────────",
    `  Snapshot:   ${getWorkerStatusPath(status.cwd)}`,
    "",
  ];

  return `${lines.join("\n")}\n`;
}

export class WorkerHeartbeat {
  private readonly intervalMs: number;
  private readonly statusPath: string;
  private readonly now: () => Date;
  private readonly persist: (status: WorkerStatus, statusPath: string) => Promise<void>;
  private readonly emit?: WorkerHeartbeatOptions["emit"];
  private readonly setIntervalFn: typeof setInterval;
  private readonly clearIntervalFn: typeof clearInterval;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly status: WorkerStatus, options: WorkerHeartbeatOptions = {}) {
    this.intervalMs = options.intervalMs ?? DEFAULT_HEARTBEAT_MS;
    this.statusPath = options.statusPath ?? getWorkerStatusPath(status.cwd);
    this.now = options.now ?? (() => new Date());
    this.persist = options.persist ?? persistWorkerStatus;
    this.emit = options.emit;
    this.setIntervalFn = options.setIntervalFn ?? setInterval;
    this.clearIntervalFn = options.clearIntervalFn ?? clearInterval;
  }

  getStatus(): WorkerStatus {
    return this.status;
  }

  async start(): Promise<void> {
    await this.persist(this.status, this.statusPath);
    await this.emit?.("worker.started", this.status);
    this.timer = this.setIntervalFn(() => {
      void this.heartbeat();
    }, this.intervalMs);
  }

  async heartbeat(): Promise<void> {
    if (this.stopped) return;
    this.status.status = "online";
    this.status.lastHeartbeatAt = this.now().toISOString();
    await this.persist(this.status, this.statusPath);
    await this.emit?.("worker.heartbeat", this.status);
  }

  async stop(): Promise<WorkerStatus> {
    if (this.stopped) return this.status;
    this.stopped = true;
    if (this.timer) {
      this.clearIntervalFn(this.timer);
      this.timer = null;
    }
    this.status.status = "offline";
    this.status.lastHeartbeatAt = this.now().toISOString();
    await this.persist(this.status, this.statusPath);
    await this.emit?.("worker.stopped", this.status);
    return this.status;
  }
}
