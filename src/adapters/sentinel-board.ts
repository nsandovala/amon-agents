/**
 * Adaptador para Sentinel Board.
 * Transforma AgentResult al formato nativo de la API y lo envía vía POST /api/agents/import.
 * Si el push falla, loguea el error pero NO bloquea el pipeline.
 *
 * Variables requeridas en .env.local:
 *   SENTINEL_BOARD_API_URL     — Base URL de la API  (ej: https://sentinel-board.vercel.app)
 *   SENTINEL_BOARD_AGENT_TOKEN — Bearer token de autenticación
 *   AMON_AGENTS_PUSH_TO_SB     — "true" para habilitar el push HTTP
 */
import { randomUUID } from "crypto";
import { AgentResult, StandardOutput } from "../core/types";
import { StateGuardianOutput } from "../agents/state-guardian";
import { ScorerOutput } from "../agents/scorer";
import { emitAmonEvent } from "../events/event-emitter";
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

/* ──────────────────── Unified card types ──────────────────── */

/** Comentario de un agente adjuntado a la card unificada. */
export interface AgentComment {
  agent: string;
  timestamp: string;
  body: string;
}

/** Evento de timeline de la ejecución. */
export interface TimelineEvent {
  agent: string;
  timestamp: string;
  event: string;
  status: "ok" | "warning" | "error";
}

/**
 * Payload unificado para POST /api/agents/import.
 * Una sola card por ejecución: Planner genera el cuerpo principal,
 * los demás agentes se pliegan como metadata, checklist, comments, timeline.
 */
export interface SBUnifiedImportPayload {
  source: "amon-agents";
  externalTaskId: string;
  agent: "amon-pipeline";
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
    state_guardian?: {
      verdict: string;
      violations: string[];
      valid: boolean;
    };
    qa_review?: {
      goal: string;
      validations: string[];
      risks: string[];
      valid: boolean;
    };
    scoring_detail?: {
      score: number;
      completeness: number;
      quality: number;
      coherence: number;
      reasoning: string;
    };
  };
  checklist: string[];
  comments: AgentComment[];
  timeline: TimelineEvent[];
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

/* ──────────────────── Unified Card Builder ──────────────────── */

/** Input para construir la card unificada a partir de los resultados de todos los agentes. */
export interface UnifiedCardInput {
  plannerResult: AgentResult;
  stateResult: AgentResult<StateGuardianOutput>;
  qaResult: AgentResult;
  scorerResult: AgentResult<ScorerOutput>;
}

/**
 * Construye un payload unificado para Sentinel Board.
 * El Planner define el cuerpo principal de la card.
 * State-Guardian, QA y Scorer se pliegan como metadata, checklist, comments, timeline.
 */
