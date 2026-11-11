import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApprovalStore } from './approval-store';
import { readMissionFile } from './approval-cli';
import { isEvidence, planHash } from './contracts';
import { proposeAssignment } from './assignment-proposal';
import { authorizationStatus } from './state';
import { SupervisedResult } from './supervised';

interface BoardObservation {
  authorizationId: string; status: 'interrupted' | 'blocked' | 'completed';
  startedAt: string; finishedAt: string | null;
  evidence: {reference: string; headSha: string; branch: string; readmeSha256: string} | null;
}

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function requireThat(value: unknown): asserts value { if (!value) throw Error('BOARD_SOURCE_INVALID'); }
const timestamp = (s: unknown): s is string => typeof s === 'string' && Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
function present(store: ApprovalStore, name: string): boolean {
  try { fs.lstatSync(path.join(store.directory, name + '.json')); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}

/** An observation of the existing isolated inspector only. Does not run Git, agents,
 * approvals, or transactions. The private store and its OS owner remain the trust boundary.
 */
export function boardSnapshot(store: ApprovalStore, fixtureId: string, now = new Date()) {
  requireThat(UUID.test(fixtureId) && Number.isFinite(now.getTime()));
  const history = store.history(), before = JSON.stringify(history), policy = store.policy();
  requireThat(history.every(e => Date.parse(e.recordedAt) <= now.getTime()));
  const m = readMissionFile(path.join(store.directory, `mission-${fixtureId}.json`));
  const record = store.readExecutionRecord(`fixture-${fixtureId}`) as Record<string, unknown>;
  const hash = planHash(m);
  requireThat(record?.version === 1 && record.fixtureId === fixtureId && record.planHash === hash &&
    record.baseSha === m.baseSha && record.branch === m.branch && m.missionId === `SUPERVISED-${fixtureId}` &&
    m.repositoryAlias === 'MISSION-TEST' && m.branch === 'mission-test' && m.assignments.length === 1 &&
    m.assignments[0].assignmentId === 'inspect-fixture' && m.assignments[0].role === 'architect');
  const proposal = proposeAssignment(m, {assignmentId: 'inspect-fixture', action: 'diagnose', requiredCapabilities: ['architecture-plan']}, policy);
  requireThat(proposal.permissions && proposal.candidates.length === 6);
  const grants = store.snapshots().filter(g => g.missionId === m.missionId);
  requireThat(grants.length <= 100);
  const authorizations = grants.map(g => {
    requireThat(UUID.test(g.authorizationId) && g.planHash === hash && g.planVersion === m.planVersion &&
      g.assignmentId === 'inspect-fixture' && g.action === 'diagnose' && g.scope === m.assignments[0].scope &&
      m.authorizationPolicy.approverIds.includes(g.approvedBy) && Date.parse(g.issuedAt) <= now.getTime());
    return {id: g.authorizationId, decision: g.decision,
      effectiveStatus: authorizationStatus(g, now), approvedAt: g.approvedAt, expiresAt: g.expiresAt};
  });
  const observations = grants.flatMap<BoardObservation>(g => {
    const attemptName = `attempt-${g.authorizationId}`, resultName = `result-${g.authorizationId}`;
    if (!present(store, attemptName)) { requireThat(!present(store, resultName)); return []; }
    const a = store.readExecutionRecord(attemptName) as Record<string, unknown>;
    requireThat(a?.version === 1 && a.fixtureId === fixtureId && a.authorizationId === g.authorizationId && a.planHash === hash &&
      timestamp(a.startedAt) && g.approvedAt && Date.parse(a.startedAt) >= Date.parse(g.approvedAt) &&
      Date.parse(a.startedAt) < Date.parse(g.expiresAt) && Date.parse(a.startedAt) <= now.getTime());
    if (!present(store, resultName)) return [{authorizationId: g.authorizationId, status: 'interrupted' as const,
      startedAt: a.startedAt, finishedAt: null, evidence: null}];
    const r = store.readExecutionRecord(resultName) as SupervisedResult;
    requireThat(r?.version === 1 && r.fixtureId === fixtureId && r.authorizationId === g.authorizationId &&
      r.planHash === hash && r.executor === 'isolated-git-inspector' && r.startedAt === a.startedAt &&
      timestamp(r.finishedAt) && Date.parse(r.finishedAt) >= Date.parse(r.startedAt) && Date.parse(r.finishedAt) <= now.getTime());
    if (r.status === 'blocked') {
      requireThat(!r.evidence && !r.inspection);
      return [{authorizationId: g.authorizationId, status: 'blocked' as const,
        startedAt: r.startedAt, finishedAt: r.finishedAt, evidence: null}];
    }
    requireThat(r.status === 'completed' && isEvidence(r.evidence) && r.inspection && r.mission);
    const e = r.evidence, i = r.inspection;
    requireThat(e.missionId === m.missionId && e.assignmentId === 'inspect-fixture' && e.planHash === hash &&
      e.source === 'assignment' && e.action === 'diagnose' && e.status === 'done' && e.observedAt === r.finishedAt &&
      e.evidenceReference === `INSPECTION-${g.authorizationId}` && e.jobId === e.evidenceReference &&
      e.verifiedBaseSha === m.baseSha && e.verifiedBranch === m.branch && i.headSha === m.baseSha && i.branch === m.branch &&
      i.clean === true && i.trackedFiles === 1 && /^[a-f0-9]{64}$/.test(i.readmeSha256) &&
      Number.isSafeInteger(i.readmeBytes) && i.readmeBytes > 0 && planHash(r.mission) === hash &&
      r.mission.status === 'completed' && r.mission.assignments[0].status === 'completed' && Date.parse(r.finishedAt) < Date.parse(g.expiresAt));
    const revoked = history.find(e => e.kind === 'revoked' && e.authorization.authorizationId === g.authorizationId);
    requireThat(!revoked || Date.parse(revoked.recordedAt) >= Date.parse(r.finishedAt));
    return [{authorizationId: g.authorizationId, status: 'completed' as const,
      startedAt: r.startedAt, finishedAt: r.finishedAt,
      evidence: {reference: e.evidenceReference, headSha: i.headSha, branch: i.branch, readmeSha256: i.readmeSha256}}];
  });
  // A concurrent approval/revocation cannot be combined with an older snapshot.
  requireThat(before === JSON.stringify(store.history()));
  return {schemaVersion: 'sb-mission/1' as const, generatedAt: now.toISOString(), source: 'aa-isolated-inspector' as const,
    executionAuthorized: false as const, mission: {id: m.missionId, repositoryAlias: 'MISSION-TEST' as const,
      planHash: hash, baseSha: m.baseSha, branch: 'mission-test' as const, assignmentId: 'inspect-fixture' as const,
      action: 'diagnose' as const, requiredCapability: 'architecture-plan' as const,
      proposedRole: proposal.proposedRole ?? null, proposalStatus: proposal.status, permissions: proposal.permissions,
      candidates: proposal.candidates, authorizations, observations}};
}

/** Atomic replacement in an explicit, owner-controlled export directory, outside the private store. */
export function exportBoardSnapshot(store: ApprovalStore, fixtureId: string, destination: string, now = new Date()): void {
  const target = path.resolve(destination), parent = fs.realpathSync(path.dirname(target));
  const stat = fs.statSync(parent);
  requireThat(parent === path.dirname(target) && stat.uid === process.geteuid!() && (stat.mode & 0o022) === 0 &&
    parent !== store.directory && !parent.startsWith(store.directory + path.sep));
  if (fs.existsSync(target)) {
    const s = fs.lstatSync(target);
    requireThat(s.isFile() && s.nlink === 1 && s.uid === process.geteuid!() && (s.mode & 0o077) === 0);
  }
  const snapshot = boardSnapshot(store, fixtureId, now);
  const temp = path.join(parent, `.mission-${randomUUID()}.tmp`);
  try {
    const fd = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(fd, JSON.stringify(snapshot) + '\n'); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temp, target);
  } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
}
