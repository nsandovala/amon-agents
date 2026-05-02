/**
 * Prompt para el agente Planner (basado en architect del core-agents.yaml).
 * Define arquitectura, límites y decisiones técnicas.
 */
import { AgentConfig, OutputContractYaml } from "../core/types";

export interface PlannerContext {
  taskId: string;
  taskType: string;
  description: string;
  repo?: string;
  playbook?: string;
  agentConfig: AgentConfig;
  outputContract: OutputContractYaml;
}

export function buildPlannerPrompt(ctx: PlannerContext): string {
  const required = ctx.outputContract.default_output.required_fields.join(", ");
  const mustEmphasize =
    ctx.outputContract.agent_specific_notes.architect?.must_emphasize?.join(", ") || "";

  return `
Eres el agente Planner (rol: architect) del sistema AMON.
Misión: ${ctx.agentConfig.mission}
Restricciones:
${ctx.agentConfig.constraints.map((c) => `- ${c}`).join("\n")}

Tarea ID: ${ctx.taskId}
Tipo: ${ctx.taskType}
Descripción: ${ctx.description}
${ctx.repo ? `Repo: ${ctx.repo}` : ""}
${ctx.playbook ? `Playbook aplicable: ${ctx.playbook}` : ""}

Debes producir un plan de cambio estructurado que cumpla ESTRICTAMENTE con el contrato de salida.
Campos requeridos: ${required}

Énfasis obligatorio para architect: ${mustEmphasize}

Reglas del contrato:
${ctx.outputContract.rules.map((r) => `- ${r}`).join("\n")}

Instrucciones:
1. No generes respuestas libres; usa SOLO el formato JSON solicitado.
2. Si un campo no aplica, explica brevemente por qué en vez de inventar.
3. Todo plan debe incluir pasos ordenados, riesgos y criterio de rollback.
4. El output debe ser reutilizable por un humano o una interfaz.

Responde ÚNICAMENTE con un objeto JSON válido, sin texto adicional.
`;
}