export function buildUnifiedPayload(input: UnifiedCardInput): SBUnifiedImportPayload {
  const { plannerResult, stateResult, qaResult, scorerResult } = input;
  const plannerOutput = plannerResult.output;
  const stateOutput = stateResult.output;
  const qaOutput = qaResult.output;
  const scorerOutput = scorerResult.output;

  // ── Priority: worst-case de todos los agentes ──
  const allValid = [plannerResult, stateResult, qaResult, scorerResult];
  const hasError = allValid.some((r) => !r.valid);
  const hasWarning = allValid.some(
    (r) => r.valid && r.errors && r.errors.length > 0
  );
  const priority: SBUnifiedImportPayload["priority"] = hasError
    ? "high"
    : hasWarning
      ? "medium"
      : "low";

  // ── Status basado en el verdict de State-Guardian ──
  const statusMap: Record<string, SBUnifiedImportPayload["status"]> = {
    APPROVED: "validando",
    NEEDS_REVIEW: "clarificando",
    BLOCKED: "idea_bruta",
  };
  const status = statusMap[stateOutput.verdict] ?? "idea_bruta";

  // ── Checklist: validaciones del QA + done_when del planner ──
  const checklist: string[] = [
    ...sanitizeStringArray(plannerOutput.done_when).map((d) => `[done_when] ${d}`),
    ...sanitizeStringArray(qaOutput.validations).map((v) => `[qa] ${v}`),
  ];

  // ── State-Guardian violations como checklist items ──
  if (stateOutput.violations && stateOutput.violations.length > 0) {
    for (const v of stateOutput.violations) {
      checklist.push(`[violation] ${v}`);
    }
  }

  // ── Comments: resúmenes de cada agente ──
  const comments: AgentComment[] = [];

  if (stateOutput.goal) {
    comments.push({
      agent: "state-guardian",
      timestamp: stateResult.timestamp,
      body: `Verdict: ${stateOutput.verdict}. ${stateOutput.goal}`,
    });
  }

  if (qaOutput.goal) {
    comments.push({
      agent: "qa-reviewer",
      timestamp: qaResult.timestamp,
      body: qaOutput.goal,
    });
  }

  if (scorerOutput.reasoning) {
    comments.push({
      agent: "scorer",
      timestamp: scorerResult.timestamp,
      body: `Score: ${scorerOutput.score}/100. ${scorerOutput.reasoning}`,
    });
  }

  // ── Timeline ──
  const timeline: TimelineEvent[] = [
    {
      agent: "planner",
      timestamp: plannerResult.timestamp,
      event: "Plan generado",
      status: plannerResult.valid ? "ok" : "error",
    },
    {
      agent: "state-guardian",
      timestamp: stateResult.timestamp,
      event: `Evaluación: ${stateOutput.verdict}`,
      status: stateResult.valid ? (stateOutput.verdict === "BLOCKED" ? "error" : "ok") : "error",
    },
    {
      agent: "qa-reviewer",
      timestamp: qaResult.timestamp,
      event: "Revisión QA completada",
      status: qaResult.valid ? "ok" : "error",
    },
    {
      agent: "scorer",
      timestamp: scorerResult.timestamp,
      event: `Score: ${sanitizeScore(scorerOutput.score)}/100`,
      status: scorerResult.valid ? "ok" : "error",
    },
  ];

  const cardType = mapTaskTypeToCardType(plannerResult.taskType);

  return {
    source: "amon-agents",
    externalTaskId: plannerResult.taskId,
    agent: "amon-pipeline",
    title: `[AMON] ${(plannerOutput.goal || "Sin objetivo").slice(0, 80)}`,
    description: plannerOutput.goal || "Sin objetivo definido",
    priority,
    status,
    type: cardType,
    tags: [
      `task-type:${plannerResult.taskType}`,
      `score:${sanitizeScore(scorerOutput.score)}`,
      `verdict:${stateOutput.verdict.toLowerCase()}`,
    ],
    metadata: {
      plan: sanitizeStringArray(plannerOutput.plan),
      risks: sanitizeStringArray(plannerOutput.risks),
      validations: sanitizeStringArray(plannerOutput.validations),
      done_when: sanitizeStringArray(plannerOutput.done_when),
      files_to_touch: sanitizeStringArray(plannerOutput.files_to_touch),
      score: sanitizeScore(scorerOutput.score),
      state_guardian: {
        verdict: stateOutput.verdict,
        violations: sanitizeStringArray(stateOutput.violations),
        valid: stateResult.valid,
      },
      qa_review: {
        goal: qaOutput.goal || "",
        validations: sanitizeStringArray(qaOutput.validations),
        risks: sanitizeStringArray(qaOutput.risks),
        valid: qaResult.valid,
      },
      scoring_detail: {
        score: sanitizeScore(scorerOutput.score),
        completeness: sanitizeScore(scorerOutput.completeness),
        quality: sanitizeScore(scorerOutput.quality),
        coherence: sanitizeScore(scorerOutput.coherence),
        reasoning: scorerOutput.reasoning || "",
      },
    },
    checklist,
    comments,
    timeline,
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
  /**
   * Identificador de la ejecución que originó el push.
   * Usado por el event emitter para correlacionar eventos `sb.push.*`
   * con el resto del pipeline. Si no se provee, se genera uno local.
   */
  runId?: string;
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

  const runId = options.runId ?? randomUUID();
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
    await emitAmonEvent({
      runId,
      taskId: entry.task_id,
      agent: "sentinel-board",
      consumer: "sentinel-board",
      type: "sb.push.started",
      level: "info",
      message: `Push iniciado para ${entry.task_id} (${entry.agent})`,
      payload: { url, force: !!options.force },
    });

    try {
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.text().catch(() => "<unreadable body>");
        warn(`[SentinelBoard] HTTP ${res.status} — tarea ${entry.task_id}: ${body}`);
        await emitAmonEvent({
          runId,
          taskId: entry.task_id,
          agent: "sentinel-board",
          consumer: "sentinel-board",
          type: "sb.push.error",
          level: "error",
          message: `HTTP ${res.status} al pushear ${entry.task_id}`,
          payload: { status: res.status, body: body.slice(0, 1024) },
        });
        continue;
      }

      const data = (await res.json().catch(() => ({}))) as { taskId?: string };
      const created = data.taskId ?? "<unknown>";
      info(
        `[SentinelBoard] Tarea ${entry.task_id} (${entry.agent}) importada OK → ${created}`
      );
      await emitAmonEvent({
        runId,
        taskId: entry.task_id,
        agent: "sentinel-board",
        consumer: "sentinel-board",
        type: "sb.push.done",
        level: "info",
        message: `Tarea ${entry.task_id} importada OK`,
        payload: { sbTaskId: created, agent: entry.agent },
      });
    } catch (err) {
      const message = (err as Error).message;
      warn(`[SentinelBoard] Error de red al enviar tarea ${entry.task_id}: ${message}`);
      await emitAmonEvent({
        runId,
        taskId: entry.task_id,
        agent: "sentinel-board",
        consumer: "sentinel-board",
        type: "sb.push.error",
        level: "error",
        message: `Error de red: ${message}`,
        payload: { name: (err as Error).name },
      });
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

/**
 * Envía una card unificada a Sentinel Board vía POST /api/agents/import.
 * El payload contiene toda la información de la ejecución consolidada.
 * Respeta AMON_AGENTS_PUSH_TO_SB salvo que se pase { force: true }.
 */
export async function sendUnifiedCardToSentinelBoard(
  payload: SBUnifiedImportPayload,
  options: SendTasksOptions = {}
): Promise<void> {
  const runId = options.runId ?? randomUUID();
  const taskId = payload.externalTaskId;

  if (!options.force && !isPushEnabled()) {
    info("[SentinelBoard] Push deshabilitado (AMON_AGENTS_PUSH_TO_SB != true). Skipping.");
    return;
  }

  const { baseUrl, token } = getSentinelConfig();
  const url = `${baseUrl}/api/agents/import`;

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  } else {
    warn("[SentinelBoard] SENTINEL_BOARD_AGENT_TOKEN no configurado. Enviando sin autenticación.");
  }

  info(`[SentinelBoard] Enviando card unificada para ${taskId} a ${url}`);

  await emitAmonEvent({
    runId,
    taskId,
    agent: "sentinel-board",
    consumer: "sentinel-board",
    type: "sb.push.started",
    level: "info",
    message: `Push unificado iniciado para ${taskId}`,
    payload: { url, force: !!options.force },
  });

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "<unreadable body>");
      warn(`[SentinelBoard] HTTP ${res.status} — tarea ${taskId}: ${body}`);
      await emitAmonEvent({
        runId,
        taskId,
        agent: "sentinel-board",
        consumer: "sentinel-board",
        type: "sb.push.error",
        level: "error",
        message: `HTTP ${res.status} al pushear ${taskId}`,
        payload: { status: res.status, body: body.slice(0, 1024) },
      });
      return;
    }

    const data = (await res.json().catch(() => ({}))) as { taskId?: string };
    const created = data.taskId ?? "<unknown>";
    info(
      `[SentinelBoard] Card unificada ${taskId} importada OK → ${created}`
    );
    await emitAmonEvent({
      runId,
      taskId,
      agent: "sentinel-board",
      consumer: "sentinel-board",
      type: "sb.push.done",
      level: "info",
      message: `Card unificada ${taskId} importada OK`,
      payload: { sbTaskId: created },
    });
  } catch (err) {
    const message = (err as Error).message;
    warn(`[SentinelBoard] Error de red al enviar card ${taskId}: ${message}`);
    await emitAmonEvent({
      runId,
      taskId,
      agent: "sentinel-board",
      consumer: "sentinel-board",
      type: "sb.push.error",
      level: "error",
      message: `Error de red: ${message}`,
      payload: { name: (err as Error).name },
    });
  }
}
