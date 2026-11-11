import { AGENT_REGISTRY } from '../agents/registry';
import { AgentName } from '../core/types';
import { Action, actions, parseMission, planHash, safeId } from './contracts';
import { Capability, capabilities, loadCapabilityCatalog, roles } from './capabilities';

/** Structured requirements are supplied by the trusted host, never inferred from mission prose. */
export interface AssignmentRequest { assignmentId: string; action: Action; requiredCapabilities: Capability[] }
export interface ProposalHost { repositoryAliases: string[]; allowedActions: Action[] }
export interface Candidate {
  role: AgentName; available: boolean; actionCompatible: boolean;
  missingCapabilities: Capability[]; matches: boolean;
}
export interface AssignmentProposal {
  schemaVersion: 'assignment-proposal/1'; status: 'proposed' | 'blocked';
  executionAuthorized: false; approvalRequired: true; errors: string[];
  sourcePlanHash?: string; assignmentId?: string; originalRole?: AgentName; proposedRole?: AgentName;
  requestedAction?: Action; requiredCapabilities: Capability[]; candidates: Candidate[];
  permissions?: {host: boolean; mission: boolean; assignment: boolean};
}
function exact(value: any, keys: string[]): boolean {
  return value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).sort().join(',') === keys.sort().join(',');
}
function validList(v: unknown, allowed: readonly string[]): boolean {
  return Array.isArray(v) && v.length <= allowed.length && new Set(v).size === v.length && v.every(x => allowed.includes(x));
}

/** A proposal only: no plan/state mutation, approval creation, executor invocation or scheduling.
 * All capabilities must match. Ambiguity blocks instead of silently choosing by catalog order.
 */
export function proposeAssignment(input: unknown, request: unknown, host: unknown): AssignmentProposal {
  const result: AssignmentProposal = {schemaVersion: 'assignment-proposal/1', status: 'blocked',
    executionAuthorized: false, approvalRequired: true, errors: [], requiredCapabilities: [], candidates: []};
  try {
    const m = parseMission(input);
    const r = request as AssignmentRequest, h = host as ProposalHost;
    if (!exact(r, ['assignmentId','action','requiredCapabilities']) || !safeId(r.assignmentId) ||
        !actions.includes(r.action) || !validList(r.requiredCapabilities, capabilities) || !r.requiredCapabilities.length) throw new Error('INVALID_ASSIGNMENT_REQUEST');
    if (!exact(h, ['repositoryAliases','allowedActions']) || !Array.isArray(h.repositoryAliases) ||
        h.repositoryAliases.length > 100 || !h.repositoryAliases.every(safeId) ||
        new Set(h.repositoryAliases).size !== h.repositoryAliases.length || !validList(h.allowedActions, actions)) throw new Error('INVALID_PROPOSAL_HOST');
    const a = m.assignments.find(a => a.assignmentId === r.assignmentId);
    if (!a) throw new Error('UNKNOWN_ASSIGNMENT');
    Object.assign(result, {sourcePlanHash: planHash(m), assignmentId: a.assignmentId, originalRole: a.role,
      requestedAction: r.action, requiredCapabilities: [...r.requiredCapabilities].sort()});
    if (!h.repositoryAliases.includes(m.repositoryAlias)) throw new Error('UNKNOWN_REPOSITORY');
    result.permissions = {host: h.allowedActions.includes(r.action), mission: m.authorizationPolicy.allowedActions.includes(r.action),
      assignment: a.allowedActions.includes(r.action)};
    const catalog = loadCapabilityCatalog();
    result.candidates = roles.map(role => {
      const entry = catalog.agents[role];
      const available = typeof AGENT_REGISTRY[role] === 'function';
      const actionCompatible = entry.actions.includes(r.action);
      const missingCapabilities = result.requiredCapabilities.filter(c => !entry.capabilities.includes(c));
      return {role, available, actionCompatible, missingCapabilities, matches: available && actionCompatible && missingCapabilities.length === 0};
    });
    if (!Object.values(result.permissions).every(Boolean)) throw new Error('ACTION_OUT_OF_SCOPE');
    const matches = result.candidates.filter(c => c.matches);
    if (!matches.length) throw new Error('NO_CAPABLE_AGENT');
    if (matches.length !== 1) throw new Error('AMBIGUOUS_CAPABILITIES');
    result.proposedRole = matches[0].role;
    result.status = 'proposed';
  } catch (error) {
    const code = error instanceof Error ? error.message : '';
    result.errors = [/^[A-Z_]+$/.test(code) ? code : 'PROPOSAL_VALIDATION_FAILED'];
  }
  return result;
}

export function renderAssignmentProposal(p: AssignmentProposal): string {
  const lines = [p.status === 'proposed' ? `PROPUESTA: ${p.proposedRole}` : `BLOQUEADO: ${p.errors.join(', ')}`,
    `Capacidades requeridas: ${p.requiredCapabilities.join(', ') || 'solicitud inválida'}. Acción: ${p.requestedAction || 'ninguna'}.`];
  for (const c of p.candidates) lines.push(`${c.matches ? 'CUMPLE' : 'DESCARTADO'} ${c.role}: ejecutor=${c.available ? 'disponible' : 'no disponible'}; acción compatible=${c.actionCompatible ? 'sí' : 'no'}; capacidades faltantes=${c.missingCapabilities.join(', ') || 'ninguna'}.`);
  if (p.permissions) lines.push(`Permisos: host=${p.permissions.host}; misión=${p.permissions.mission}; asignación=${p.permissions.assignment}.`);
  lines.push('No concede autorización ni ejecuta tareas. Revisar el plan resultante y aprobar su hash antes de avanzar.');
  return lines.join('\n');
}
