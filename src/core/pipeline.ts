/**
 * Pipeline central de orquestacion de agentes AMON.
 * Extraido de run.ts y run-agent.ts para unificar la logica de ejecucion.
 *
 * NOTA: Este modulo es nuevo (C1). Los callers (run.ts, run-agent.ts)
 * aun no delegan aqui; se conectaran en C2/C3.
 */
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { runPlanner } from "../agents/planner";
import { runQaReviewer } from "../agents/qa-reviewer";
import { runScorer, ScorerOutput } from "../agents/scorer";
import { runStateGuardian } from "../agents/state-guardian";
import {
  buildUnifiedPayload,
  sendUnifiedCardToSentinelBoard,
} from "../adapters/sentinel-board";
import { AgentResult, TaskType } from "./types";
import { emitAmonEvent, withAgentEvents } from "../events/event-emitter";
import { getOutputPathForTaskType } from "../llm/router";
import { error, info } from "../utils/logger";

export interface PipelineParams {
  taskId: string;
  taskType: TaskType;
  description: string;
  repo?: string;
  playbook?: string;
  runId: string;
}

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
 * Pipeline: planner -> state-guardian -> qa-reviewer -> scorer
 *
 * Retorna codigo de salida: 0 (ok), 1 (error/blocked).
 */
export async function runPipeline(params: PipelineParams): Promise<number> {
  const { taskId, taskType, description, repo, playbook, runId } = params;

  info(`[Pipeline] Iniciando flujo para tarea ${taskId} de tipo ${taskType}`);

  // -- 1. Planner --
  const plannerResult = await withAgentEvents(
    { runId, taskId, agent: "planner" },
    () => runPlanner({ taskId, taskType, description, repo, playbook })
  );
  saveLocalResult(plannerResult);

  // -- 2. State-Guardian --
  const stateResult = await withAgentEvents(
    { runId, taskId, agent: "state-guardian" },
    () =>
      runStateGuardian({
        taskId,
        proposedChanges: JSON.stringify(plannerResult.output, null, 2),
      })
  );
  saveLocalResult(stateResult);

  if (!stateResult.valid) {
    error("[Pipeline] State-Guardian devolvio una salida invalida", stateResult.errors);
    await emitAmonEvent({
      runId,
      taskId,
      type: "run.done",
      level: "error",
      message: "Pipeline abortado: State-Guardian invalido",
      payload: { reason: "state_guardian_invalid", errors: stateResult.errors ?? [] },
    });
    return 1;
  }

  if (stateResult.output.verdict === "BLOCKED") {
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

  // -- 3. QA-Reviewer --
  const qaResult = await withAgentEvents(
    { runId, taskId, agent: "qa-reviewer" },
    () =>
      runQaReviewer({
        taskId,
        taskType,
        plan: JSON.stringify(plannerResult.output, null, 2),
      })
  );
  saveLocalResult(qaResult);

  // -- 4. Scorer --
  const scorerResult = await withAgentEvents(
    { runId, taskId, agent: "scorer" },
    () =>
      runScorer({
        taskId,
        agentName: "planner",
        taskType,
        rawOutput: JSON.stringify(plannerResult.output, null, 2),
      })
  );
  saveLocalResult(scorerResult);

  // -- 5. Card unificada -> Sentinel Board --
  const unifiedPayload = buildUnifiedPayload({
    plannerResult,
    stateResult,
    qaResult,
    scorerResult: scorerResult as AgentResult<ScorerOutput>,
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
      score: (scorerResult.output as ScorerOutput)?.score,
      verdict: stateResult.output.verdict,
    },
  });

  return 0;
}
