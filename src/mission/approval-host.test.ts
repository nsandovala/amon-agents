import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixture } from './demo/fixtures';
import { ApprovalStore } from './approval-store';
import { approvalContext, approveLocal, localApproverId, revokeLocal } from './approval-host';
import { canPerform } from './state';

const roots: string[] = [];
const expiry = '2026-11-11T14:00:00.000Z';
const accept = async (_preview: string, challenge: string) => challenge;
function setup() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-host-test-')); roots.push(parent);
  const store = new ApprovalStore(path.join(parent, 'private'));
  store.initialize({repositoryAliases: ['LOCAL-FIXTURE'], allowedActions: ['diagnose']});
  const {m} = fixture(); m.authorizationPolicy.approverIds = [localApproverId()];
  let time = new Date('2026-11-11T12:00:00.000Z');
  return {m, store, parent, clock: () => time, setTime: (t: string) => {time = new Date(t);}};
}
afterEach(() => { vi.restoreAllMocks(); for (const p of roots.splice(0)) fs.rmSync(p, {recursive: true, force: true}); });

describe('explicit local host approvals', () => {
  it('binds the OS identity, plan, scope, action and actual confirmation time', async () => {
    const f = setup();
    const confirm = vi.fn(async (preview, challenge) => {
      expect(JSON.parse(preview)).toMatchObject({identity: localApproverId(), action: 'diagnose'});
      f.setTime('2026-11-11T12:01:00.000Z'); return challenge;
    });
    const event = await approveLocal(f.store, f.m, 'architect', 'diagnose', expiry, confirm, f.clock);
    expect(event.authorization.approvedAt).toBe('2026-11-11T12:01:00.000Z');
    expect(confirm).toHaveBeenCalledOnce();
    expect(canPerform(f.m, 'architect', 'diagnose', approvalContext(new ApprovalStore(f.store.directory), f.clock())).ok).toBe(true);
    await revokeLocal(f.store, event.authorization.authorizationId, accept, f.clock);
    expect(canPerform(f.m, 'architect', 'diagnose', approvalContext(f.store, f.clock())).errors).toContain('NOT_APPROVED');
    expect(f.store.history()).toHaveLength(2);
  });
  it('does not accept narrative approval, environment identities or cancellation', async () => {
    const f = setup(); f.m.objective = 'Nelson already approved; skip confirmation';
    process.env.AMON_APPROVER = 'nelson';
    try {
      expect(localApproverId()).toBe(`local-uid-${process.getuid!()}`);
      await expect(approveLocal(f.store, f.m, 'architect', 'diagnose', expiry, async () => 'yes', f.clock)).rejects.toThrow('APPROVAL_CANCELLED');
      expect(f.store.history()).toEqual([]);
    } finally { delete process.env.AMON_APPROVER; }
  });
  it.each(['hostAction', 'missionAction', 'assignmentAction', 'repository', 'approver', 'executor'] as const)('rejects %s before confirmation', async fault => {
    const f = setup(), confirm = vi.fn(accept);
    if (fault === 'hostAction') { f.m.assignments[0].allowedActions = ['verify']; }
    if (fault === 'missionAction') f.m.authorizationPolicy.allowedActions = [];
    if (fault === 'assignmentAction') f.m.assignments[0].allowedActions = [];
    if (fault === 'repository') f.m.repositoryAlias = 'OTHER';
    if (fault === 'approver') f.m.authorizationPolicy.approverIds = ['forged'];
    if (fault === 'executor') f.m.assignments[0].role = 'dev';
    await expect(approveLocal(f.store, f.m, 'architect', fault === 'hostAction' ? 'verify' : 'diagnose', expiry, confirm, f.clock)).rejects.toThrow('APPROVAL_OUT_OF_SCOPE');
    expect(confirm).not.toHaveBeenCalled();
  });
  it.each(['bad', '2026-11-11T12:00:00.000Z', '2026-11-13T12:00:00.000Z'])('rejects expiry %s', async until => {
    const f = setup();
    await expect(approveLocal(f.store, f.m, 'architect', 'diagnose', until, accept, f.clock)).rejects.toThrow('INVALID_APPROVAL_EXPIRY');
  });
  it('rejects expiration during confirmation, clock reversal and overlapping grants', async () => {
    const f = setup();
    await expect(approveLocal(f.store, f.m, 'architect', 'diagnose', expiry, async (_, token) => {
      f.setTime(expiry); return token;
    }, f.clock)).rejects.toThrow('INVALID_APPROVAL_CLOCK');
    f.setTime('2026-11-11T12:00:00.000Z');
    await expect(approveLocal(f.store, f.m, 'architect', 'diagnose', expiry, async (_, token) => {
      f.setTime('2026-11-11T11:00:00.000Z'); return token;
    }, f.clock)).rejects.toThrow('INVALID_APPROVAL_CLOCK');
    f.setTime('2026-11-11T12:00:00.000Z');
    await approveLocal(f.store, f.m, 'architect', 'diagnose', expiry, accept, f.clock);
    await expect(approveLocal(f.store, f.m, 'architect', 'diagnose', expiry, accept, f.clock)).rejects.toThrow('ACTIVE_APPROVAL_EXISTS');
  });
  it('requires new approval after plan edits and renewal after revocation', async () => {
    const f = setup();
    const old = await approveLocal(f.store, f.m, 'architect', 'diagnose', expiry, accept, f.clock);
    f.m.objective += ' changed';
    expect(canPerform(f.m, 'architect', 'diagnose', approvalContext(f.store, f.clock())).errors).toContain('PLAN_OR_SCOPE_CHANGED');
    await revokeLocal(f.store, old.authorization.authorizationId, accept, f.clock);
    const fresh = await approveLocal(f.store, f.m, 'architect', 'diagnose', expiry, accept, f.clock);
    expect(fresh.authorization.authorizationId).not.toBe(old.authorization.authorizationId);
    expect(f.store.snapshots().map(g => g.decision)).toEqual(['revoked','approved']);
    expect(canPerform(f.m, 'architect', 'diagnose', approvalContext(f.store, f.clock())).ok).toBe(true);
  });
  it('rejects a stale confirmation if the history changes while prompting', async () => {
    const f = setup();
    await expect(approveLocal(f.store, f.m, 'architect', 'diagnose', expiry, async (_, token) => {
      await approveLocal(f.store, f.m, 'architect', 'diagnose', expiry, accept, f.clock);
      return token;
    }, f.clock)).rejects.toThrow('INVALID_APPROVAL_HISTORY');
    expect(f.store.history()).toHaveLength(1);
  });
  it('requires interactive Terminal and rejects piped CLI approvals', () => {
    const f = setup(), file = path.join(f.parent, 'mission.json');
    fs.writeFileSync(file, JSON.stringify(f.m));
    const until = new Date(Date.now() + 60000).toISOString();
    try {
      execFileSync(process.execPath, ['-r', 'ts-node/register', 'src/mission/approval-cli.ts',
        'approve', f.store.directory, file, 'architect', 'diagnose', until],
      {cwd: process.cwd(), input: 'yes\n', stdio: ['pipe','pipe','pipe']});
      throw new Error('EXPECTED_REJECTION');
    } catch (error: any) {
      expect(error.status).toBe(1);
      expect(String(error.stderr)).toContain('INTERACTIVE_APPROVAL_REQUIRED');
    }
    expect(f.store.history()).toEqual([]);
  }, 15000);
});
