import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import { AgentName } from '../core/types';
import { Action, actions } from './contracts';

export const roles: readonly AgentName[] = ['architect','security','qa','ops','designer','dev'];
export const capabilities = ['architecture-plan','security-review','plan-qa','readiness-assessment','plan-review','ui-design','code-implementation'] as const;
export type Capability = typeof capabilities[number];
export interface AgentCapabilities { capabilities: Capability[]; actions: Action[] }
export interface CapabilityCatalog { version: 1; agents: Record<AgentName, AgentCapabilities> }

function keys(value: any, expected: readonly string[]): boolean {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === [...expected].sort().join(',');
}
function list(value: unknown, allowed: readonly string[]): boolean {
  return Array.isArray(value) && value.length > 0 && value.length <= allowed.length &&
    new Set(value).size === value.length && value.every(v => typeof v === 'string' && allowed.includes(v));
}
export function parseCatalog(input: unknown): CapabilityCatalog {
  const c = input as CapabilityCatalog;
  if (!keys(c, ['version','agents']) || c.version !== 1 || !keys(c.agents, roles) ||
      roles.some(role => !keys(c.agents[role], ['capabilities','actions']) ||
        !list(c.agents[role].capabilities, capabilities) || !list(c.agents[role].actions, actions))) {
    throw new Error('INVALID_CAPABILITY_CATALOG');
  }
  return structuredClone(c);
}

/** Fixed repository-owned configuration; no path or catalog supplied by mission prose. */
export function loadCapabilityCatalog(): CapabilityCatalog {
  try {
    return parseCatalog(yaml.load(fs.readFileSync(path.resolve(__dirname, '../../core/agent-capabilities.yaml'), 'utf8')));
  } catch { throw new Error('INVALID_CAPABILITY_CATALOG'); }
}
