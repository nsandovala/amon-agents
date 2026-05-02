/**
 * Router de tareas basado en routing.yaml.
 * Determina el flujo de agentes para cada tipo de tarea.
 */
import { readFileSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import { AgentName, RoutingYaml, TaskType } from "../core/types";
import { error } from "../utils/logger";

const ROUTING_PATH = join(process.cwd(), "core", "routing.yaml");

let cachedRouting: RoutingYaml | null = null;

function loadRouting(): RoutingYaml {
  if (cachedRouting) return cachedRouting;
  try {
    const raw = readFileSync(ROUTING_PATH, "utf8");
    cachedRouting = yaml.load(raw) as RoutingYaml;
    return cachedRouting;
  } catch (e) {
    error(`[Router] No se pudo cargar routing.yaml desde ${ROUTING_PATH}`, e);
    throw e;
  }
}

/**
 * Devuelve el flujo de agentes para un tipo de tarea.
 */
export function getFlowForTaskType(taskType: TaskType): AgentName[] {
  const routing = loadRouting();
  const config = routing.task_types[taskType];
  if (!config) {
    throw new Error(`Router: task_type desconocido "${taskType}". Disponibles: ${Object.keys(routing.task_types).join(", ")}`);
  }
  return config.flow;
}

/**
 * Devuelve la ruta de output para un tipo de tarea.
 */
export function getOutputPathForTaskType(taskType: TaskType): string {
  const routing = loadRouting();
  const config = routing.task_types[taskType];
  if (!config) {
    throw new Error(`Router: task_type desconocido "${taskType}"`);
  }
  return config.output_path;
}

/**
 * Lista todos los tipos de tarea disponibles.
 */
export function listTaskTypes(): TaskType[] {
  const routing = loadRouting();
  return Object.keys(routing.task_types) as TaskType[];
}

/**
 * Devuelve las reglas de routing como array de strings.
 */
export function getRoutingRules(): string[] {
  const routing = loadRouting();
  return routing.routing_rules || [];
}
