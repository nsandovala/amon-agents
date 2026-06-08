/**
 * Tipos del Event Stream Bridge (local-first).
 *
 * Eventos append-only escritos como NDJSON en disco
 * (por defecto `~/.amon/events.jsonl`).
 *
 * Esta capa NO se conecta todavía con Sentinel Board ni
 * expone WebSocket/SSE — sólo emite a archivo local.
 */

/** Niveles de severidad de un evento. */
export type AmonEventLevel = "debug" | "info" | "warn" | "error";

/** Agente que origina el evento (opcional). */
export type AmonEventAgent =
  | "planner"
  | "state-guardian"
  | "qa-reviewer"
  | "scorer"
  | "sentinel-board";

/**
 * Tipos canónicos de evento.
 *
 * `type` está tipado como `string` en `AmonEvent` para mantener
 * compatibilidad hacia delante; este union sirve como referencia
 * para los emisores que quieran type-safety.
 */
export type AmonEventType =
  | "command.started"
  | "command.done"
  | "command.error"
  | "agent.started"
  | "agent.thinking"
  | "agent.output"
  | "agent.done"
  | "agent.error"
  | "agent.metrics"
  | "tool.used"
  | "sb.push.started"
  | "sb.push.done"
  | "sb.push.error"
  | "run.started"
  | "run.done"
  | "audit.finding"
  | "scan.finding";

/** Constantes para evitar typos al emitir. */
export const AmonEventTypes = {
  CommandStarted: "command.started",
  CommandDone: "command.done",
  CommandError: "command.error",
  AgentStarted: "agent.started",
  AgentThinking: "agent.thinking",
  AgentOutput: "agent.output",
  AgentDone: "agent.done",
  AgentError: "agent.error",
  AgentMetrics: "agent.metrics",
  ToolUsed: "tool.used",
  SbPushStarted: "sb.push.started",
  SbPushDone: "sb.push.done",
  SbPushError: "sb.push.error",
  RunStarted: "run.started",
  RunDone: "run.done",
  AuditFinding: "audit.finding",
  ScanFinding: "scan.finding",
} as const;

/**
 * Estructura de un evento append-only.
 *
 * Diseñada como contrato **neutral**: ningún campo asume Sentinel Board
 * como destino. Consumidores futuros (Liev, IndesPro, etc.) usan los
 * campos opcionales `consumer`, `context`, `projectSlug` y
 * `workspaceSlug` para enrutar/filtrar sin acoplar el emitter.
 *
 * - `id` y `ts` son generados por el emitter.
 * - `runId` agrupa todos los eventos de una ejecución del pipeline.
 * - `taskId` referencia la tarea lógica (p.ej. AMON-20260514…).
 * - `agent` queda undefined para eventos de pipeline (run.started, run.done).
 * - `source` identifica el runtime que produjo el evento; default `"amon-agents"`.
 * - `consumer` indica el destino lógico cuando aplica (`"sentinel-board"`,
 *   `"liev"`, `"indespro"`, …). Vacío = evento de pipeline interno.
 * - `context`, `projectSlug`, `workspaceSlug` son metadatos genéricos para
 *   que consumidores externos puedan correlacionar sin parsear payloads.
 */
export interface AmonEvent {
  id: string;
  ts: string;
  runId: string;
  taskId?: string;
  agent?: AmonEventAgent;
  type: string;
  level: AmonEventLevel;
  message: string;
  payload?: Record<string, unknown>;

  // ── Routing / multi-consumer (todos opcionales) ─────────────
  source?: string;
  consumer?: string;
  context?: string;
  projectSlug?: string;
  workspaceSlug?: string;
}
