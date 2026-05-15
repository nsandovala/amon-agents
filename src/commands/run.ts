/**
 * Comando `amon run`.
 * Ejecuta el pipeline planner → state-guardian → qa-reviewer → scorer,
 * persiste outputs locales y, si AMON_AGENTS_PUSH_TO_SB=true, envía UNA card
 * unificada a Sentinel Board.
 *
 * Uso:
 *   amon run "descripción de la tarea"
 *   amon run --task TASK-003 --type feature_small "descripción"
 */
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
import { error, info } from "../utils/logger";
import { ParsedArgs } from "../cli/parse-args";

const DEFAULT_TASK_TYPE: TaskType = "feature_small";

function generateTaskId(): string {
  const ts = new Date()
    .toISOString()
    .replace(/[-:T.]/g, "")
    .slice(0, 14);
  return `AMON-${ts}`;
}

function asString(value: string | boolean | undefined): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export async function runCommand(args: ParsedArgs): Promise<number> {
  const description = args.positional.join(" ").trim();
  if (description.length === 0) {
    error("[amon run] Falta la descripción de la tarea.");
    info('Uso: amon run [--task TASK-ID] [--type feature_small] "descripción"');
    return 1;
  }

  const taskId = asString(args.flags.task) ?? generateTaskId();
  const taskType = (asString(args.flags.type) ?? DEFAULT_TASK_TYPE) as TaskType;
  const repo = asString(args.flags.repo);
  const playbook = asString(args.flags.playbook);

  const availableTaskTypes = listTaskTypes();
  if (!availableTaskTypes.includes(taskType)) {
    error(
      `[amon run] task_type inválido "${taskType}". Disponibles: ${availableTaskTypes.join(", ")}`
    );
    return 1;
  }

  const runId = newRunId();
  info(`[amon run] Iniciando flujo para tarea ${taskId} de tipo ${taskType}`);
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
    error("[amon run] State-Guardian devolvió una salida inválida", stateResult.errors);
    await emitAmonEvent({
      runId,
      taskId,
      type: "run.done",
      level: "error",
      message: "Pipeline abortado: State-Guardian inválido",
      payload: { reason: "state_guardian_invalid", errors: stateResult.errors ?? [] },
    });
    return 1;
  }

  if (stateResult.output.verdict === "BLOCKED") {
    error("[amon run] State-Guardian bloqueó el cambio por violaciones de reglas globales.");
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
  info(`[amon run] Sentinel Board local (unified): ${boardFile}`);

  // Push a Sentinel Board (1 sola card)
  await sendUnifiedCardToSentinelBoard(unifiedPayload, { runId });

  info(`[amon run] Flujo completado. Task: ${taskId}. Outputs locales generados.`);
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
  info(`[amon run] Guardado: ${filepath}`);
}
