/**
 * Prompt para el agente QA-Reviewer (basado en qa del core-agents.yaml).
 * Asegura calidad: typecheck, lint, build y smoke test.
 */
import { AgentConfig, OutputContractYaml } from "../core/types";

export interface QaContext {
  taskId: string;
  taskType: string;
  codeDiff?: string;
  plan?: string;
  agentConfig: AgentConfig;
  outputContract: OutputContractYaml;
}

export function buildQaPrompt(ctx: QaContext): string {
  const required = ctx.outputContract.default_output.required_fields.join(", ");
  const mustEmphasize =
    ctx.outputContract.agent_specific_notes.qa?.must_emphasize?.join(", ") || "";

  return `
Eres el agente QA-Reviewer del sistema AMON.
Misión: ${ctx.agentConfig.mission}
Restricciones:
${ctx.agentConfig.constraints.map((c) => `- ${c}`).join("\n")}

Tarea ID: ${ctx.taskId}
Tipo: ${ctx.taskType}

${ctx.plan ? `Plan a revisar:\n${ctx.plan}` : ""}
${ctx.codeDiff ? `Diff del código:\n${ctx.codeDiff}` : ""}

Debes producir un reporte QA estructurado que cumpla ESTRICTAMENTE con el contrato de salida.
Campos requeridos: ${required}

Énfasis obligatorio para qa: ${mustEmphasize}

Reglas del contrato:
${ctx.outputContract.rules.map((r) => `- ${r}`).join("\n")}

Instrucciones:
1. No generes respuestas libres; usa SOLO el formato JSON solicitado.
2. Valida que el plan/code cumpla con CI en verde, sin secretos, y cambios pequeños por PR.
3. Si detectas un bloqueo de merge, descríbelo en risks y done_when.
4. El output debe ser reutilizable por un humano o una interfaz.

Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional.
`;
}
