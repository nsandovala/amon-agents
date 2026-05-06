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
import {
  SentinelBoardEntry,
  adaptToSentinelBoard,
  sendTasksToSentinelBoard,
  serializeForBoard,
} from "../adapters/sentinel-board";
import { AgentResult, TaskType } from "../core/types";
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
  const boardEntries: SentinelBoardEntry[] = [];
  const availableTaskTypes = listTaskTypes();

  if (!availableTaskTypes.includes(taskType as TaskType)) {
    throw new Error(
      `Task type invalido "${taskType}". Disponibles: ${availableTaskTypes.join(", ")}`
    );
  }

  info(`[RunAgent] Iniciando flujo para tarea ${taskId} de tipo ${taskType}`);

  const plannerResult = await runPlanner({ taskId, taskType, description, repo, playbook });
  boardEntries.push(await saveResult(plannerResult));

  const stateResult = await runStateGuardian({
    taskId,
    proposedChanges: JSON.stringify(plannerResult.output, null, 2),
  });
  boardEntries.push(await saveResult(stateResult));

  if (!stateResult.valid) {
    error("[RunAgent] State-Guardian devolvio una salida invalida", stateResult.errors);
    process.exit(1);
  }

  if (stateResult.output.verdict === "BLOCKED") {
    error("[RunAgent] State-Guardian bloqueo el cambio por violaciones de reglas globales.");
    process.exit(1);
  }

  const qaResult = await runQaReviewer({
    taskId,
    taskType,
    plan: JSON.stringify(plannerResult.output, null, 2),
  });
  boardEntries.push(await saveResult(qaResult));

  const scorerResult = await runScorer({
    taskId,
    agentName: "planner",
    taskType,
    rawOutput: JSON.stringify(plannerResult.output, null, 2),
  });
  boardEntries.push(await saveResult(scorerResult));

  await sendTasksToSentinelBoard(boardEntries);

  info("[RunAgent] Flujo completado. Revisa los outputs generados.");
}

async function saveResult(result: AgentResult): Promise<SentinelBoardEntry> {
  const outputPath = getOutputPathForTaskType(result.taskType);
  const dir = join(process.cwd(), outputPath);
  mkdirSync(dir, { recursive: true });

  const filename = `${result.taskId}-${result.agent}.json`;
  const filepath = join(dir, filename);
  writeFileSync(filepath, JSON.stringify(result, null, 2), "utf8");
  info(`[RunAgent] Guardado: ${filepath}`);

  const boardEntry = adaptToSentinelBoard(result);
  const boardDir = join(process.cwd(), "outputs", "sentinel");
  mkdirSync(boardDir, { recursive: true });
  const boardFile = join(boardDir, `${result.taskId}-${result.agent}-board.json`);
  writeFileSync(boardFile, serializeForBoard(boardEntry), "utf8");
  info(`[RunAgent] Sentinel Board local: ${boardFile}`);

  return boardEntry;
}

main().catch((e) => {
  error("[RunAgent] Error fatal en la ejecucion", e);
  process.exit(1);
});
