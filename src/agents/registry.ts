/**
 * Registro de agentes ejecutables.
 *
 * Mapea cada `AgentName` a una funcion que recibe `PipelineContext`
 * y devuelve un `AgentResult`.
 *
 * NOTA: Este modulo es independiente (D1). El pipeline aun no consume
 * el registry; se conectara en D3.
 */
import { AgentName, AgentResult, TaskType } from "../core/types";
import { runPlanner } from "./planner";
import { runStateGuardian } from "./state-guardian";
import { runQaReviewer } from "./qa-reviewer";
import { runScorer } from "./scorer";

export interface PipelineContext {
  taskId: string;
  taskType: TaskType;
  description: string;
  repo?: string;
  playbook?: string;
  runId: string;
  /** Resultados acumulados de agentes ya ejecutados. */
  results: Partial<Record<AgentName, AgentResult>>;
}

export type AgentExecutor = (ctx: PipelineContext) => Promise<AgentResult>;

/**
 * Registry estatico de agentes.
 * Los agentes no implementados (designer, dev) valen `undefined`;
 * `getAgentExecutor` lanzara un error claro si se intentan usar.
 */
export const AGENT_REGISTRY: Record<AgentName, AgentExecutor | undefined> = {
  architect: (ctx) =>
    runPlanner({
      taskId: ctx.taskId,
      taskType: ctx.taskType,
      description: ctx.description,
      repo: ctx.repo,
      playbook: ctx.playbook,
    }),

  security: (ctx) =>
    runStateGuardian({
      taskId: ctx.taskId,
      proposedChanges: JSON.stringify(
        ctx.results.architect?.output ?? {},
        null,
        2
      ),
    }),

  qa: (ctx) =>
    runQaReviewer({
      taskId: ctx.taskId,
      taskType: ctx.taskType,
      plan: ctx.results.architect
        ? JSON.stringify(ctx.results.architect.output, null, 2)
        : undefined,
    }),

  ops: (ctx) =>
    runScorer({
      taskId: ctx.taskId,
      agentName: "planner",
      taskType: ctx.taskType,
      rawOutput: ctx.results.architect
        ? JSON.stringify(ctx.results.architect.output, null, 2)
        : "{}",
    }),

  designer: undefined,
  dev: undefined,
};

/**
 * Devuelve el ejecutor de un agente.
 * Lanza si el agente no esta implementado.
 */
export function getAgentExecutor(name: AgentName): AgentExecutor {
  const executor = AGENT_REGISTRY[name];
  if (!executor) {
    throw new Error(
      `Agente '${name}' definido en routing pero no implementado en AGENT_REGISTRY`
    );
  }
  return executor;
}
