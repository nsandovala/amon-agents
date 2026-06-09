/**
 * Comando `amon status`.
 *
 * Reporta el estado operacional del runtime AA en una sola foto:
 *   - provider activo
 *   - modelo activo
 *   - Ollama reachable (si aplica)
 *   - SB reachable (HEAD a SENTINEL_BOARD_API_URL)
 *   - push enabled/disabled
 *   - resumen de ejecuciones (del event stream)
 *   - último unified board json (outputs/sentinel/*.json)
 *   - ruta del event stream NDJSON
 *   - posible conflicto de PATH del binario `amon`
 *
 * Solo lectura: no toca outputs salvo a través del emitter (command.*).
 */
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { resolve } from "path";
import { getActiveModel, getActiveProvider } from "../llm/call-llm";
import {
  getEventsPath,
  isEventsEnabled,
} from "../events/event-emitter";
import {
  lastJsonLine,
  newestFile,
  tailLines,
} from "../utils/fs-helpers";
import { info, warn } from "../utils/logger";

interface LastRunInfo {
  runId: string | null;
  ts: string | null;
  command: string | null;
  level: string | null;
  found: boolean;
}

interface LastBoardInfo {
  path: string | null;
  mtime: string | null;
  found: boolean;
}

interface ReachableInfo {
  reachable: boolean | "n/a";
  detail: string;
}

interface RuntimeSummary {
  totalRuns: number;
  last5: { runId: string; status: string; score?: number; durationMs?: number }[];
  lastRunStatus: "running" | "done" | "error" | "unknown";
  lastRunScore?: number;
  lastRunDurationMs?: number;
  recentErrors: number;
  avgDurationLast5Ms?: number;
}

interface StatusReport {
  provider: string;
  model: string;
  pushEnabled: boolean;
  sbApiUrl: string;
  sbReachable: ReachableInfo;
  ollama: { configuredUrl: string; reachable: boolean | "n/a"; detail: string };
  eventStream: { path: string; enabled: boolean; exists: boolean };
  lastRun: LastRunInfo;
  runtimeSummary: RuntimeSummary;
  lastBoard: LastBoardInfo;
  cliPath: string;
  pathConflict: boolean;
}

const HEALTH_TIMEOUT_MS = 3000;

async function pingOllama(baseUrl: string): Promise<{ reachable: boolean; detail: string }> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/tags`;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    if (res.ok) {
      return { reachable: true, detail: `HTTP ${res.status} desde ${url}` };
    }
    return { reachable: false, detail: `HTTP ${res.status} desde ${url}` };
  } catch (err) {
    const msg = (err as Error).message || "error desconocido";
    return { reachable: false, detail: `${msg} (${url})` };
  } finally {
    clearTimeout(id);
  }
}

async function pingSB(baseUrl: string): Promise<ReachableInfo> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/projects`;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(url, { method: "GET", signal: controller.signal });
    if (res.ok) return { reachable: true, detail: `HTTP ${res.status} desde ${url}` };
    if (res.status === 403) {
      return {
        reachable: true,
        detail: `HTTP 403 (alcanzable, requiere SENTINEL_BOARD_AGENT_TOKEN) desde ${url}`,
      };
    }
    return { reachable: false, detail: `HTTP ${res.status} desde ${url}` };
  } catch (err) {
    const msg = (err as Error).message || "error desconocido";
    return { reachable: false, detail: `${msg} (${url})` };
  } finally {
    clearTimeout(id);
  }
}

function detectPathConflict(execPath: string): boolean {
  return !(
    execPath.includes("amon-agents") ||
    execPath.includes("amon.ts") ||
    execPath.includes("amon.js")
  );
}

interface EventLine {
  id?: string;
  ts?: string;
  runId?: string;
  type?: string;
  level?: string;
  payload?: { command?: string; score?: number };
}

async function readLastRun(eventsPath: string): Promise<LastRunInfo> {
  if (!existsSync(eventsPath)) {
    return { runId: null, ts: null, command: null, level: null, found: false };
  }
  // Buscamos el último command.done|command.error para reflejar "última ejecución cerrada".
  const lines = await tailLines(eventsPath, 200);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const ev = JSON.parse(lines[i]) as EventLine;
      if (ev.type === "command.done" || ev.type === "command.error") {
        return {
          runId: ev.runId ?? null,
          ts: ev.ts ?? null,
          command: ev.payload?.command ?? null,
          level: ev.level ?? null,
          found: true,
        };
      }
    } catch {
      continue;
    }
  }
  // Fallback: cualquier última línea válida
  const last = await lastJsonLine<EventLine>(eventsPath);
  if (last) {
    return {
      runId: last.runId ?? null,
      ts: last.ts ?? null,
      command: last.payload?.command ?? last.type ?? null,
      level: last.level ?? null,
      found: true,
    };
  }
  return { runId: null, ts: null, command: null, level: null, found: false };
}

