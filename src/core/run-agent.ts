/**
 * Motor de ejecución principal de AMON Agents.
 * Orquesta agentes leyendo YAMLs existentes como configuración viva.
 *
 * Uso:
 *   npx ts-node src/core/run-agent.ts <task-id> <task-type> <description> [repo] [playbook]
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { AgentResult } from "../core/types";
import { getOutputPathForTaskType } from "../llm/router";
import { runPlanner } from "../agents/planner";
import { runQaReviewer } from "../agents/qa-reviewer";
import { runStateGuardian } from "../agents/state-guardian";
import { runScorer } from "../agents/scorer";
import {
  adaptToSentinelBoard,
  serializeForBoard,
  sendTasksToSentinelBoard,
  SentinelBoardEntry,
} from "../adapters/sentinel-board";
import { info, error, setLevel } from "../utils/logger";

setLevel("info");

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length < 3) {
    console.error("Uso: run-agent.ts <task-id> <task-type> <description> [repo] [playbook]");
    process.exit(1);
  }

  const [taskId, taskType, description, repo, playbook] = args;
  const boardEntries: SentinelBoardEntry[] = [];

  info(`[RunAgent] Iniciando flujo para tarea ${taskId} de tipo ${taskType}`);

  // 1. Planner
  const plannerResult = await runPlanner({ taskId, taskType, description, repo, playbook });
  boardEntries.push(await saveResult(plannerResult));

  // 2. State-Guardian valida el plan
  const stateResult = await runStateGuardian({
    taskId,
    proposedChanges: JSON.stringify(plannerResult.output, null, 2),
  });
  boardEntries.push(await saveResult(stateResult));

  if (stateResult.output.verdict === "BLOCKED") {
    error("[RunAgent] State-Guardian bloqueó el cambio por violaciones de reglas globales.");
    process.exit(1);
  }

  // 3. QA Reviewer revisa el plan
  const qaResult = await runQaReviewer({
    taskId,
    taskType,
    plan: JSON.stringify(plannerResult.output, null, 2),
  });
  boardEntries.push(await saveResult(qaResult));

  // 4. Scorer evalúa la calidad del plan
  const scorerResult = await runScorer({
    taskId,
    agentName: "planner",
    rawOutput: JSON.stringify(plannerResult.output, null, 2),
  });
  boardEntries.push(await saveResult(scorerResult));

  // 5. Push batch a Sentinel Board (no bloquea si falla)
  await sendTasksToSentinelBoard(boardEntries);

  info("[RunAgent] Flujo completado. Revisa los outputs generados.");
}

/** Persiste el resultado en disco y retorna la entrada adaptada para Sentinel Board. */
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
  error("[RunAgent] Error fatal en la ejecución", e);
  process.exit(1);
});
