/**
 * Pipeline central de orquestacion de agentes AMON.
 *
 * A partir de D3, el flujo se lee dinamicamente desde `routing.yaml`
 * y los agentes se ejecutan via `AGENT_REGISTRY`.
 */
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { AgentResult, AgentName, TaskType } from "./types";
import { getAgentExecutor, PipelineContext } from "../agents/registry";
import { StateGuardianOutput } from "../agents/state-guardian";
import { ScorerOutput } from "../agents/scorer";
import {
  buildUnifiedPayload,
  sendUnifiedCardToSentinelBoard,
} from "../adapters/sentinel-board";
import { emitAmonEvent, withAgentEvents } from "../events/event-emitter";
import { AmonEventAgent } from "../events/types";
import { getFlowForTaskType, getOutputPathForTaskType } from "../llm/router";
import { error, info } from "../utils/logger";

export interface PipelineParams {
  taskId: string;
  taskType: string;
  description: string;
  repo?: string;
  playbook?: string;
  runId: string;
}

const AGENT_TO_EVENT_AGENT: Record<AgentName, AmonEventAgent> = {
  architect: "planner",
  security: "state-guardian",
  qa: "qa-reviewer",
  ops: "scorer",
  designer: "planner",
  dev: "planner",
};

/**
 * Guarda el resultado de un agente en disco (output local por agente).
 */
function saveLocalResult(result: AgentResult): void {
  const outputPath = getOutputPathForTaskType(result.taskType);
  const dir = join(process.cwd(), outputPath);
  mkdirSync(dir, { recursive: true });

  const filename = `${result.taskId}-${result.agent}.json`;
  const filepath = join(dir, filename);
  writeFileSync(filepath, JSON.stringify(result, null, 2), "utf8");
  info(`[Pipeline] Guardado: ${filepath}`);
}

/**
 * Ejecuta el pipeline completo de agentes.
 *
 * El flujo se lee dinamicamente desde `routing.yaml`.
 * Cada agente se resuelve via `AGENT_REGISTRY`.
 *
 * Retorna codigo de salida: 0 (ok), 1 (error/blocked).
 */
export async function runPipeline(params: PipelineParams): Promise<number> {
  const { taskId, taskType, description, repo, playbook, runId } = params;

  const typedTaskType = taskType as TaskType;
  const flow = getFlowForTaskType(typedTaskType);

  const ctx: PipelineContext = {
    taskId,
    taskType: typedTaskType,
    description,
    repo,
    playbook,
    runId,
    results: {},
  };

  info(`[Pipeline] Iniciando flujo para tarea ${taskId} de tipo ${taskType}`);

  for (const agentName of flow) {
    const executor = getAgentExecutor(agentName);
    const agentStart = Date.now();

    const result = await withAgentEvents(
      { runId, taskId, agent: AGENT_TO_EVENT_AGENT[agentName] },
      () => executor(ctx)
    );

    const agentDuration = Date.now() - agentStart;
    ctx.results[agentName] = result;
    saveLocalResult(result);

    info(`[Pipeline] Agent ${agentName} completed in ${agentDuration}ms`);
    await emitAmonEvent({
      runId,
      taskId,
      agent: AGENT_TO_EVENT_AGENT[agentName],
      type: "agent.metrics",
      level: "info",
      message: `Agent ${agentName} completed in ${agentDuration}ms`,
      payload: {
        agent: agentName,
        durationMs: agentDuration,
        promptTokens: undefined,
        completionTokens: undefined,
        totalTokens: undefined,
      },
    });

    // Veredicto especial de state-guardian
    if (agentName === "security") {
      if (!result.valid) {
        error("[Pipeline] State-Guardian devolvio una salida invalida", result.errors);
        await emitAmonEvent({
          runId,
          taskId,
          type: "run.done",
          level: "error",
          message: "Pipeline abortado: State-Guardian invalido",
          payload: { reason: "state_guardian_invalid", errors: result.errors ?? [] },
        });
        return 1;
      }

      const stateOutput = result.output as StateGuardianOutput;
      if (stateOutput.verdict === "BLOCKED") {
        error("[Pipeline] State-Guardian bloqueo el cambio por violaciones de reglas globales.");
        await emitAmonEvent({
          runId,
          taskId,
          type: "run.done",
          level: "error",
          message: "Pipeline abortado: BLOCKED por State-Guardian",
          payload: { reason: "state_guardian_blocked" },
        });
        return 1;
      }
    }
  }

  // Extraer resultados requeridos para el payload unificado
  const plannerResult = ctx.results.architect;
  const stateResult = ctx.results.security as AgentResult<StateGuardianOutput> | undefined;
  const qaResult = ctx.results.qa;
  const scorerResult = ctx.results.ops as AgentResult<ScorerOutput> | undefined;

  if (!plannerResult || !stateResult || !qaResult || !scorerResult) {
    error("[Pipeline] Flujo incompleto: faltan resultados de agentes requeridos.");
    await emitAmonEvent({
      runId,
      taskId,
      type: "run.done",
      level: "error",
      message: "Pipeline abortado: flujo incompleto",
      payload: { reason: "incomplete_flow" },
    });
    return 1;
  }

  // -- Card unificada -> Sentinel Board --
  const unifiedPayload = buildUnifiedPayload({
    plannerResult,
    stateResult,
    qaResult,
    scorerResult,
  });

  // Guardar card unificada localmente
  const boardDir = join(process.cwd(), "outputs", "sentinel");
  mkdirSync(boardDir, { recursive: true });
  const boardFile = join(boardDir, `${taskId}-unified-board.json`);
  writeFileSync(boardFile, JSON.stringify(unifiedPayload, null, 2), "utf8");
  info(`[Pipeline] Sentinel Board local (unified): ${boardFile}`);

  // Push a Sentinel Board (1 sola card)
  await sendUnifiedCardToSentinelBoard(unifiedPayload, { runId });

  info("[Pipeline] Flujo completado. Revisa los outputs generados.");
  await emitAmonEvent({
    runId,
    taskId,
    type: "run.done",
    level: "info",
    message: `Pipeline completado para ${taskId}`,
    payload: {
      score: scorerResult.output.score,
      verdict: stateResult.output.verdict,
    },
  });

  return 0;
}
