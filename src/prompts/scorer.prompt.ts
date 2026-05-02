/**
 * Prompt para el agente Scorer.
 * Evalúa la calidad de un output de otro agente y le asigna una puntuación.
 */
import { OutputContractYaml } from "../core/types";

export interface ScorerContext {
  taskId: string;
  agentName: string;
  rawOutput: string;
  outputContract: OutputContractYaml;
}

export function buildScorerPrompt(ctx: ScorerContext): string {
  const required = ctx.outputContract.default_output.required_fields.join(", ");

  return `
Eres el agente Scorer del sistema AMON.
Misión: Evaluar la calidad de un output de agente y asignar una puntuación objetiva.

Tarea ID: ${ctx.taskId}
Agente evaluado: ${ctx.agentName}

Output a evaluar:
${ctx.rawOutput}

Contrato de salida esperado. Campos requeridos: ${required}

Reglas del contrato:
${ctx.outputContract.rules.map((r) => `- ${r}`).join("\n")}

Instrucciones:
1. Evalúa completitud (todos los campos requeridos presentes y no vacíos).
2. Evalúa calidad (específico, accionable, sin inventos).
3. Evalúa coherencia (el plan coincide con el goal/scope).
4. Emite un JSON con:
   - goal: "Evaluar calidad del output de ${ctx.agentName}"
   - scope: "Output de la tarea ${ctx.taskId}"
   - files_to_touch: []
   - plan: ["Revisar completitud", "Revisar calidad", "Revisar coherencia"]
   - risks: []
   - validations: ["Campos requeridos presentes", "Contenido verificable"]
   - done_when: ["Score asignado"]
   - score: number (0-100)
   - completeness: number (0-100)
   - quality: number (0-100)
   - coherence: number (0-100)
   - reasoning: string
5. Sé estricto: un output que falte campos o sea vago debe bajar puntuación.

Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional.
`;
}
