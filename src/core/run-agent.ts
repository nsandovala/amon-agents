/**
 * Motor de ejecucion principal de AMON Agents.
 * Orquesta agentes leyendo YAMLs existentes como configuracion viva.
 *
 * Uso:
 *   npx ts-node src/core/run-agent.ts <task-id> <task-type> <description> [repo] [playbook]
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { runPlanner } from "../agents/planner";
import { runQaReviewer } from "../agents/qa-reviewer";
import { runScorer } from "../agents/scorer";
import { runStateGuardian } from "../agents/state-guardian";
import { ScorerOutput } from "../agents/scorer";
import {
  buildUnifiedPayload,
  sendUnifiedCardToSentinelBoard,
} from "../adapters/sentinel-board";
import { AgentResult, TaskType } from "../core/types";
import {
  emitAmonEvent,
  newRunId,
  withAgentEvents,
} from "../events/event-emitter";
import { getOutputPathForTaskType, listTaskTypes } from "../llm/router";
import { error, info, setLevel } from "../utils/logger";

setLevel("info");

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.error("Uso: run-agent.ts <task-id> <task-type> <description> [repo] [playbook]");
    process.exit(1);
  }

  const [taskId, taskType, description, repo, playbook] = args;
  const availableTaskTypes = listTaskTypes();

  if (!availableTaskTypes.includes(taskType as TaskType)) {
    throw new Error(
      `Task type invalido "${taskType}". Disponibles: ${availableTaskTypes.join(", ")}`
    );
  }

  const runId = newRunId();
  info(`[RunAgent] Iniciando flujo para tarea ${taskId} de tipo ${taskType}`);
  await emitAmonEvent({
    runId,
    taskId,
    type: "run.started",
    level: "info",
    message: `Pipeline iniciado para ${taskId}`,
    payload: { taskType, hasRepo: !!repo, hasPlaybook: !!playbook },
  });

  // ── 1. Planner ──
  const plannerResult = await withAgentEvents(
    { runId, taskId, agent: "planner" },
    () => runPlanner({ taskId, taskType, description, repo, playbook })
  );
  saveLocalResult(plannerResult);

  // ── 2. State-Guardian ──
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
    error("[RunAgent] State-Guardian devolvio una salida invalida", stateResult.errors);
    await emitAmonEvent({
      runId,
      taskId,
      type: "run.done",
      level: "error",
      message: "Pipeline abortado: State-Guardian invalido",
      payload: { reason: "state_guardian_invalid", errors: stateResult.errors ?? [] },
    });
    process.exit(1);
  }

  if (stateResult.output.verdict === "BLOCKED") {
    error("[RunAgent] State-Guardian bloqueo el cambio por violaciones de reglas globales.");
    await emitAmonEvent({
      runId,
      taskId,
      type: "run.done",
      level: "error",
      message: "Pipeline abortado: BLOCKED por State-Guardian",
      payload: { reason: "state_guardian_blocked" },
    });
    process.exit(1);
  }

  // ── 3. QA-Reviewer ──
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

  // ── 4. Scorer ──
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

  // ── 5. Card unificada → Sentinel Board ──
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
  info(`[RunAgent] Sentinel Board local (unified): ${boardFile}`);

  // Push a Sentinel Board (1 sola card)
  await sendUnifiedCardToSentinelBoard(unifiedPayload, { runId });

  info("[RunAgent] Flujo completado. Revisa los outputs generados.");
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
}

/**
 * Guarda el resultado de un agente en disco (output local por agente).
 * No genera SentinelBoardEntry individual — la card única se construye al final.
 */
function saveLocalResult(result: AgentResult): void {
  const outputPath = getOutputPathForTaskType(result.taskType);
  const dir = join(process.cwd(), outputPath);
  mkdirSync(dir, { recursive: true });

  const filename = `${result.taskId}-${result.agent}.json`;
  const filepath = join(dir, filename);
  writeFileSync(filepath, JSON.stringify(result, null, 2), "utf8");
  info(`[RunAgent] Guardado: ${filepath}`);
}

main().catch((e) => {
  error("[RunAgent] Error fatal en la ejecucion", e);
  process.exit(1);
});
