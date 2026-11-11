import { AGENT_REGISTRY } from '../agents/registry';
import { Action, AuthorizationContract, EvidenceContract, MissionContract, State, isAuthorization, isEvidence, parseMission, planHash } from './contracts';

export const transitions: Record<State, readonly State[]> = {
  draft: ['planned','blocked','failed'], planned: ['awaiting_approval','blocked','failed'],
  awaiting_approval: ['approved','blocked','failed'], approved: ['ready','blocked','failed'],
  ready: ['completed','blocked','failed'], blocked: ['planned','blocked','failed'],
  failed: ['planned','blocked'], completed: [],
};
/** Trusted host inputs, never extracted from mission prose or accepted as an LLM-issued grant.
 * v0.1 performs no execution and exposes no API for receiving these inputs remotely. */
export interface Context {
  // One current snapshot per authorizationId; historical records with distinct IDs may remain.
  // Revocation replaces that ID's decision. Revoke overlapping grants before renewing.
  now: Date; authorizations: AuthorizationContract[]; evidence: EvidenceContract[];
  repositoryAliases: string[]; approverIds: string[]; allowedActions: Action[];
}
export interface Result { ok: boolean; status: State; mission?: MissionContract; errors: string[] }
function requireThat(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code); }
function validateContext(m: MissionContract, c: Context): void {
  requireThat(Number.isFinite(c.now.getTime()), 'INVALID_CLOCK');
  requireThat(c.repositoryAliases.includes(m.repositoryAlias), 'UNKNOWN_REPOSITORY');
  requireThat(c.authorizations.every(isAuthorization) && c.evidence.every(isEvidence), 'INVALID_CONTEXT');
  requireThat(new Set(c.authorizations.map(a => a.authorizationId)).size === c.authorizations.length, 'DUPLICATE_AUTHORIZATION');
  requireThat(new Set(c.evidence.map(e => e.evidenceReference)).size === c.evidence.length && new Set(c.evidence.map(e => e.jobId)).size === c.evidence.length, 'DUPLICATE_EVIDENCE');
  for (const ref of [...m.evidenceRefs, ...m.assignments.flatMap(a => a.evidenceRefs)]) {
    const e = c.evidence.find(e => e.evidenceReference === ref);
    requireThat(e && e.missionId === m.missionId && e.verifiedBaseSha === m.baseSha && e.verifiedBranch === m.branch && Date.parse(e.observedAt) <= c.now.getTime(), 'INVALID_EVIDENCE_REFERENCE');
  }
}
function authorized(m: MissionContract, id: string, action: Action, c: Context): AuthorizationContract {
  const a = m.assignments.find(a => a.assignmentId === id);
  requireThat(a, 'UNKNOWN_ASSIGNMENT');
  requireThat(typeof AGENT_REGISTRY[a.role] === 'function', 'EXECUTOR_UNAVAILABLE');
  requireThat(a.allowedActions.includes(action) && m.authorizationPolicy.allowedActions.includes(action) && c.allowedActions.includes(action), 'ACTION_OUT_OF_SCOPE');
  const matching = c.authorizations.filter(g => g.missionId === m.missionId && g.assignmentId === id && g.action === action);
  requireThat(matching.length > 0, 'AUTHORIZATION_MISSING_OR_AMBIGUOUS');
  const approved = matching.filter(g => g.decision === 'approved');
  requireThat(approved.length > 0, 'NOT_APPROVED');
  const grants = approved.filter(g => authorizationStatus(g, c.now) === 'approved');
  requireThat(grants.length > 0, 'AUTHORIZATION_EXPIRED_OR_FUTURE');
  requireThat(grants.length === 1, 'AUTHORIZATION_MISSING_OR_AMBIGUOUS');
  const g = grants[0];
  requireThat(g.decision === 'approved' && c.approverIds.includes(g.approvedBy) && m.authorizationPolicy.approverIds.includes(g.approvedBy), 'NOT_APPROVED');
  requireThat(g.planVersion === m.planVersion && g.planHash === planHash(m) && g.scope === a.scope, 'PLAN_OR_SCOPE_CHANGED');
  return g;
}
function completed(m: MissionContract, id: string, c: Context): void {
  const a = m.assignments.find(a => a.assignmentId === id)!;
  requireThat(a.allowedActions.length > 0, 'NO_ACTIONS');
  for (const action of a.allowedActions) {
    const grant = authorized(m, id, action, c);
    requireThat(a.evidenceRefs.some(ref => c.evidence.some(e => e.evidenceReference === ref && e.source === 'assignment' && e.assignmentId === id && e.missionId === m.missionId && e.planHash === planHash(m) && e.action === action && e.status === 'done' && e.verifiedBaseSha === m.baseSha && e.verifiedBranch === m.branch && Date.parse(e.observedAt) >= Date.parse(grant.approvedAt!) && Date.parse(e.observedAt) <= c.now.getTime())), 'COMPLETION_EVIDENCE_MISSING');
  }
  for (const dep of a.dependencies) {
    requireThat(m.assignments.find(a => a.assignmentId === dep)?.status === 'completed', 'DEPENDENCY_INCOMPLETE');
    completed(m, dep, c);
  }
}
function readiness(m: MissionContract, id: string, c: Context): void {
  const a = m.assignments.find(a => a.assignmentId === id)!;
  requireThat(a.allowedActions.length > 0, 'NO_ACTIONS');
  a.allowedActions.forEach(action => authorized(m, id, action, c));
  for (const dep of a.dependencies) {
    requireThat(m.assignments.find(a => a.assignmentId === dep)?.status === 'completed', 'DEPENDENCY_INCOMPLETE');
    completed(m, dep, c);
  }
}
/** Recheck both mission-wide and assignment claims; snapshots carry no approval authority. */
function validateClaims(m: MissionContract, c: Context): void {
  if (['approved','ready','completed'].includes(m.status)) {
    for (const a of m.assignments) {
      requireThat(a.allowedActions.length > 0, 'NO_ACTIONS');
      a.allowedActions.forEach(action => authorized(m, a.assignmentId, action, c));
      if (m.status === 'ready' || m.status === 'completed') readiness(m, a.assignmentId, c);
      if (m.status === 'completed') {
        requireThat(a.status === 'completed', 'ASSIGNMENT_INCOMPLETE');
        completed(m, a.assignmentId, c);
      }
    }
  }
  for (const a of m.assignments) {
    if (a.status === 'completed') completed(m, a.assignmentId, c);
    if (a.status === 'approved' || a.status === 'ready') {
      requireThat(a.allowedActions.length > 0, 'NO_ACTIONS');
      a.allowedActions.forEach(action => authorized(m, a.assignmentId, action, c));
    }
    if (a.status === 'ready') readiness(m, a.assignmentId, c);
  }
}
/** Fail closed and return a blocked snapshot. Never mutates input or worker jobs. */
export function transition(input: unknown, target: State, c: Context, assignmentId?: string): Result {
  let m: MissionContract | undefined;
  try {
    m = parseMission(input); validateContext(m, c);
    const entity = assignmentId === undefined ? m : m.assignments.find(a => a.assignmentId === assignmentId);
    requireThat(entity, 'UNKNOWN_ASSIGNMENT');
    requireThat(transitions[entity.status].includes(target), 'INVALID_TRANSITION');
    validateClaims(m, c);
    const selected = assignmentId ? [m.assignments.find(a => a.assignmentId === assignmentId)!] : m.assignments;
    if (['approved','ready','completed'].includes(target)) {
      requireThat(!assignmentId || ['approved','ready'].includes(m.status), 'MISSION_NOT_APPROVED');
      for (const a of selected) {
        requireThat(a.allowedActions.length > 0, 'NO_ACTIONS');
        a.allowedActions.forEach(action => authorized(m!, a.assignmentId, action, c));
        if (target === 'ready' || target === 'completed') readiness(m, a.assignmentId, c);
        if (target === 'completed') {
          requireThat(!!assignmentId || a.status === 'completed', 'ASSIGNMENT_INCOMPLETE');
          completed(m, a.assignmentId, c);
        }
      }
    }
    entity.status = target;
    return {ok: true, status: target, mission: m, errors: []};
  } catch (err) {
    if (m) { m.status = 'blocked'; const a = m.assignments.find(a => a.assignmentId === assignmentId); if (a) a.status = 'blocked'; }
    return {ok: false, status: 'blocked', mission: m, errors: [(err as Error).message]};
  }
}
/** Eligibility check only. No executor is invoked. */
export function canPerform(input: unknown, assignmentId: string, action: Action, c: Context): Result {
  let m: MissionContract | undefined;
  try {
    m = parseMission(input); validateContext(m, c);
    requireThat(['approved','ready'].includes(m.status), 'MISSION_NOT_APPROVED');
    requireThat(m.assignments.find(a => a.assignmentId === assignmentId)?.status === 'ready', 'ASSIGNMENT_NOT_READY');
    authorized(m, assignmentId, action, c); readiness(m, assignmentId, c);
    validateClaims(m, c);
    return {ok: true, status: 'ready', mission: m, errors: []};
  } catch (err) {
    if (m) m.status = 'blocked';
    return {ok: false, status: 'blocked', mission: m, errors: [(err as Error).message]};
  }
}

export function authorizationStatus(value: unknown, now: Date): AuthorizationContract['decision'] | 'expired' | 'invalid' {
  if (!isAuthorization(value) || !Number.isFinite(now.getTime()) || Date.parse(value.issuedAt) > now.getTime() || (value.approvedAt !== null && Date.parse(value.approvedAt) > now.getTime())) return 'invalid';
  if (Date.parse(value.expiresAt) <= now.getTime()) return 'expired';
  return value.decision;
}
/** Bookkeeping for a trusted host approval, not an approval endpoint or identity authenticator. */
export function transitionAuthorization(value: unknown, decision: AuthorizationContract['decision'], now: Date): AuthorizationContract {
  const status = authorizationStatus(value, now);
  const edges: Record<string, string[]> = {pending: ['approved','denied'], approved: ['revoked'], denied: [], revoked: [], expired: [], invalid: []};
  if (!isAuthorization(value) || !edges[status].includes(decision)) throw new Error('INVALID_AUTHORIZATION_TRANSITION');
  return {...value, decision, approvedAt: decision === 'approved' ? now.toISOString() : value.approvedAt};
}
