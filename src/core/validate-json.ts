/**
 * Validador de contratos de salida.
 * Verifica que un objeto cumpla con los campos requeridos definidos en output-contract.yaml.
 */
import { readFileSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import { OutputContractYaml, StandardOutput } from "../core/types";
import { error } from "../utils/logger";

const CONTRACT_PATH = join(process.cwd(), "core", "output-contract.yaml");

let cachedContract: OutputContractYaml | null = null;

function loadContract(): OutputContractYaml {
  if (cachedContract) return cachedContract;
  try {
    const raw = readFileSync(CONTRACT_PATH, "utf8");
    cachedContract = yaml.load(raw) as OutputContractYaml;
    return cachedContract;
  } catch (e) {
    error(`[ValidateJSON] No se pudo cargar output-contract.yaml desde ${CONTRACT_PATH}`, e);
    throw e;
  }
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

export interface FieldRule {
  type: "string" | "number" | "list[string]";
  allowedValues?: string[];
  required?: boolean;
}

/**
 * Valida que un objeto tenga todos los campos requeridos del contrato de salida.
 */
export function validateOutput(data: unknown): ValidationResult {
  const contract = loadContract();
  const required = contract.default_output.required_fields;
  const errors: string[] = [];

  if (typeof data !== "object" || data === null) {
    return { valid: false, errors: ["El output no es un objeto válido."] };
  }

  const obj = data as Record<string, unknown>;

  for (const field of required) {
    if (!(field in obj)) {
      errors.push(`Falta campo requerido: "${field}"`);
      continue;
    }
    const value = obj[field];
    const fieldRule = contract.field_rules[field];
    if (!fieldRule) continue;

    // Validación básica de tipo
    const expectedType = fieldRule.type;
    if (expectedType === "string" && typeof value !== "string") {
      errors.push(`Campo "${field}" debe ser string, recibió ${typeof value}`);
    } else if (expectedType === "list[string]" && !Array.isArray(value)) {
      errors.push(`Campo "${field}" debe ser array, recibió ${typeof value}`);
    } else if (expectedType === "list[string]" && Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) {
        if (typeof value[i] !== "string") {
          errors.push(`Campo "${field}[${i}]" debe ser string`);
        }
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Valida campos adicionales fuera del contrato base.
 * Se usa para salidas especializadas como State-Guardian y Scorer.
 */
export function validateFields(
  data: unknown,
  rules: Record<string, FieldRule>
): ValidationResult {
  if (typeof data !== "object" || data === null) {
    return { valid: false, errors: ["El output no es un objeto valido."] };
  }

  const obj = data as Record<string, unknown>;
  const errors: string[] = [];

  for (const [field, rule] of Object.entries(rules)) {
    const required = rule.required ?? true;

    if (!(field in obj)) {
      if (required) {
        errors.push(`Falta campo requerido: "${field}"`);
      }
      continue;
    }

    const value = obj[field];

    if (rule.type === "string") {
      if (typeof value !== "string") {
        errors.push(`Campo "${field}" debe ser string, recibio ${typeof value}`);
        continue;
      }

      if (rule.allowedValues && !rule.allowedValues.includes(value)) {
        errors.push(
          `Campo "${field}" debe ser uno de: ${rule.allowedValues.join(", ")}`
        );
      }
      continue;
    }

    if (rule.type === "number") {
      if (typeof value !== "number" || Number.isNaN(value)) {
        errors.push(`Campo "${field}" debe ser number, recibio ${typeof value}`);
      }
      continue;
    }

    if (!Array.isArray(value)) {
      errors.push(`Campo "${field}" debe ser array, recibio ${typeof value}`);
      continue;
    }

    for (let i = 0; i < value.length; i++) {
      if (typeof value[i] !== "string") {
        errors.push(`Campo "${field}[${i}]" debe ser string`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

export function mergeValidationResults(...results: ValidationResult[]): ValidationResult {
  const errors = results.flatMap((result) => result.errors);
  return { valid: errors.length === 0, errors };
}

/**
 * Devuelve el contrato de salida cargado.
 */
export function getOutputContract(): OutputContractYaml {
  return loadContract();
}
