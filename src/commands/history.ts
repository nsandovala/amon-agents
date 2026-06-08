/**
 * Comando `amon history`.
 *
 * Lee el event stream NDJSON (outputs/events.jsonl) y muestra
 * un resumen de las últimas ejecuciones del pipeline.
 *
 * Uso:
 *   amon history
 *   amon history --limit 20
 */
import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { ParsedArgs } from "../cli/parse-args";
import { getEventsPath } from "../events/event-emitter";
import { info, warn } from "../utils/logger";

interface RunSummary {
  runId: string;
  taskId?: string;
  startedAt?: string;
  endedAt?: string;
  status: "running" | "done" | "error";
  score?: number;
}

function parseLimit(args: ParsedArgs): number {
  const raw = args.flags.limit;
  if (typeof raw === "string") {
    const n = parseInt(raw, 10);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return 10;
}

function truncateId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

function formatDate(ts?: string): string {
  if (!ts) return "—";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString("es-AR", {
    day: "2-digit",
    month: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDuration(start?: string, end?: string): string {
  if (!start || !end) return "—";
  const ms = new Date(end).getTime() - new Date(start).getTime();
  if (Number.isNaN(ms)) return "—";
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function renderTable(rows: RunSummary[]): void {
  if (rows.length === 0) {
    info("Sin ejecuciones registradas.");
    return;
  }

  const header = `Run ID      Task ID     Inicio              Estado  Score  Duración`;
  const line = "═══════════════════════════════════════════════════════════════════════";

  const out: string[] = [];
  out.push(`Últimas ${rows.length} ejecución(es)`);
  out.push(line);
  out.push(header);
  out.push(line.replace(/═/g, "─"));

  for (const r of rows) {
    const runShort = truncateId(r.runId);
    const taskShort = r.taskId ? truncateId(r.taskId) : "—";
    const startStr = formatDate(r.startedAt);
    const statusStr = r.status.padEnd(6);
    const scoreStr = r.score !== undefined ? String(r.score).padEnd(5) : "—    ";
    const durStr = formatDuration(r.startedAt, r.endedAt).padEnd(8);
    out.push(`${runShort.padEnd(11)} ${taskShort.padEnd(11)} ${startStr.padEnd(19)} ${statusStr} ${scoreStr} ${durStr}`);
  }

  out.push("");
  for (const s of out) {
    process.stdout.write(s + "\n");
  }
}

export async function historyCommand(args: ParsedArgs): Promise<number> {
  const limit = parseLimit(args);
  const eventsPath = getEventsPath();

  if (!existsSync(eventsPath)) {
    info(`[amon history] No se encontró el archivo de eventos: ${eventsPath}`);
    info('Ejecuta "amon run" primero para generar eventos.');
    return 0;
  }

  let raw: string;
  try {
    raw = await readFile(eventsPath, "utf8");
  } catch (e) {
    warn(`[amon history] No se pudo leer ${eventsPath}: ${(e as Error).message}`);
    return 1;
  }

  const lines = raw.split(/\r?\n/).filter((l) => l.trim().length > 0);
  if (lines.length === 0) {
    info("[amon history] Archivo de eventos vacío.");
    return 0;
  }

  const runs = new Map<string, RunSummary>();

  for (const line of lines) {
    let ev: Record<string, unknown>;
    try {
      ev = JSON.parse(line);
    } catch {
      // Ignorar líneas corruptas silenciosamente
      continue;
    }

    const runId = String(ev.runId ?? "");
    if (!runId) continue;

    const type = String(ev.type ?? "");
    const existing = runs.get(runId);

    if (type === "run.started") {
      const summary: RunSummary = existing ?? { runId, status: "running" };
      summary.startedAt = String(ev.ts ?? "");
      summary.taskId = String(ev.taskId ?? summary.taskId ?? "");
      runs.set(runId, summary);
    } else if (type === "run.done") {
      const summary: RunSummary = existing ?? { runId, status: "done" };
      summary.endedAt = String(ev.ts ?? "");
      summary.taskId = String(ev.taskId ?? summary.taskId ?? "");
      const level = String(ev.level ?? "info");
      summary.status = level === "error" ? "error" : "done";
      const payload = ev.payload as Record<string, unknown> | undefined;
      if (payload && typeof payload.score === "number") {
        summary.score = payload.score;
      }
      runs.set(runId, summary);
    } else if (type === "run.error" || type === "command.error") {
      const summary: RunSummary = existing ?? { runId, status: "error" };
      summary.endedAt = String(ev.ts ?? summary.endedAt ?? "");
      summary.status = "error";
      runs.set(runId, summary);
    }
  }

  // Ordenar por startedAt descendente, luego por endedAt, luego por runId
  const sorted = Array.from(runs.values()).sort((a, b) => {
    const aTime = a.startedAt ? new Date(a.startedAt).getTime() : 0;
    const bTime = b.startedAt ? new Date(b.startedAt).getTime() : 0;
    return bTime - aTime;
  });

  const limited = sorted.slice(0, limit);
  renderTable(limited);

  info(`[amon history] Total runs en archivo: ${runs.size}. Mostrando: ${limited.length}.`);
  return 0;
}
