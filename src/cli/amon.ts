#!/usr/bin/env node
/**
 * AMON CLI — Entry point.
 * Runtime: AMON Agents Engine
 * Orquestador de agentes para desarrollo de software.
 *
 * Carga .env.local y dispatcha al comando correspondiente.
 *
 * Comandos:
 *   amon run [--task TASK-ID] [--type feature_small] "descripción"
 *   amon push --task TASK-ID
 *   amon status
 *   amon doctor
 *   amon worker
 *   amon worker-job --job WORKER-SMOKE-001 --action inspect_repo --repo <ruta>
 *   amon worker-job --job JARVIS-004C --action prepare_worktree --repo <ruta> --branch worker/JARVIS-004C
 *   amon worker-job --job JARVIS-004D-RUN-001 --action run_coding_tool --repo <ruta> --worktree <ruta> --tool opencode
 *   amon guardian-review --review GUARDIAN-004E-SMOKE-001 --job JARVIS-004D-RUN-004
 *   amon help
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { auditCommand } from "../commands/audit";
import { doctorCommand } from "../commands/doctor";
import { guardianReviewCommand } from "../commands/guardian-review";
import { historyCommand } from "../commands/history";
import { pushCommand } from "../commands/push";
import { runCommand } from "../commands/run";
import { scanCommand } from "../commands/scan";
import { statusCommand } from "../commands/status";
import { watchCommand } from "../commands/watch";
import { workerJobCommand } from "../commands/worker-job";
import { workerCommand } from "../commands/worker";
import { newRunId, withCommandEvents } from "../events/event-emitter";
import { error, setLevel } from "../utils/logger";
import { parseArgs, ParsedArgs } from "./parse-args";

setLevel("info");

const VERSION = "1.0.0";

const BANNER = `
  ╔══════════════════════════════════════════╗
  ║            AMON CLI  v${VERSION}            ║
  ║     AMON Agents Engine · Runtime CLI     ║
  ║  Orquestador de agentes para desarrollo  ║
  ╚══════════════════════════════════════════╝
`;

const HELP = `${BANNER}
Uso:
  amon run [--task TASK-ID] [--type feature_small] "descripción"
  amon push --task TASK-ID
  amon status
  amon history [--limit N]
  amon doctor
  amon worker                       (Worker Host MVP: status + heartbeat local)
  amon worker-job --job <id> --action inspect_repo --repo <ruta>
  amon worker-job --job <id> --action prepare_worktree --repo <ruta> --branch worker/<id>
  amon worker-job --job <id> --action run_coding_tool --repo <ruta> --worktree <ruta> --tool opencode
  amon guardian-review --review <id> --job <worker-job-id>
  amon audit --repo <ruta>
  amon scan  --repo <ruta>
  amon watch                       (preview: aún no implementado)
  amon help

Alias seguro:
  amon-agents <comando>           — preferido si tenés otro CLI \`amon\` global.

Conflicto de binario:
  Puede existir otro CLI llamado \`amon\` en PATH (p. ej. mini-agentes-cli).
  Si \`amon doctor\` lo detecta, usá \`amon-agents\` o \`npm run amon -- ...\`
  para forzar este runtime. Ver README §"Binario / alias".

Notas:
  - Si AMON_AGENTS_PUSH_TO_SB=true, "amon run" envía a Sentinel Board al terminar.
  - "amon push" siempre envía (force), independientemente del flag de entorno.
  - Las variables se leen desde .env.local en el cwd actual.
  - Usa "amon doctor" para diagnosticar el entorno antes de ejecutar.
  - Event stream NDJSON: outputs/events.jsonl en el cwd (override: AMON_EVENTS_PATH).
`;

function printHelp(): void {
  process.stdout.write(HELP);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const [command, ...rest] = argv;

  if (!command || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return 0;
  }

  if (command === "--version" || command === "-v") {
    process.stdout.write(`AMON CLI v${VERSION}\n`);
    return 0;
  }

  const parsed = parseArgs(rest);
  const runId = newRunId();

  // Args sanitizables para el evento command.started — emit-side limpia
  // secretos por sí mismo, pero acotamos lo que entra al payload.
  const evtArgs: Record<string, unknown> = {
    positional: parsed.positional.slice(0, 3),
    flagKeys: Object.keys(parsed.flags),
  };
  const repoArg =
    typeof parsed.flags.repo === "string" ? parsed.flags.repo : undefined;
  const taskArg =
    typeof parsed.flags.task === "string" ? parsed.flags.task : undefined;

  const dispatch = async (
    name: string,
    fn: (args: ParsedArgs) => Promise<number>
  ): Promise<number> => {
    return withCommandEvents(
      { command: name, runId, taskId: taskArg, repo: repoArg, args: evtArgs },
      () => fn(parsed)
    );
  };

  switch (command) {
    case "run":
      return dispatch("run", (args) => runCommand(args, { runId }));
    case "push":
      return dispatch("push", pushCommand);
    case "status":
      return dispatch("status", () => statusCommand());
    case "history":
      return dispatch("history", historyCommand);
    case "doctor":
      return dispatch("doctor", () => doctorCommand());
    case "audit":
      return dispatch("audit", auditCommand);
    case "scan":
      return dispatch("scan", scanCommand);
    case "watch":
      return dispatch("watch", () => watchCommand());
    case "worker":
      return workerCommand(parsed, { runId });
    case "worker-job":
      return workerJobCommand(parsed);
    case "guardian-review":
      return guardianReviewCommand(parsed);
    default:
      error(`[amon] Comando desconocido: "${command}"`);
      printHelp();
      return 1;
  }
}

main()
  .then((code) => process.exit(code))
  .catch((e) => {
    error("[amon] Error fatal", e);
    process.exit(1);
  });
