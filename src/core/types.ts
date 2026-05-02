/**
 * Tipos del sistema AMON, derivados de los YAMLs existentes en core/.
 * Estos tipos reflejan la configuración/documentación viva.
 */

export type AgentName =
  | "architect"
  | "designer"
  | "dev"
  | "qa"
  | "security"
  | "ops";

export type TaskType =
  | "feature_small"
  | "ui_change"
  | "bugfix"
  | "infra_change"
  | "security_check"
  | "research_task";

export interface AgentConfig {
  mission: string;
  deliverables: string[];
  constraints: string[];
}

export interface CoreAgentsYaml {
  version: number;
  org: {
    name: string;
    principle: string;
    default_language: string;
  };
  global_rules: string[];
  agents: Record<AgentName, AgentConfig>;
}

export interface TaskTypeConfig {
  description: string;
  flow: AgentName[];
  output_path: string;
}

export interface RoutingYaml {
  version: number;
  task_types: Record<TaskType, TaskTypeConfig>;
  routing_rules: string[];
  notes: string[];
}

export interface GlobalRulesYaml {
  version: string;
  rules: string[];
  operating_principles: string[];
  anti_patterns: string[];
}

export interface AgentOwnershipYaml {
  version: number;
  agents: Record<
    AgentName,
    {
      scope: string[];
      approve_changes?: boolean;
      requires_review?: boolean;
      blocks_merge_on_failure?: boolean;
      review_mandatory_for?: string[];
    }
  >;
}

export interface OutputContractField {
  description: string;
  type: string;
}

export interface OutputContractYaml {
  version: number;
  default_output: {
    required_fields: string[];
  };
  field_rules: Record<string, OutputContractField>;
  agent_specific_notes: Record<
    AgentName,
    {
      must_emphasize: string[];
    }
  >;
  rules: string[];
}

/**
 * Contrato de salida estándar que deben respetar los agentes.
 */
export interface StandardOutput {
  goal: string;
  scope: string;
  files_to_touch: string[];
  plan: string[];
  risks: string[];
  validations: string[];
  done_when: string[];
  [key: string]: unknown;
}

export interface AgentResult<T = StandardOutput> {
  agent: AgentName;
  taskId: string;
  taskType: TaskType;
  output: T;
  rawResponse?: string;
  timestamp: string;
  valid: boolean;
  errors?: string[];
}

export interface PlaybookYaml {
  version: number;
  name?: string;
  description?: string;
  applies_to?: string[];
  goals?: string[];
  recommended_structure?: string[];
  agent_flow?: string[];
  checklist?: string[];
  anti_patterns?: string[];
  playbook?: string;
  purpose?: string;
  steps?: string[];
  checks?: string[];
}