async function parseEventsToRuns(eventsPath: string): Promise<Map<string, { runId: string; startedAt?: string; endedAt?: string; status: "running" | "done" | "error"; score?: number }>> {
  const runs = new Map<string, { runId: string; startedAt?: string; endedAt?: string; status: "running" | "done" | "error"; score?: number }>();

  if (!existsSync(eventsPath)) return runs;

  let raw: string;
  try {
    raw = await readFile(eventsPath, "utf8");
  } catch {
    return runs;
  }

  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);

  for (const line of lines) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }

    const runId = String(ev.runId ?? "");
    if (!runId) continue;

    const type = String(ev.type ?? "");
    const existing = runs.get(runId);

    if (type === "run.started") {
      const r = existing ?? { runId, status: "running" as const };
      r.startedAt = String(ev.ts ?? "");
      runs.set(runId, r);
    } else if (type === "run.done") {
      const r = existing ?? { runId, status: "done" as const };
      r.endedAt = String(ev.ts ?? "");
      const level = String(ev.level ?? "info");
      r.status = level === "error" ? "error" : "done";
      const payload = ev.payload as Record<string, unknown> | undefined;
      if (payload && typeof payload.score === "number") {
        r.score = payload.score;
      }
      runs.set(runId, r);
    } else if (type === "run.error" || type === "command.error") {
      const r = existing ?? { runId, status: "error" as const };
      r.endedAt = String(ev.ts ?? r.endedAt ?? "");
      r.status = "error";
      runs.set(runId, r);
    }
  }

  return runs;
}

async function computeRuntimeSummary(eventsPath: string): Promise<RuntimeSummary> {
  const runs = await parseEventsToRuns(eventsPath);

  if (runs.size === 0) {
    return {
      totalRuns: 0,
      last5: [],
      lastRunStatus: "unknown",
      recentErrors: 0,
    };
  }

  const all = Array.from(runs.values()).sort((a, b) => {
    const aTime = a.startedAt ? new Date(a.startedAt).getTime() : 0;
    const bTime = b.startedAt ? new Date(b.startedAt).getTime() : 0;
    return bTime - aTime;
  });

  const last5 = all.slice(0, 5);
  const last = all[0];

  const lastRunDurationMs = (() => {
    if (!last.startedAt || !last.endedAt) return undefined;
    const ms = new Date(last.endedAt).getTime() - new Date(last.startedAt).getTime();
    return Number.isNaN(ms) ? undefined : ms;
  })();

  const durations = last5
    .filter((r) => r.startedAt && r.endedAt)
    .map((r) => {
      const ms = new Date(r.endedAt!).getTime() - new Date(r.startedAt!).getTime();
      return Number.isNaN(ms) ? undefined : ms;
    })
    .filter((ms): ms is number => ms !== undefined);

  const avgDurationLast5Ms = durations.length > 0
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : undefined;

  const recentErrors = all.filter((r) => r.status === "error").length;

  return {
    totalRuns: runs.size,
    last5: last5.map((r) => ({
      runId: r.runId.length > 8 ? r.runId.slice(0, 8) : r.runId,
      status: r.status,
      score: r.score,
      durationMs: (() => {
        if (!r.startedAt || !r.endedAt) return undefined;
        const ms = new Date(r.endedAt).getTime() - new Date(r.startedAt).getTime();
        return Number.isNaN(ms) ? undefined : ms;
      })(),
    })),
    lastRunStatus: last.status,
    lastRunScore: last.score,
    lastRunDurationMs,
    recentErrors,
    avgDurationLast5Ms,
  };
}

async function readLastUnifiedBoard(): Promise<LastBoardInfo> {
  const dir = resolve(process.cwd(), "outputs", "sentinel");
  const newest = await newestFile(dir);
  if (!newest) return { path: null, mtime: null, found: false };
  return { path: newest.path, mtime: newest.mtime.toISOString(), found: true };
}

async function buildReport(): Promise<StatusReport> {
  const provider = getActiveProvider();
  const model = getActiveModel();
  const pushEnabled = process.env.AMON_AGENTS_PUSH_TO_SB === "true";
  const sbApiUrl = (process.env.SENTINEL_BOARD_API_URL ?? "http://localhost:3000").replace(
    /\/$/,
    ""
  );
  const ollamaUrl = (process.env.OLLAMA_BASE_URL ?? "http://localhost:11434").replace(/\/$/, "");

  let ollama: StatusReport["ollama"];
  if (provider === "ollama") {
    const ping = await pingOllama(ollamaUrl);
    ollama = { configuredUrl: ollamaUrl, reachable: ping.reachable, detail: ping.detail };
  } else {
    ollama = {
      configuredUrl: ollamaUrl,
      reachable: "n/a",
      detail: `provider activo es ${provider}; no se ejecutó health-check`,
    };
  }

  const sbReachable = await pingSB(sbApiUrl);

  const eventsPath = getEventsPath();
  const eventStream = {
    path: eventsPath,
    enabled: isEventsEnabled(),
    exists: existsSync(eventsPath),
  };

  const [lastRun, lastBoard] = await Promise.all([
    readLastRun(eventsPath),
    readLastUnifiedBoard(),
  ]);

  const runtimeSummary = await computeRuntimeSummary(eventsPath);

  const cliPath = process.argv[1] ?? "(desconocido)";
  const pathConflict = detectPathConflict(cliPath);

  return {
    provider,
    model,
    pushEnabled,
    sbApiUrl,
    sbReachable,
    ollama,
    eventStream,
    lastRun,
    runtimeSummary,
    lastBoard,
    cliPath,
    pathConflict,
  };
}

