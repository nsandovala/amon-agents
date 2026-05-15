/**
 * Event emitter append-only para AMON Agents.
 *
 * Escribe eventos NDJSON (un JSON por línea) en disco — por defecto
 * en `~/.amon/events.jsonl`. La carpeta se crea on-demand.
 *
 * Reglas:
 *   1. Append-only. Nunca reescribe ni rota archivos.
 *   2. Fail-soft. Cualquier error se traga: el pipeline NUNCA se bloquea.
 *   3. Sanitiza payload para no escribir API keys, tokens, secrets, passwords.
 *   4. Opt-out vía AMON_EVENTS_ENABLED=false. Por defecto habilitado.
 *   5. Path configurable vía AMON_EVENTS_PATH (vacío → default).
 *
 * Variables de entorno:
 *   AMON_EVENTS_ENABLED  — "false" para deshabilitar; cualquier otro valor (o vacío) habilita.
 *   AMON_EVENTS_PATH     — Ruta absoluta al .jsonl. Si vacío, usa ~/.amon/events.jsonl.
 */
import { randomUUID } from "crypto";
import { appendFile, mkdir } from "fs/promises";
import { homedir } from "os";
import { dirname, join } from "path";
import { AmonEvent, AmonEventAgent } from "./types";

/* ──────────────────── Sanitización ──────────────────── */

const SECRET_KEY_PATTERNS: RegExp[] = [
  /api[_-]?key/i,
  /access[_-]?token/i,
  /auth[_-]?token/i,
  /\btoken\b/i,
  /\bsecret\b/i,
  /\bpassword\b/i,
  /authorization/i,
  /bearer/i,
  /private[_-]?key/i,
  /client[_-]?secret/i,
];

const SECRET_VALUE_PATTERNS: RegExp[] = [
  /^bearer\s+\S+/i,
  /^sk-[A-Za-z0-9_-]{16,}$/,
  /^ghp_[A-Za-z0-9]{20,}$/,
  /^gho_[A-Za-z0-9]{20,}$/,
  /^xox[bapsr]-[A-Za-z0-9-]{10,}$/,
  /^AIza[0-9A-Za-z_-]{30,}$/,
];

const REDACTED = "[REDACTED]";
const MAX_DEPTH = 6;
const MAX_STRING = 8 * 1024;

function isSensitiveKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((p) => p.test(key));
}

function looksLikeSecretValue(value: string): boolean {
  if (value.length < 12 || value.length > 400) return false;
  return SECRET_VALUE_PATTERNS.some((p) => p.test(value));
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > MAX_DEPTH) return "[MAX_DEPTH]";
  if (value === null || value === undefined) return value;

  if (typeof value === "string") {
    if (looksLikeSecretValue(value)) return REDACTED;
    return value.length > MAX_STRING
      ? value.slice(0, MAX_STRING) + "…[truncated]"
      : value;
  }

  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return value.toString();

  if (Array.isArray(value)) {
    return value.map((v) => sanitizeValue(v, depth + 1));
  }

  if (value instanceof Error) {
    return { name: value.name, message: value.message };
  }

  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSensitiveKey(k)) {
        out[k] = REDACTED;
        continue;
      }
      out[k] = sanitizeValue(v, depth + 1);
    }
    return out;
  }

  return String(value);
}

function sanitizePayload(
  payload?: Record<string, unknown>
): Record<string, unknown> | undefined {
  if (!payload) return undefined;
  return sanitizeValue(payload, 0) as Record<string, unknown>;
}

/* ──────────────────── Configuración ──────────────────── */

function isEnabled(): boolean {
  const v = process.env.AMON_EVENTS_ENABLED;
  if (v === undefined || v.trim() === "") return true;
  return v.trim().toLowerCase() !== "false";
}

function resolveEventsPath(): string {
  const explicit = process.env.AMON_EVENTS_PATH?.trim();
  if (explicit && explicit.length > 0) return explicit;
  return join(homedir(), ".amon", "events.jsonl");
}

/* ──────────────────── Escritura ──────────────────── */

const ensuredDirs = new Set<string>();

async function ensureDirOnce(filePath: string): Promise<void> {
  const dir = dirname(filePath);
  if (ensuredDirs.has(dir)) return;
  await mkdir(dir, { recursive: true });
  ensuredDirs.add(dir);
}

/**
 * Emite un evento al stream local.
 *
 * Genera `id` (UUID) y `ts` (ISO-8601). Sanitiza el payload.
 * Nunca lanza: si la escritura falla, el error se traga silenciosamente.
 */
export async function emitAmonEvent(
  event: Omit<AmonEvent, "id" | "ts">
): Promise<void> {
  try {
    if (!isEnabled()) return;

    const enriched: AmonEvent = {
      id: randomUUID(),
      ts: new Date().toISOString(),
      runId: event.runId,
      taskId: event.taskId,
      agent: event.agent,
      type: event.type,
      level: event.level,
      message: event.message,
      payload: sanitizePayload(event.payload),
      // Routing neutral — el emitter sólo se identifica como "amon-agents".
      // El resto de campos los puebla el caller cuando aplica (consumer,
      // context, projectSlug, workspaceSlug). NO acoplado a ningún consumer.
      source: event.source ?? "amon-agents",
      consumer: event.consumer,
      context: event.context,
      projectSlug: event.projectSlug,
      workspaceSlug: event.workspaceSlug,
    };

    const target = resolveEventsPath();
    await ensureDirOnce(target);
    await appendFile(target, JSON.stringify(enriched) + "\n", "utf8");
  } catch {
    // Fail-soft: el pipeline NUNCA debe romperse por el event emitter.
  }
}

/* ──────────────────── Helpers ──────────────────── */

/**
 * Genera un identificador único de ejecución.
 * Usado por `run.ts` y `run-agent.ts` para agrupar todos los eventos
 * emitidos durante una ejecución completa del pipeline.
 */
export function newRunId(): string {
  return randomUUID();
}

/**
 * Wrapper de conveniencia que emite `agent.started` antes de invocar
 * `fn`, y `agent.done` o `agent.error` al finalizar.
 *
 * Devuelve el resultado tal cual; relanza la excepción si la hay.
 * El emitter es fail-soft, así que no afecta el flujo del pipeline.
 */
export async function withAgentEvents<T>(
  ctx: { runId: string; taskId: string; agent: AmonEventAgent },
  fn: () => Promise<T>
): Promise<T> {
  await emitAmonEvent({
    runId: ctx.runId,
    taskId: ctx.taskId,
    agent: ctx.agent,
    type: "agent.started",
    level: "info",
    message: `${ctx.agent} iniciando`,
  });

  try {
    const result = await fn();
    const valid = (result as unknown as { valid?: boolean })?.valid;
    const errors = (result as unknown as { errors?: string[] })?.errors;
    await emitAmonEvent({
      runId: ctx.runId,
      taskId: ctx.taskId,
      agent: ctx.agent,
      type: "agent.done",
      level: valid === false ? "warn" : "info",
      message: `${ctx.agent} completado`,
      payload: {
        valid: valid ?? true,
        errors: errors ?? [],
      },
    });
    return result;
  } catch (err) {
    const e = err as Error;
    await emitAmonEvent({
      runId: ctx.runId,
      taskId: ctx.taskId,
      agent: ctx.agent,
      type: "agent.error",
      level: "error",
      message: e.message || "Error desconocido",
      payload: {
        name: e.name,
        stack: e.stack,
      },
    });
    throw err;
  }
}
