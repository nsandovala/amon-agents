/**
 * Adaptador para Sentinel Board.
 * Transforma AgentResult al formato nativo de la API y lo envía vía POST /api/tasks.
 * Si el push falla, loguea el error pero NO bloquea el pipeline.
 *
 * Variables requeridas en .env.local:
 *   SENTINEL_BOARD_API_URL     — Base URL de la API  (ej: https://sentinel-board.vercel.app)
 *   SENTINEL_BOARD_AGENT_TOKEN — Bearer token de autenticación
 *   AMON_AGENTS_PUSH_TO_SB     — "true" para habilitar el push HTTP
 */
import { AgentResult, StandardOutput } from "../core/types";
import { info, warn } from "../utils/logger";

/* ──────────────────── Tipos ──────────────────── */

/** Representación interna normalizada de un resultado de agente. */
export interface SentinelBoardEntry {
  task_id: string;
  agent: string;
  task_type: string;
  status: "ok" | "warning" | "error";
  timestamp: string;
  summary: string;
  details: StandardOutput & Record<string, unknown>;
  validations_passed: boolean;
  errors?: string[];
}

/** Formato nativo que espera POST /api/tasks en Sentinel Board (legacy). */
export interface SBTask {
  title: string;
  description: string;
  status: "pending" | "in_progress" | "done" | "blocked";
  priority: "low" | "medium" | "high";
  agent_source: string;
  task_ref: string;
  task_type: string;
  files_to_touch: string[];
  plan_steps: string[];
  risks: string[];
  validations: string[];
  done_when: string[];
  metadata: {
    pushed_at: string;
    validations_passed: boolean;
    errors?: string[];
  };
}

/**
 * Payload del nuevo endpoint POST /api/agents/import.
 * Es el contrato canónico de ingesta desde amon-agents hacia Sentinel Board.
 */
export interface SBImportPayload {
  source: "amon-agents";
  externalTaskId: string;
  agent: string;
  title: string;
  description: string;
  priority: "low" | "medium" | "high" | "critical";
  status:
    | "idea_bruta"
    | "clarificando"
    | "validando"
    | "en_proceso"
    | "desarrollo"
    | "qa"
    | "listo"
    | "produccion"
    | "archivado";
  type:
    | "idea"
    | "feature"
    | "bug"
    | "task"
    | "decision"
    | "experiment"
    | "deploy"
    | "research";
  tags: string[];
  metadata: {
    plan: string[];
    risks: string[];
    validations: string[];
    done_when: string[];
    files_to_touch: string[];
    score: number;
  };
}

/* ──────────────────── Sanitización ──────────────────── */

function sanitizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function sanitizeScore(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.round(value)));
}

/* ──────────────────── Transformaciones ──────────────────── */

/** Adapta un AgentResult al formato intermedio SentinelBoardEntry. */
export function adaptToSentinelBoard<T extends StandardOutput>(
  result: AgentResult<T>
): SentinelBoardEntry {
  const status: SentinelBoardEntry["status"] = result.valid
    ? result.errors && result.errors.length > 0
      ? "warning"
      : "ok"
    : "error";

  return {
    task_id: result.taskId,
    agent: result.agent,
    task_type: result.taskType,
    status,
    timestamp: result.timestamp,
    summary: (result.output.goal || "Sin objetivo definido").slice(0, 200),
    details: result.output,
    validations_passed: result.valid,
    errors: result.errors,
  };
}

/** Serializa un SentinelBoardEntry para escritura en disco. */
export function serializeForBoard(entry: SentinelBoardEntry): string {
  return JSON.stringify(entry, null, 2);
}

/**
 * Mapea un SentinelBoardEntry al payload del endpoint canónico
 * POST /api/agents/import de Sentinel Board.
 */
export function mapAgentTaskToImportPayload(entry: SentinelBoardEntry): SBImportPayload {
  const priority: SBImportPayload["priority"] =
    entry.status === "error"
      ? "high"
      : entry.status === "warning"
        ? "medium"
        : "low";

  const cardType = mapTaskTypeToCardType(entry.task_type);

  const score = sanitizeScore(entry.details.score);

  return {
    source: "amon-agents",
    externalTaskId: entry.task_id,
    agent: entry.agent,
    title: `[${entry.agent.toUpperCase()}] ${entry.summary.slice(0, 80)}`,
    description: entry.summary,
    priority,
    status: "idea_bruta",
    type: cardType,
    tags: [`task-type:${entry.task_type}`],
    metadata: {
      plan: sanitizeStringArray(entry.details.plan),
      risks: sanitizeStringArray(entry.details.risks),
      validations: sanitizeStringArray(entry.details.validations),
      done_when: sanitizeStringArray(entry.details.done_when),
      files_to_touch: sanitizeStringArray(entry.details.files_to_touch),
      score,
    },
  };
}

