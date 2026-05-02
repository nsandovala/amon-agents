/**
 * Normaliza un output de agente para que cumpla el contrato StandardOutput.
 * Fuerza tipos correctos cuando el LLM devuelve objetos en vez de strings/arrays.
 */
import { StandardOutput } from "./types";
import { warn } from "../utils/logger";

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeStringField(
  data: Record<string, unknown>,
  field: string,
  defaultValue: string
): string {
  const value = data[field];
  if (typeof value === "string") {
    return value;
  }
  if (isObject(value)) {
    warn(`[NormalizeOutput] Field "${field}" normalized from object to string`);
    return JSON.stringify(value);
  }
  if (value !== undefined) {
    warn(`[NormalizeOutput] Field "${field}" normalized from ${typeof value} to string`);
    return String(value);
  }
  return defaultValue;
}

function normalizeStringArrayField(
  data: Record<string, unknown>,
  field: string
): string[] {
  const value = data[field];

  if (Array.isArray(value)) {
    // Convertir cada item a string
    const normalized = value.map((item, idx) => {
      if (typeof item === "string") return item;
      if (isObject(item)) {
        warn(`[NormalizeOutput] Field "${field}[${idx}]" normalized from object to string`);
        return JSON.stringify(item);
      }
      return String(item);
    });
    return normalized;
  }

  if (typeof value === "string") {
    warn(`[NormalizeOutput] Field "${field}" normalized from string to array`);
    return [value];
  }

  if (isObject(value)) {
    warn(`[NormalizeOutput] Field "${field}" normalized from object to array`);
    return Object.values(value).map(String);
  }

  if (value !== undefined) {
    warn(`[NormalizeOutput] Field "${field}" normalized from ${typeof value} to array`);
    return [String(value)];
  }

  return [];
}

/**
 * Normaliza datos crudos del LLM a StandardOutput.
 * No pierde información: convierte objetos a JSON strings cuando corresponde.
 */
export function normalizeOutput(data: unknown): StandardOutput {
  if (!isObject(data)) {
    throw new Error(`normalizeOutput: expected object, got ${typeof data}`);
  }

  const obj = data as Record<string, unknown>;

  const normalized: StandardOutput = {
    goal: normalizeStringField(obj, "goal", ""),
    scope: normalizeStringField(obj, "scope", ""),
    files_to_touch: normalizeStringArrayField(obj, "files_to_touch"),
    plan: normalizeStringArrayField(obj, "plan"),
    risks: normalizeStringArrayField(obj, "risks"),
    validations: normalizeStringArrayField(obj, "validations"),
    done_when: normalizeStringArrayField(obj, "done_when"),
  };

  // Copiar campos extra no estándar para que no se pierdan
  for (const key of Object.keys(obj)) {
    if (!(key in normalized)) {
      (normalized as Record<string, unknown>)[key] = obj[key];
    }
  }

  return normalized;
}
