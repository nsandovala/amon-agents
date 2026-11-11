import { AuthorizationContract, isAuthorization, safeId } from './contracts';

/** Internal journal format. Authentication and integrity verification precede replay. */
export interface ApprovalEvent {
  sequence: number;
  recordedAt: string;
  actorId: string;
  kind: 'approved' | 'revoked';
  authorization: AuthorizationContract;
}

function fail(): never { throw new Error('INVALID_APPROVAL_HISTORY'); }

/** Reconstruct one current snapshot per ID, retaining the full immutable history separately.
 * This function validates consistency; it does not authenticate an actor or grant authority.
 */
export function replayApprovals(input: unknown): AuthorizationContract[] {
  if (!Array.isArray(input) || input.length > 10000) fail();
  const snapshots = new Map<string, AuthorizationContract>();
  let lastTime = -Infinity;
  for (const [index, value] of input.entries()) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
    const e = value as ApprovalEvent;
    if (Object.keys(e).sort().join(',') !== 'actorId,authorization,kind,recordedAt,sequence' ||
        e.sequence !== index + 1 || !safeId(e.actorId) || typeof e.recordedAt !== 'string' ||
        !Number.isFinite(Date.parse(e.recordedAt)) || new Date(e.recordedAt).toISOString() !== e.recordedAt ||
        Date.parse(e.recordedAt) < lastTime || !isAuthorization(e.authorization)) fail();
    const a = e.authorization;
    const previous = snapshots.get(a.authorizationId);
    if (e.kind === 'approved') {
      if (previous || a.decision !== 'approved' || a.approvedBy !== e.actorId ||
          a.approvedAt !== e.recordedAt || a.issuedAt !== e.recordedAt) fail();
    } else if (e.kind === 'revoked') {
      if (!previous || previous.decision !== 'approved' || a.decision !== 'revoked') fail();
      // A revocation cannot change the original scope, plan, identity or approval time.
      for (const key of Object.keys(previous) as (keyof AuthorizationContract)[]) {
        if (key !== 'decision' && a[key] !== previous[key]) fail();
      }
    } else fail();
    snapshots.set(a.authorizationId, structuredClone(a));
    lastTime = Date.parse(e.recordedAt);
  }
  return [...snapshots.values()];
}