function mapTaskTypeToCardType(taskType: string): SBImportPayload["type"] {
  switch (taskType) {
    case "feature_small":
    case "ui_change":
      return "feature";
    case "bugfix":
      return "bug";
    case "infra_change":
    case "security_check":
      return "task";
    case "research_task":
      return "research";
    default:
      return "task";
  }
}

/**
 * Mapea un SentinelBoardEntry al formato nativo legacy de POST /api/tasks.
 * Mantenido sólo por compatibilidad; preferir mapAgentTaskToImportPayload.
 */
export function mapAgentTaskToSBTask(entry: SentinelBoardEntry): SBTask {
  const statusMap: Record<SentinelBoardEntry["status"], SBTask["status"]> = {
    ok: "done",
    warning: "in_progress",
    error: "blocked",
  };

  const priority: SBTask["priority"] =
    entry.status === "error"
      ? "high"
      : entry.status === "warning"
        ? "medium"
        : "low";

  return {
    title: `[${entry.agent.toUpperCase()}] ${entry.summary.slice(0, 80)}`,
    description: entry.summary,
    status: statusMap[entry.status],
    priority,
    agent_source: entry.agent,
    task_ref: entry.task_id,
    task_type: entry.task_type,
    files_to_touch: (entry.details.files_to_touch as string[] | undefined) ?? [],
    plan_steps: (entry.details.plan as string[] | undefined) ?? [],
    risks: (entry.details.risks as string[] | undefined) ?? [],
    validations: (entry.details.validations as string[] | undefined) ?? [],
    done_when: (entry.details.done_when as string[] | undefined) ?? [],
    metadata: {
      pushed_at: new Date().toISOString(),
      validations_passed: entry.validations_passed,
      errors: entry.errors,
    },
  };
}

/* ──────────────────── Config interna ──────────────────── */

function getSentinelConfig(): { baseUrl: string; token: string } {
  const baseUrl = (
    process.env.SENTINEL_BOARD_API_URL ?? "http://localhost:3000"
  ).replace(/\/$/, "");
  const token = process.env.SENTINEL_BOARD_AGENT_TOKEN ?? "";
  return { baseUrl, token };
}

function isPushEnabled(): boolean {
  return process.env.AMON_AGENTS_PUSH_TO_SB === "true";
}

/* ──────────────────── Push HTTP ──────────────────── */

export interface SendTasksOptions {
  /**
   * Fuerza el push aunque AMON_AGENTS_PUSH_TO_SB no esté en "true".
   * Pensado para el comando explícito `amon push`.
   */
  force?: boolean;
}

/**
 * Envía múltiples tareas a Sentinel Board en requests secuenciales.
 * Respeta AMON_AGENTS_PUSH_TO_SB salvo que se pase { force: true }.
 * Nunca lanza — los errores se loguean y se continúa.
 */
export async function sendTasksToSentinelBoard(
  tasks: SentinelBoardEntry[],
  options: SendTasksOptions = {}
): Promise<void> {
  if (!options.force && !isPushEnabled()) {
    info("[SentinelBoard] Push deshabilitado (AMON_AGENTS_PUSH_TO_SB != true). Skipping.");
    return;
  }

  if (tasks.length === 0) return;

  const { baseUrl, token } = getSentinelConfig();
  const url = `${baseUrl}/api/agents/import`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  } else {
    warn("[SentinelBoard] SENTINEL_BOARD_AGENT_TOKEN no configurado. Enviando sin autenticación.");
  }

  info(`[SentinelBoard] Enviando ${tasks.length} tarea(s) a ${url}`);

  for (const entry of tasks) {
    const payload = mapAgentTaskToImportPayload(entry);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "<unreadable body>");
        warn(`[SentinelBoard] HTTP ${res.status} — tarea ${entry.task_id}: ${body}`);
        continue;
      }

      const data = (await res.json().catch(() => ({}))) as { taskId?: string };
      const created = data.taskId ?? "<unknown>";
      info(
        `[SentinelBoard] Tarea ${entry.task_id} (${entry.agent}) importada OK → ${created}`
      );
    } catch (err) {
      warn(
        `[SentinelBoard] Error de red al enviar tarea ${entry.task_id}: ${(err as Error).message}`
      );
    }
  }
}

/**
 * Envía una sola entrada. Thin wrapper sobre sendTasksToSentinelBoard.
 * Mantenido para compatibilidad con código existente.
 */
export async function pushToSentinelBoard(entry: SentinelBoardEntry): Promise<void> {
  return sendTasksToSentinelBoard([entry]);
}
