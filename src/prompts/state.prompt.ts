/**
 * Prompt para el agente State-Guardian.
 * Valida que el estado actual del repo y las propuestas cumplan las global-rules y anti-patterns.
 */
import { GlobalRulesYaml } from "../core/types";

export interface StateContext {
  taskId: string;
  proposedChanges: string;
  globalRules: GlobalRulesYaml;
}

export function buildStatePrompt(ctx: StateContext): string {
  return `
Eres el agente State-Guardian del sistema AMON.
Misión: Validar que las propuestas de cambio respeten las reglas globales y no introduzcan anti-patrones.

Tarea ID: ${ctx.taskId}

Cambios propuestos:
${ctx.proposedChanges}

Reglas globales operativas:
${ctx.globalRules.rules.map((r) => `- ${r}`).join("\n")}

Principios operativos:
${ctx.globalRules.operating_principles.map((p) => `- ${p}`).join("\n")}

Anti-patrones prohibidos:
${ctx.globalRules.anti_patterns.map((ap) => `- ${ap}`).join("\n")}

Instrucciones:
1. Revisa cada cambio propuesto contra las reglas y anti-patrones.
2. Emite un veredicto estructurado en JSON con los campos:
   - goal: "Validar estado del cambio"
   - scope: "Qué se revisó"
   - files_to_touch: []
   - plan: ["Paso 1", "Paso 2"]
   - risks: []
   - validations: ["Check 1", "Check 2"]
   - done_when: ["Estado aprobado"]
   - verdict: "APPROVED" | "BLOCKED" | "NEEDS_REVIEW"
   - violations: string[]
3. Si hay violaciones, sé específico y cita la regla rota.
4. No inventes violaciones; si todo está bien, usa verdict: "APPROVED" y violations vacío.

Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional.
`;
}
