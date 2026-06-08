/**
 * Motor de ejecucion principal de AMON Agents.
 *
 * Wrapper delgado que delega en `runPipeline()` de `./pipeline`.
 *
 * Uso:
 *   npx ts-node src/core/run-agent.ts <task-id> <task-type> <description> [repo] [playbook]
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { runPipeline } from "./pipeline";
import { TaskType } from "./types";
import { newRunId } from "../events/event-emitter";
import { listTaskTypes } from "../llm/router";
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
    console.error(
      `Task type invalido "${taskType}". Disponibles: ${availableTaskTypes.join(", ")}`
    );
    process.exit(1);
  }

  const runId = newRunId();
  info(`[RunAgent] Iniciando flujo para tarea ${taskId} de tipo ${taskType}`);

  const exitCode = await runPipeline({
    taskId,
    taskType: taskType as TaskType,
    description,
    repo,
    playbook,
    runId,
  });

  if (exitCode === 0) {
    info("[RunAgent] Flujo completado. Revisa los outputs generados.");
  } else {
    error("[RunAgent] El pipeline termino con errores.");
  }

  process.exit(exitCode);
}

main().catch((e) => {
  error("[RunAgent] Error fatal en la ejecucion", e);
  process.exit(1);
});
