/**
 * Comando `amon status`.
 *
 * Reporta el estado operacional del runtime AA en una sola foto:
 *   - provider activo
 *   - modelo activo
 *   - Ollama reachable (si aplica)
 *   - SB reachable (HEAD a SENTINEL_BOARD_API_URL)
 *   - push enabled/disabled
 *   - última ejecución (parseada del event stream)
 *   - último unified board json (outputs/sentinel/*.json)
 *   - ruta del event stream NDJSON
 *   - posible conflicto de PATH del binario `amon`
 *
 * Solo lectura: no toca outputs salvo a través del emitter (command.*).
 */
import { existsSync } from "fs";
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

interface StatusReport {
  provider: string;
  model: string;
  pushEnabled: boolean;
  sbApiUrl: string;
  sbReachable: ReachableInfo;
  ollama: { configuredUrl: string; reachable: boolean | "n/a"; detail: string };
  eventStream: { path: string; enabled: boolean; exists: boolean };
  lastRun: LastRunInfo;
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
  payload?: { command?: string };
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

  if (report.lastRun.found) {
    lines.push(`  ${pad("Last run:", 18)}${report.lastRun.command ?? "—"} · ${report.lastRun.level ?? "—"} · ${report.lastRun.ts ?? "—"}`);
    lines.push(`  ${pad("  runId:", 18)}${report.lastRun.runId ?? "—"}`);
  } else {
    lines.push(`  ${pad("Last run:", 18)}(sin ejecuciones registradas todavía)`);
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
