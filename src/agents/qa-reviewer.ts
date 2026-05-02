/**
 * Agente QA-Reviewer (rol: qa).
 * Revisa planes o código contra el contrato de calidad AMON.
 */
import { readFileSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import { AgentResult, CoreAgentsYaml, OutputContractYaml, StandardOutput } from "../core/types";
import { validateOutput } from "../core/validate-json";
import { normalizeOutput } from "../core/normalize-output";
import { callLLM } from "../llm/call-llm";
import { buildQaPrompt, QaContext } from "../prompts/qa.prompt";
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

export interface QaReviewerInput {
  taskId: string;
  taskType: string;
  codeDiff?: string;
  plan?: string;
}

export async function runQaReviewer(input: QaReviewerInput): Promise<AgentResult> {
  info(`[QA-Reviewer] Iniciando revisión QA para tarea ${input.taskId}`);

  const core = loadCoreAgents();
  const contract = loadOutputContract();
  const agentConfig = core.agents.qa;

  const ctx: QaContext = {
    taskId: input.taskId,
    taskType: input.taskType,
    codeDiff: input.codeDiff,
    plan: input.plan,
    agentConfig,
    outputContract: contract,
  };

  const prompt = buildQaPrompt(ctx);
  let raw: string;
  try {
    raw = await callLLM(prompt);
  } catch (e) {
    error("[QA-Reviewer] Fallo la llamada al LLM", e);
    throw e;
  }

  let output: StandardOutput;
  try {
    const parsed = cleanJson<StandardOutput>(raw);
    output = normalizeOutput(parsed);
  } catch (e) {
    error("[QA-Reviewer] No se pudo parsear la respuesta del LLM", e);
    throw e;
  }

  const validation = validateOutput(output);
  if (!validation.valid) {
    error("[QA-Reviewer] Output no cumple el contrato", validation.errors);
  } else {
    info("[QA-Reviewer] Output validado correctamente");
  }

  const result: AgentResult = {
    agent: "qa",
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
