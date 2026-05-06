/**
 * Comando `amon push`.
 * Lee outputs/sentinel/{taskId}-*-board.json y los envía a Sentinel Board.
 * Fuerza el push (bypass de AMON_AGENTS_PUSH_TO_SB) porque el comando es explícito.
 *
 * Uso:
 *   amon push --task TASK-003
 */
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { SentinelBoardEntry, sendTasksToSentinelBoard } from "../adapters/sentinel-board";
import { error, info, warn } from "../utils/logger";
import { ParsedArgs } from "../cli/parse-args";

const SENTINEL_DIR = join(process.cwd(), "outputs", "sentinel");

function loadBoardEntries(taskId: string): SentinelBoardEntry[] {
  let files: string[];
  try {
    files = readdirSync(SENTINEL_DIR);
  } catch (e) {
    error(`[amon push] No se pudo leer ${SENTINEL_DIR}`, e);
    return [];
  }

  const matching = files.filter(
    (f) => f.startsWith(`${taskId}-`) && f.endsWith("-board.json")
  );

  const entries: SentinelBoardEntry[] = [];
  for (const file of matching) {
    const filepath = join(SENTINEL_DIR, file);
    try {
      const raw = readFileSync(filepath, "utf8");
      const parsed = JSON.parse(raw) as SentinelBoardEntry;
      entries.push(parsed);
      info(`[amon push] Cargado: ${filepath}`);
    } catch (e) {
      warn(`[amon push] No se pudo parsear ${filepath}: ${(e as Error).message}`);
    }
  }
  return entries;
}

export async function pushCommand(args: ParsedArgs): Promise<number> {
  const taskFlag = args.flags.task;
  const taskId = typeof taskFlag === "string" ? taskFlag : "";
  if (taskId.length === 0) {
    error("[amon push] Falta --task TASK-ID");
    info("Uso: amon push --task TASK-003");
    return 1;
  }

  const entries = loadBoardEntries(taskId);
  if (entries.length === 0) {
    warn(
      `[amon push] No se encontraron archivos ${taskId}-*-board.json en outputs/sentinel/. Nada que enviar.`
    );
    return 1;
  }

  info(`[amon push] Enviando ${entries.length} entrada(s) a Sentinel Board (force=true).`);
  await sendTasksToSentinelBoard(entries, { force: true });
  info("[amon push] Push completado.");
  return 0;
}