function pad(label: string, width: number): string {
  return label.length >= width ? label : label + " ".repeat(width - label.length);
}

function formatReachable(value: boolean | "n/a"): string {
  if (value === "n/a") return "n/a";
  return value ? "reachable" : "unreachable";
}

function formatDuration(ms?: number): string {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function printReport(report: StatusReport): void {
  const lines: string[] = [
    "",
    "  AMON CLI · status",
    "  ─────────────────────────────────",
    `  ${pad("Provider:", 18)}${report.provider}`,
    `  ${pad("Model:", 18)}${report.model}`,
    `  ${pad("Push to SB:", 18)}${report.pushEnabled ? "enabled" : "disabled"}`,
    `  ${pad("SB API URL:", 18)}${report.sbApiUrl}`,
    `  ${pad("SB reachable:", 18)}${formatReachable(report.sbReachable.reachable)}  (${report.sbReachable.detail})`,
    `  ${pad("Ollama URL:", 18)}${report.ollama.configuredUrl}`,
    `  ${pad("Ollama:", 18)}${formatReachable(report.ollama.reachable)}  (${report.ollama.detail})`,
    "  ─────────────────────────────────",
    `  ${pad("Event stream:", 18)}${report.eventStream.path}`,
    `  ${pad("  enabled:", 18)}${report.eventStream.enabled ? "yes" : "no"}`,
    `  ${pad("  exists:", 18)}${report.eventStream.exists ? "yes" : "no (se creará en el primer evento)"}`,
    "  ─────────────────────────────────",
  ];

  const rs = report.runtimeSummary;
  if (rs.totalRuns > 0) {
    lines.push(`  ${pad("Total runs:", 18)}${rs.totalRuns}`);
    lines.push(`  ${pad("Last run status:", 18)}${rs.lastRunStatus}`);
    if (rs.lastRunScore !== undefined) {
      lines.push(`  ${pad("Last run score:", 18)}${rs.lastRunScore}`);
    }
    if (rs.lastRunDurationMs !== undefined) {
      lines.push(`  ${pad("Last run duration:", 18)}${formatDuration(rs.lastRunDurationMs)}`);
    }
    lines.push(`  ${pad("Recent errors:", 18)}${rs.recentErrors}`);
    if (rs.avgDurationLast5Ms !== undefined) {
      lines.push(`  ${pad("Avg duration (5):", 18)}${formatDuration(rs.avgDurationLast5Ms)}`);
    }

    lines.push("");
    lines.push("  Last 5 runs:");
    lines.push("  ─────────────────────────────────");
    for (const r of rs.last5) {
      const scoreStr = r.score !== undefined ? ` · score ${r.score}` : "";
      const durStr = r.durationMs !== undefined ? ` · ${formatDuration(r.durationMs)}` : "";
      lines.push(`    ${r.runId} · ${r.status}${scoreStr}${durStr}`);
    }
  } else {
    lines.push(`  ${pad("Runs:", 18)}(sin ejecuciones registradas)`);
  }

  lines.push("  ─────────────────────────────────");

  if (report.lastRun.found) {
    lines.push(`  ${pad("Last run (old):", 18)}${report.lastRun.command ?? "—"} · ${report.lastRun.level ?? "—"} · ${report.lastRun.ts ?? "—"}`);
    lines.push(`  ${pad("  runId:", 18)}${report.lastRun.runId ?? "—"}`);
  }

  if (report.lastBoard.found) {
    lines.push(`  ${pad("Last unified:", 18)}${report.lastBoard.path}`);
    lines.push(`  ${pad("  mtime:", 18)}${report.lastBoard.mtime}`);
  } else {
    lines.push(`  ${pad("Last unified:", 18)}(sin unified board json generado todavía)`);
  }

  lines.push("  ─────────────────────────────────");
  lines.push(`  ${pad("CLI path:", 18)}${report.cliPath}`);

  if (report.pathConflict) {
    lines.push("");
    lines.push("  ⚠  CONFLICTO DE PATH DETECTADO");
    lines.push(`     El binario ejecutado (${report.cliPath}) no pertenece a amon-agents.`);
    lines.push("     Es posible que otro CLI \"amon\" tenga prioridad en PATH.");
    lines.push("     Recomendación: usá \"amon-agents\" o \"npm run amon -- ...\".");
  }

  lines.push("");

  for (const line of lines) {
    process.stdout.write(line + "\n");
  }
}

export async function statusCommand(): Promise<number> {
  const report = await buildReport();
  printReport(report);

  if (report.pathConflict) {
    warn("[amon status] Conflicto de PATH detectado — CLI ejecutado: " + report.cliPath);
  }

  info("[amon status] Reporte emitido.");
  return 0;
}
