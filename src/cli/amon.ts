#!/usr/bin/env node
/**
 * Entry point del CLI `amon`.
 * Carga .env.local y dispatcha al comando correspondiente.
 *
 * Comandos:
 *   amon run [--task TASK-ID] [--type feature_small] "descripción"
 *   amon push --task TASK-ID
 *   amon status
 *   amon help
 */
import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });

import { pushCommand } from "../commands/push";
import { runCommand } from "../commands/run";
import { statusCommand } from "../commands/status";
import { error, setLevel } from "../utils/logger";
import { parseArgs } from "./parse-args";

setLevel("info");

const HELP = `amon — CLI de AMON Agents

Uso:
  amon run [--task TASK-ID] [--type feature_small] "descripción"
  amon push --task TASK-ID
  amon status
  amon help

Notas:
  - Si AMON_AGENTS_PUSH_TO_SB=true, "amon run" envía a Sentinel Board al terminar.
  - "amon push" siempre envía (force), independientemente del flag de entorno.
  - Las variables se leen desde .env.local en el cwd actual.
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

  const parsed = parseArgs(rest);

  switch (command) {
    case "run":
      return runCommand(parsed);
    case "push":
      return pushCommand(parsed);
    case "status":
      return statusCommand();
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
