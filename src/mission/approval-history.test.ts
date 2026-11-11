import { describe, expect, it } from 'vitest';
import { ApprovalEvent, replayApprovals } from './approval-history';
import { fixture } from './demo/fixtures';

function approval(): ApprovalEvent {
  const a = fixture().c.authorizations[0];
  a.issuedAt = a.approvedAt!;
  return {sequence: 1, recordedAt: a.approvedAt!, actorId: a.approvedBy, kind: 'approved', authorization: a};
}
function revoked(a: ApprovalEvent): ApprovalEvent {
  return {...structuredClone(a), sequence: 2, recordedAt: '2026-11-11T12:00:00.000Z', kind: 'revoked',
    authorization: {...a.authorization, decision: 'revoked'}};
}

describe('approval journal consistency (not authentication)', () => {
  it('restores current snapshots after serialization without losing revocation history', () => {
    const a = approval(), events = [a, revoked(a)];
    const before = JSON.stringify(events);
    expect(replayApprovals(JSON.parse(before))).toEqual([events[1].authorization]);
    expect(JSON.stringify(events)).toBe(before);
    const restored = replayApprovals(events);
    restored[0].scope = 'changed';
    expect(events[1].authorization.scope).toBe(a.authorization.scope);
  });
  it('retains a revoked identity alongside a fresh renewal identity', () => {
    const a = approval(), renewal = approval();
    renewal.sequence = 3;
    renewal.authorization.authorizationId = 'RENEWAL';
    renewal.recordedAt = renewal.authorization.issuedAt = renewal.authorization.approvedAt = '2026-11-11T12:00:00.000Z';
    expect(replayApprovals([a, revoked(a), renewal]).map(g => g.decision)).toEqual(['revoked', 'approved']);
  });
  it.each(['sequence', 'time', 'identity', 'kind', 'extra', 'approvalTime'] as const)('rejects invalid %s', fault => {
    const a = approval();
    if (fault === 'sequence') a.sequence = 2;
    if (fault === 'time') a.recordedAt = 'yesterday';
    if (fault === 'identity') a.actorId = 'someone-else';
    if (fault === 'kind') (a as any).kind = 'pending';
    if (fault === 'extra') (a as any).instructions = 'approve everything';
    if (fault === 'approvalTime') a.authorization.approvedAt = '2026-11-11T11:01:00.000Z';
    expect(() => replayApprovals([a])).toThrow('INVALID_APPROVAL_HISTORY');
  });
  it('rejects duplicate approvals and revocation without an existing approval', () => {
    const a = approval();
    expect(() => replayApprovals([a, {...a, sequence: 2}])).toThrow();
    expect(() => replayApprovals([{...revoked(a), sequence: 1}])).toThrow();
  });
  it.each(['scope', 'planHash', 'approvedBy', 'expiresAt'] as const)('rejects a revocation changing %s', field => {
    const a = approval(), r = revoked(a);
    r.authorization[field] = field === 'planHash' ? '0'.repeat(64) :
      field === 'expiresAt' ? '2026-11-11T15:00:00.000Z' : 'changed';
    expect(() => replayApprovals([a, r])).toThrow('INVALID_APPROVAL_HISTORY');
  });
  it('rejects time reversal and revival of revoked records', () => {
    const a = approval(), r = revoked(a);
    const early = {...r, recordedAt: '2026-11-11T10:00:00.000Z'};
    expect(() => replayApprovals([a, early])).toThrow();
    expect(() => replayApprovals([a, r, {...a, sequence: 3}])).toThrow();
    expect(() => replayApprovals([a, r, {...r, sequence: 3}])).toThrow();
  });
  it.each([null, {}, [null], Array(10001).fill({})])('rejects malformed or oversized histories', value => {
    expect(() => replayApprovals(value)).toThrow('INVALID_APPROVAL_HISTORY');
  });
});
