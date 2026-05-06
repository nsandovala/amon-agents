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
 *   amon help
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { doctorCommand } from "../commands/doctor";
import { pushCommand } from "../commands/push";
import { runCommand } from "../commands/run";
import { statusCommand } from "../commands/status";
import { error, setLevel } from "../utils/logger";
import { parseArgs } from "./parse-args";

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
  amon doctor
  amon help

Alias seguro:
  amon-agents <comando>           (evita conflictos con otros CLIs)

Notas:
  - Si AMON_AGENTS_PUSH_TO_SB=true, "amon run" envía a Sentinel Board al terminar.
  - "amon push" siempre envía (force), independientemente del flag de entorno.
  - Las variables se leen desde .env.local en el cwd actual.
  - Usa "amon doctor" para diagnosticar el entorno antes de ejecutar.
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

  switch (command) {
    case "run":
      return runCommand(parsed);
    case "push":
      return pushCommand(parsed);
    case "status":
      return statusCommand();
    case "doctor":
      return doctorCommand();
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
