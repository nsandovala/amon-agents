import { randomUUID } from 'node:crypto';
import { AGENT_REGISTRY } from '../agents/registry';
import { Action, EvidenceContract, isAuthorization, parseMission, planHash } from './contracts';
import { ApprovalEvent } from './approval-history';
import { ApprovalStore } from './approval-store';
import { Context, authorizationStatus } from './state';

export function localApproverId(): string {
  if (!process.getuid || !process.geteuid || process.getuid() !== process.geteuid()) throw new Error('UNSUPPORTED_APPROVAL_IDENTITY');
  return `local-uid-${process.getuid()}`;
}

/** Only the trusted local CLI supplies this confirmation function. Never expose it to a model,
 * HTTP caller or mission object. The OS owner (including processes with that UID) is trusted.
 */
export type Confirmation = (preview: string, challenge: string) => Promise<string>;

export function approvalContext(store: ApprovalStore, now: Date, evidence: EvidenceContract[] = []): Context {
  const policy = store.policy();
  return {now, ...policy, approverIds: [localApproverId()], authorizations: store.snapshots(), evidence};
}

export async function approveLocal(store: ApprovalStore, input: unknown, assignmentId: string, action: Action,
  expiresAt: string, confirm: Confirmation, clock: () => Date = () => new Date()): Promise<ApprovalEvent> {
  const m = parseMission(input), actorId = localApproverId(), now = clock();
  const a = m.assignments.find(a => a.assignmentId === assignmentId);
  const policy = store.policy(), history = store.history();
  if (!a || !m.authorizationPolicy.approverIds.includes(actorId) || !policy.repositoryAliases.includes(m.repositoryAlias) ||
      !policy.allowedActions.includes(action) || !m.authorizationPolicy.allowedActions.includes(action) ||
      !a.allowedActions.includes(action) || typeof AGENT_REGISTRY[a.role] !== 'function') throw new Error('APPROVAL_OUT_OF_SCOPE');
  if (!Number.isFinite(now.getTime()) || !Number.isFinite(Date.parse(expiresAt)) ||
      Date.parse(expiresAt) <= now.getTime() || Date.parse(expiresAt) - now.getTime() > 24 * 60 * 60 * 1000) throw new Error('INVALID_APPROVAL_EXPIRY');
  if (store.snapshots().some(g => g.missionId === m.missionId && g.assignmentId === assignmentId && g.action === action &&
      authorizationStatus(g, now) === 'approved')) throw new Error('ACTIVE_APPROVAL_EXISTS');
  const hash = planHash(m);
  const challenge = `APROBAR ${assignmentId} ${action} ${hash} ${expiresAt}`;
  const preview = JSON.stringify({identity: actorId, operation: 'approval-only-no-execution', planHash: hash, action,
    assignmentId, expiresAt, mission: m}, null, 2);
  if (await confirm(preview, challenge) !== challenge) throw new Error('APPROVAL_CANCELLED');
  const recordedAt = clock().toISOString();
  const authorization = {authorizationId: randomUUID(), missionId: m.missionId, assignmentId, action,
    approvedBy: actorId, planVersion: m.planVersion, planHash: hash, scope: a.scope,
    issuedAt: recordedAt, approvedAt: recordedAt, expiresAt, decision: 'approved' as const};
  if (Date.parse(recordedAt) < now.getTime() || !isAuthorization(authorization)) throw new Error('INVALID_APPROVAL_CLOCK');
  const event: ApprovalEvent = {sequence: history.length + 1, recordedAt, actorId, kind: 'approved', authorization};
  store.append(event); // Stale confirmations fail if any writer changed the sequence while the prompt was open.
  return event;
}

export async function revokeLocal(store: ApprovalStore, authorizationId: string, confirm: Confirmation,
  clock: () => Date = () => new Date()): Promise<ApprovalEvent> {
  const history = store.history();
  const grant = store.snapshots().find(g => g.authorizationId === authorizationId);
  if (!grant || grant.decision !== 'approved') throw new Error('APPROVAL_NOT_REVOCABLE');
  const actorId = localApproverId();
  if (grant.approvedBy !== actorId) throw new Error('APPROVAL_OUT_OF_SCOPE');
  const challenge = `REVOCAR ${authorizationId} ${grant.planHash}`;
  if (await confirm(JSON.stringify({identity: actorId, authorization: grant}, null, 2), challenge) !== challenge) throw new Error('APPROVAL_CANCELLED');
  const event: ApprovalEvent = {sequence: history.length + 1, recordedAt: clock().toISOString(), actorId,
    kind: 'revoked', authorization: {...grant, decision: 'revoked'}};
  store.append(event);
  return event;
}
