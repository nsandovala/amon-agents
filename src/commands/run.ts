/**
 * Comando `amon run`.
 * Ejecuta el pipeline de agentes delegando en `runPipeline() de `../core/pipeline`.
 *
 * Uso:
 *   amon run "descripción de la tarea"
 *   amon run --task TASK-003 --type feature_small "descripción"
 */
import { newRunId, emitAmonEvent } from "../events/event-emitter";
import { error, info } from "../utils/logger";
import { listTaskTypes } from "../llm/router";
import { TaskType } from "../core/types";
import { runPipeline } from "../core/pipeline";
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

export interface RunCommandOptions {
  runId?: string;
}

export async function runCommand(
  args: ParsedArgs,
  options: RunCommandOptions = {}
): Promise<number> {
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

  const runId = options.runId ?? newRunId();
  info(`[amon run] Iniciando flujo para tarea ${taskId} de tipo ${taskType}`);
  await emitAmonEvent({
    runId,
    taskId,
    type: "run.started",
    level: "info",
    message: `Pipeline iniciado para ${taskId}`,
    payload: { taskType, hasRepo: !!repo, hasPlaybook: !!playbook },
  });

  // Delegar la orquestación completa al pipeline central
  const exitCode = await runPipeline({
    taskId,
    taskType,
    description,
    repo,
    playbook,
    runId,
  });

  if (exitCode === 0) {
    info(`[amon run] Flujo completado. Task: ${taskId}. Outputs locales generados.`);
  }

  return exitCode;
}
