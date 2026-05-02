/**
 * Agente Planner (rol: architect).
 * Produce un plan de cambio estructurado validado contra el contrato de salida.
 */
import { readFileSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import { AgentResult, CoreAgentsYaml, OutputContractYaml, StandardOutput } from "../core/types";
import { validateOutput } from "../core/validate-json";
import { normalizeOutput } from "../core/normalize-output";
import { callLLM } from "../llm/call-llm";
import { buildPlannerPrompt, PlannerContext } from "../prompts/planner.prompt";
import { cleanJson } from "../utils/clean-json";
import { error, info } from "../utils/logger";

const CORE_AGENTS_PATH = join(process.cwd(), "core", "core-agents.yaml");
const OUTPUT_CONTRACT_PATH = join(process.cwd(), "core", "output-contract.yaml");

function loadCoreAgents(): CoreAgentsYaml {
  const raw = readFileSync(CORE_AGENTS_PATH, "utf8");
  return yaml.load(raw) as CoreAgentsYaml;
}

function loadOutputContract(): OutputContractYaml {
  const raw = readFileSync(OUTPUT_CONTRACT_PATH, "utf8");
  return yaml.load(raw) as OutputContractYaml;
}

export interface PlannerInput {
  taskId: string;
  taskType: string;
  description: string;
  repo?: string;
  playbook?: string;
}

export async function runPlanner(input: PlannerInput): Promise<AgentResult> {
  info(`[Planner] Iniciando planificación para tarea ${input.taskId}`);

  const core = loadCoreAgents();
  const contract = loadOutputContract();
  const agentConfig = core.agents.architect;

  const ctx: PlannerContext = {
    taskId: input.taskId,
    taskType: input.taskType,
    description: input.description,
    repo: input.repo,
    playbook: input.playbook,
    agentConfig,
    outputContract: contract,
  };

  const prompt = buildPlannerPrompt(ctx);
  let raw: string;
  try {
    raw = await callLLM(prompt);
  } catch (e) {
    error("[Planner] Fallo la llamada al LLM", e);
    throw e;
  }

  let output: StandardOutput;
  try {
    const parsed = cleanJson<StandardOutput>(raw);
    output = normalizeOutput(parsed);
  } catch (e) {
    error("[Planner] No se pudo parsear la respuesta del LLM", e);
    throw e;
  }

  const validation = validateOutput(output);
  if (!validation.valid) {
    error("[Planner] Output no cumple el contrato", validation.errors);
  } else {
    info("[Planner] Output validado correctamente");
  }

  const result: AgentResult = {
    agent: "architect",
    taskId: input.taskId,
    taskType: input.taskType as any,
    output,
    rawResponse: raw,
    timestamp: new Date().toISOString(),
    valid: validation.valid,
    errors: validation.errors,
  };

  return result;
}
