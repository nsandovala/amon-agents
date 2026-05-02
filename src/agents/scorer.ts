/**
 * Agente Scorer.
 * Evalúa la calidad de un output de otro agente.
 */
import { readFileSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import { AgentResult, OutputContractYaml, StandardOutput } from "../core/types";
import { validateOutput } from "../core/validate-json";
import { normalizeOutput } from "../core/normalize-output";
import { callLLM } from "../llm/call-llm";
import { buildScorerPrompt, ScorerContext } from "../prompts/scorer.prompt";
import { cleanJson } from "../utils/clean-json";
import { error, info } from "../utils/logger";

const OUTPUT_CONTRACT_PATH = join(process.cwd(), "core", "output-contract.yaml");

function loadOutputContract(): OutputContractYaml {
  const raw = readFileSync(OUTPUT_CONTRACT_PATH, "utf8");
  return yaml.load(raw) as OutputContractYaml;
}

export interface ScorerInput {
  taskId: string;
  agentName: string;
  rawOutput: string;
}

export interface ScorerOutput extends StandardOutput {
  score: number;
  completeness: number;
  quality: number;
  coherence: number;
  reasoning: string;
}

export async function runScorer(input: ScorerInput): Promise<AgentResult<ScorerOutput>> {
  info(`[Scorer] Iniciando evaluación de output para tarea ${input.taskId}, agente ${input.agentName}`);

  const contract = loadOutputContract();

  const ctx: ScorerContext = {
    taskId: input.taskId,
    agentName: input.agentName,
    rawOutput: input.rawOutput,
    outputContract: contract,
  };

  const prompt = buildScorerPrompt(ctx);
  let raw: string;
  try {
    raw = await callLLM(prompt);
  } catch (e) {
    error("[Scorer] Fallo la llamada al LLM", e);
    throw e;
  }

  let output: ScorerOutput;
  try {
    const parsed = cleanJson<ScorerOutput>(raw);
    output = normalizeOutput(parsed) as ScorerOutput;
  } catch (e) {
    error("[Scorer] No se pudo parsear la respuesta del LLM", e);
    throw e;
  }

  const validation = validateOutput(output);
  if (!validation.valid) {
    error("[Scorer] Output no cumple el contrato", validation.errors);
  } else {
    info("[Scorer] Output validado correctamente");
  }

  const result: AgentResult<ScorerOutput> = {
    agent: "qa",
    taskId: input.taskId,
    taskType: "research_task",
    output,
    rawResponse: raw,
    timestamp: new Date().toISOString(),
    valid: validation.valid,
    errors: validation.errors,
  };

  return result;
}
