/**
 * Agente State-Guardian.
 * Valida que las propuestas cumplan las global-rules y no introduzcan anti-patrones.
 */
import { readFileSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import { AgentResult, GlobalRulesYaml, StandardOutput } from "../core/types";
import {
  mergeValidationResults,
  validateFields,
  validateOutput,
} from "../core/validate-json";
import { normalizeOutput } from "../core/normalize-output";
import { callLLM } from "../llm/call-llm";
import { buildStatePrompt, StateContext } from "../prompts/state.prompt";
import { cleanJson } from "../utils/clean-json";
import { error, info } from "../utils/logger";

const GLOBAL_RULES_PATH = join(process.cwd(), "core", "global-rules.yaml");

function loadGlobalRules(): GlobalRulesYaml {
  const raw = readFileSync(GLOBAL_RULES_PATH, "utf8");
  return yaml.load(raw) as GlobalRulesYaml;
}

export interface StateGuardianInput {
  taskId: string;
  proposedChanges: string;
}

export interface StateGuardianOutput extends StandardOutput {
  verdict: "APPROVED" | "BLOCKED" | "NEEDS_REVIEW";
  violations: string[];
}

export async function runStateGuardian(input: StateGuardianInput): Promise<AgentResult<StateGuardianOutput>> {
  info(`[State-Guardian] Iniciando validación de estado para tarea ${input.taskId}`);

  const globalRules = loadGlobalRules();

  const ctx: StateContext = {
    taskId: input.taskId,
    proposedChanges: input.proposedChanges,
    globalRules,
  };

  const prompt = buildStatePrompt(ctx);
  let raw: string;
  try {
    raw = await callLLM(prompt);
  } catch (e) {
    error("[State-Guardian] Fallo la llamada al LLM", e);
    throw e;
  }

  let output: StateGuardianOutput;
  try {
    const parsed = cleanJson<StateGuardianOutput>(raw);
    output = normalizeOutput(parsed) as StateGuardianOutput;
  } catch (e) {
    error("[State-Guardian] No se pudo parsear la respuesta del LLM", e);
    throw e;
  }

  const validation = mergeValidationResults(
    validateOutput(output),
    validateFields(output, {
      verdict: {
        type: "string",
        allowedValues: ["APPROVED", "BLOCKED", "NEEDS_REVIEW"],
      },
      violations: { type: "list[string]" },
    })
  );
  if (!validation.valid) {
    error("[State-Guardian] Output no cumple el contrato", validation.errors);
  } else {
    info("[State-Guardian] Output validado correctamente");
  }

  const result: AgentResult<StateGuardianOutput> = {
    agent: "security",
    taskId: input.taskId,
    taskType: "security_check",
    output,
    rawResponse: raw,
    timestamp: new Date().toISOString(),
    valid: validation.valid,
    errors: validation.errors,
  };

  return result;
}
