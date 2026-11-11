import { describe, it, expect } from 'vitest';
import { isAuthorization, isEvidence, parseMission, planHash, State, states } from './contracts';
import { Context, canPerform, transition, transitions, authorizationStatus, transitionAuthorization } from './state';
import { PILOT, pilotMission, reconstructPilot } from './pilot';

const now = new Date('2026-11-06T12:00:00.000Z');
function fixture() {
  const m = pilotMission();
  m.assignments = [m.assignments[0]];
  m.status = 'approved'; m.assignments[0].status = 'ready';
  m.assignments[0].allowedActions = ['diagnose']; m.authorizationPolicy.allowedActions = ['diagnose'];
  const a = m.assignments[0];
  const c: Context = {now, repositoryAliases: ['BracketFlow'], approverIds: ['nelson-sandoval'], allowedActions: ['diagnose'], evidence: [], authorizations: [{authorizationId: 'AUTH-001', missionId: m.missionId, assignmentId: a.assignmentId, action: 'diagnose', approvedBy: 'nelson-sandoval', planVersion: 1, planHash: planHash(m), scope: a.scope, issuedAt: '2026-11-06T11:00:00.000Z', expiresAt: '2026-11-06T13:00:00.000Z', approvedAt: '2026-11-06T11:00:00.000Z', decision: 'approved'}]};
  const perform = () => canPerform(m, a.assignmentId, 'diagnose', c);
  return {m, a, c, perform};
}
function evidence(f: ReturnType<typeof fixture>) {
  f.a.evidenceRefs = ['EV-001'];
  f.c.evidence = [{source: 'assignment', jobId: 'RESULT-001', action: 'diagnose', status: 'done', observedAt: '2026-11-06T11:30:00.000Z', verifiedBaseSha: f.m.baseSha, verifiedBranch: f.m.branch, evidenceReference: 'EV-001', missionId: f.m.missionId, assignmentId: f.a.assignmentId, planHash: planHash(f.m)}];
}
function job() {
  return {jobId: PILOT.jobId, action: 'prepare_worktree', repo: PILOT.sourceRepo, branch: PILOT.branch, status: 'done', exitCode: 0, queuedAt: '2026-11-06T02:35:01.951Z', startedAt: '2026-11-06T02:35:01.959Z', finishedAt: '2026-11-06T02:35:03.527Z', transitions: [{status:'queued',at:'2026-11-06T02:35:01.951Z'},{status:'running',at:'2026-11-06T02:35:01.959Z'},{status:'done',at:'2026-11-06T02:35:03.527Z'}], evidence: {repoPath:PILOT.sourceRepo,worktreePath:String(PILOT.worktree),sourceHeadSha:PILOT.baseSha,worktreeHeadSha:String(PILOT.baseSha),worktreeBranch:PILOT.branch,worktreeStatusShort:'',created:true}};
}
const observation = {headSha:PILOT.baseSha,branch:PILOT.branch,statusShort:'',observedAt:now.toISOString()};

describe('approval audit regressions', () => {
  it('records the effective approval time without changing issuance or the pending input', () => {
    const f = fixture();
    const pending = {...f.c.authorizations[0], decision: 'pending' as const, approvedAt: null};
    const approved = transitionAuthorization(pending, 'approved', now);
    expect(approved.issuedAt).toBe(pending.issuedAt);
    expect(approved.approvedAt).toBe(now.toISOString());
    expect(pending.decision).toBe('pending');
    expect(pending.approvedAt).toBeNull();
    const revoked = transitionAuthorization(approved, 'revoked', now);
    expect(revoked.approvedAt).toBe(approved.approvedAt);
    expect(() => transitionAuthorization(revoked, 'approved', now)).toThrow();
  });

  it.each([
    ['2026-11-06T11:30:00.000Z', false],
    ['2026-11-06T11:59:59.999Z', false],
    ['2026-11-06T12:00:00.000Z', true],
    ['2026-11-06T12:00:00.001Z', true],
  ])('checks evidence %s against approval at 12:00', (observedAt, accepted) => {
    const f = fixture();
    evidence(f);
    const pending = {...f.c.authorizations[0], decision: 'pending' as const, approvedAt: null};
    f.c.authorizations = [transitionAuthorization(pending, 'approved', now)];
    f.c.now = new Date('2026-11-06T12:01:00.000Z');
    f.c.evidence[0].observedAt = observedAt as string;
    const result = transition(f.m, 'completed', f.c, f.a.assignmentId);
    expect(result.ok).toBe(accepted);
    if (!accepted) expect(result.errors).toContain('COMPLETION_EVIDENCE_MISSING');
    expect(f.a.status).toBe('ready');
  });

  it.each([null, undefined, 'yesterday', '2026-11-06T10:59:59.999Z', '2026-11-06T13:00:00.000Z'])('rejects invalid approval timestamp %s', approvedAt => {
    const f = fixture();
    (f.c.authorizations[0] as any).approvedAt = approvedAt;
    expect(isAuthorization(f.c.authorizations[0])).toBe(false);
    expect(f.perform().ok).toBe(false);
  });

  it('rejects legacy grants without approvedAt and approval claims in the future', () => {
    const f = fixture();
    const legacy: any = {...f.c.authorizations[0]};
    delete legacy.approvedAt;
    expect(isAuthorization(legacy)).toBe(false);
    f.c.authorizations[0].approvedAt = '2026-11-06T12:01:00.000Z';
    expect(isAuthorization(f.c.authorizations[0])).toBe(true);
    expect(authorizationStatus(f.c.authorizations[0], now)).toBe('invalid');
    expect(f.perform().ok).toBe(false);
  });

  it.each(['pending', 'denied'] as const)('requires null approvedAt for %s records', decision => {
    const grant = {...fixture().c.authorizations[0], decision};
    expect(isAuthorization(grant)).toBe(false);
    expect(isAuthorization({...grant, approvedAt: null})).toBe(true);
  });

  it('does not approve at the expiry boundary or before issuance', () => {
    const pending = {...fixture().c.authorizations[0], decision: 'pending' as const, approvedAt: null};
    expect(() => transitionAuthorization(pending, 'approved', new Date(pending.expiresAt))).toThrow();
    expect(() => transitionAuthorization(pending, 'approved', new Date('2026-11-06T10:59:59.999Z'))).toThrow();
  });

  it.each(['approved', 'ready'] as const)('rejects a serialized %s mission that cannot obtain global approval', status => {
    const f = fixture();
    f.m.assignments.push(...pilotMission().assignments.slice(1));
    f.c.authorizations[0].planHash = planHash(f.m);
    expect(transition({...f.m, status: 'awaiting_approval'}, 'approved', f.c).ok).toBe(false);
    f.m.status = status;
    const snapshot = JSON.parse(JSON.stringify(f.m));
    const before = JSON.stringify(snapshot);
    expect(canPerform(snapshot, f.a.assignmentId, 'diagnose', f.c).ok).toBe(false);
    evidence(f);
    expect(transition(f.m, 'completed', f.c, f.a.assignmentId).ok).toBe(false);
    expect(JSON.stringify(snapshot)).toBe(before);
  });

  it.each(['missing', 'revoked', 'expired', 'wrong-plan', 'wrong-scope', 'unavailable'] as const)('rechecks another assignment with %s approval/executor', fault => {
    const f = fixture();
    const other = {...structuredClone(f.a), assignmentId: 'OTHER', role: 'qa' as const, status: 'planned' as const};
    f.m.assignments.push(other);
    if (fault === 'unavailable') f.m.assignments[1].role = 'dev';
    f.c.authorizations[0].planHash = planHash(f.m);
    const grant = {...f.c.authorizations[0], authorizationId: 'AUTH-OTHER', assignmentId: other.assignmentId};
    if (fault === 'revoked') grant.decision = 'revoked';
    if (fault === 'expired') grant.expiresAt = now.toISOString();
    if (fault === 'wrong-plan') grant.planHash = 'a'.repeat(64);
    if (fault === 'wrong-scope') grant.scope = 'OTHER';
    if (fault !== 'missing') f.c.authorizations.push(grant);
    expect(f.perform().ok).toBe(false);
    evidence(f);
    expect(transition(f.m, 'completed', f.c, f.a.assignmentId).ok).toBe(false);
  });

  it.each(['pending', 'denied', 'revoked', 'expired', 'future'] as const)('retains %s history without hiding the current authorization', state => {
    const f = fixture();
    const history = {...f.c.authorizations[0], authorizationId: 'AUTH-HISTORY'};
    if (state === 'expired') history.expiresAt = now.toISOString();
    else if (state === 'future') history.approvedAt = '2026-11-06T12:01:00.000Z';
    else {
      history.decision = state;
      if (state !== 'revoked') history.approvedAt = null;
    }
    f.c.authorizations.unshift(history);
    const before = JSON.stringify(f.c.authorizations);
    expect(f.perform().ok).toBe(true);
    evidence(f);
    expect(transition(f.m, 'completed', f.c, f.a.assignmentId).ok).toBe(true);
    expect(JSON.stringify(f.c.authorizations)).toBe(before);
    f.c.authorizations.reverse();
    expect(f.perform().ok).toBe(true);
    expect(transition(f.m, 'completed', f.c, f.a.assignmentId).ok).toBe(true);
  });

  it('uses the selected renewed approval timestamp for completion regardless of history order', () => {
    const f = fixture();
    const old = {...f.c.authorizations[0], authorizationId: 'AUTH-OLD', decision: 'revoked' as const};
    f.c.authorizations[0].approvedAt = now.toISOString();
    f.c.authorizations.unshift(old);
    evidence(f); // 11:30 evidence predates the renewed approval at 12:00.
    expect(f.perform().ok).toBe(true);
    expect(transition(f.m, 'completed', f.c, f.a.assignmentId).ok).toBe(false);
    f.c.authorizations.reverse();
    expect(transition(f.m, 'completed', f.c, f.a.assignmentId).ok).toBe(false);
    f.c.evidence[0].observedAt = now.toISOString();
    expect(transition(f.m, 'completed', f.c, f.a.assignmentId).ok).toBe(true);
  });

  it('blocks overlapping active grants instead of selecting by order or latest timestamp', () => {
    const f = fixture();
    f.c.authorizations.push({...f.c.authorizations[0], authorizationId: 'AUTH-NEW', approvedAt: now.toISOString()});
    expect(f.perform().errors).toContain('AUTHORIZATION_MISSING_OR_AMBIGUOUS');
    f.c.authorizations.reverse();
    expect(f.perform().errors).toContain('AUTHORIZATION_MISSING_OR_AMBIGUOUS');
    f.c.authorizations[1].decision = 'revoked';
    expect(f.perform().ok).toBe(true);
    f.c.authorizations[0].decision = 'revoked';
    expect(f.perform().ok).toBe(false);
  });

  it('does not use historical records to excuse a malformed or plan-mismatched current grant', () => {
    const f = fixture();
    f.c.authorizations.push({...f.c.authorizations[0], authorizationId: 'AUTH-OLD', decision: 'revoked'});
    f.c.authorizations[0].planHash = 'a'.repeat(64);
    expect(f.perform().errors).toContain('PLAN_OR_SCOPE_CHANGED');
    f.c.authorizations[0].planHash = planHash(f.m);
    (f.c.authorizations[1] as any).approvedAt = 'invalid';
    expect(f.perform().errors).toContain('INVALID_CONTEXT');
  });

  it('allows sequential architect/security/qa/ops progression only with all grants and dependency evidence', () => {
    const f = fixture();
    const roles = ['architect', 'security', 'qa', 'ops'] as const;
    f.m.assignments = roles.map((role, i) => ({...structuredClone(f.a), assignmentId: role, role, status: 'planned', dependencies: i ? [roles[i - 1]] : []}));
    f.m.status = 'awaiting_approval';
    f.c.authorizations = roles.map(role => ({...f.c.authorizations[0], authorizationId: `AUTH-${role}`, assignmentId: role, planHash: planHash(f.m)}));
    const approve = transition(f.m, 'approved', f.c);
    expect(approve.ok).toBe(true);
    f.m = approve.mission!;
    // An incomplete downstream assignment does not prevent the first approved assignment progressing.
    for (const role of roles) {
      for (const target of ['awaiting_approval', 'approved', 'ready'] as const) {
        const step = transition(f.m, target, f.c, role);
        expect(step.ok, `${role}: ${target} ${step.errors}`).toBe(true);
        f.m = step.mission!;
      }
      expect(canPerform(f.m, role, 'diagnose', f.c).ok).toBe(true);
      const a = f.m.assignments.find(a => a.assignmentId === role)!;
      a.evidenceRefs.push(`EV-${role}`);
      f.c.evidence.push({source: 'assignment', jobId: `RESULT-${role}`, action: 'diagnose', status: 'done', observedAt: '2026-11-06T11:30:00.000Z', verifiedBaseSha: f.m.baseSha, verifiedBranch: f.m.branch, evidenceReference: `EV-${role}`, missionId: f.m.missionId, assignmentId: role, planHash: planHash(f.m)});
      const done = transition(f.m, 'completed', f.c, role);
      expect(done.ok, done.errors.join(',')).toBe(true);
      f.m = done.mission!;
    }
    const ready = transition(f.m, 'ready', f.c);
    expect(ready.ok).toBe(true);
    expect(transition(ready.mission, 'completed', f.c).ok).toBe(true);
  });
});

describe('mission contracts and safety boundaries', () => {
  it('accepts a valid mission and does not invoke an executor', () => {const f=fixture(); expect(parseMission(f.m)).toEqual(f.m); expect(f.perform().ok).toBe(true);});
  it.each([null, {}, [], {schemaVersion:'9'}])('rejects malformed mission %j', v => expect(transition(v,'ready',fixture().c).status).toBe('blocked'));
  it('rejects unknown fields and path identifiers', () => {const f=fixture(); expect(()=>parseMission({...f.m,token:'secret'})).toThrow(); f.m.repositoryAlias='../repo'; expect(f.perform().ok).toBe(false);});
  it('rejects an unknown role', () => {const f=fixture(); (f.a as any).role='root'; expect(f.perform().ok).toBe(false);});
  it.each(['designer','dev'] as const)('does not activate unavailable %s', role => {const f=fixture(); f.a.role=role; f.c.authorizations[0].planHash=planHash(f.m); expect(f.perform().errors).toContain('EXECUTOR_UNAVAILABLE');});
  it('rejects circular dependencies', () => {const f=fixture(); f.a.dependencies=[f.a.assignmentId]; expect(()=>parseMission(f.m)).toThrow('CYCLIC');});
  it('rejects missing dependency IDs', () => {const f=fixture(); f.a.dependencies=['MISSING']; expect(()=>parseMission(f.m)).toThrow('INVALID_DEPENDENCY');});
  it('rejects incomplete dependencies even with current grants', () => {const f=fixture(); f.m.assignments.push({...structuredClone(f.a), assignmentId:'DEP',status:'planned'}); f.a.dependencies=['DEP']; f.c.authorizations[0].planHash=planHash(f.m); expect(f.perform().errors).toContain('DEPENDENCY_INCOMPLETE');});
  it('rejects unauthorised assignments', () => {const f=fixture(); f.c.authorizations=[]; expect(f.perform().ok).toBe(false);});
  it('rejects expired approvals at the expiry boundary', () => {const f=fixture(); f.c.authorizations[0].expiresAt=now.toISOString(); expect(f.perform().errors).toContain('AUTHORIZATION_EXPIRED_OR_FUTURE');});
  it('rejects approval for another mission', () => {const f=fixture(); f.c.authorizations[0].missionId='OTHER'; expect(f.perform().ok).toBe(false);});
  it.each(['objective','baseSha','branch','repositoryAlias'] as const)('invalidates changed %s without a version bump', key => {const f=fixture(); f.m[key]=key==='baseSha'?'a'.repeat(40):'changed'; expect(f.perform().ok).toBe(false);});
  it('invalidates changed nested plan content', () => {const f=fixture(); f.a.expectedOutputs.plan.push('extra'); expect(f.perform().errors).toContain('PLAN_OR_SCOPE_CHANGED');});
  it('invalidates a changed plan version', () => {const f=fixture(); f.m.planVersion++; expect(f.perform().ok).toBe(false);});
  it('does not count preparation as assignment completion', () => {const f=fixture(); f.c.evidence=reconstructPilot(job(),observation,now).evidence; f.a.evidenceRefs=[PILOT.jobId]; expect(transition(f.m,'completed',f.c,f.a.assignmentId).ok).toBe(false);});
  it('blocks completion without evidence', () => {const f=fixture(); expect(transition(f.m,'completed',f.c,f.a.assignmentId).errors).toContain('COMPLETION_EVIDENCE_MISSING');});
  it('blocks wrong evidence SHA', () => {const f=fixture(); evidence(f); f.c.evidence[0].verifiedBaseSha='a'.repeat(40); expect(transition(f.m,'completed',f.c,f.a.assignmentId).ok).toBe(false);});
  it('completes assignment then mission with bound evidence', () => {const f=fixture(); evidence(f); const r=transition(f.m,'completed',f.c,f.a.assignmentId); expect(r.ok).toBe(true); const ready=transition(r.mission,'ready',f.c); expect(ready.ok).toBe(true); expect(transition(ready.mission,'completed',f.c).ok).toBe(true); expect(f.a.status).toBe('ready');});
  it.each(['push','commit','merge','deploy','implement'] as const)('rejects out-of-scope %s', action => {const f=fixture(); expect(canPerform(f.m,f.a.assignmentId,action,f.c).errors).toContain('ACTION_OUT_OF_SCOPE');});
  it('keeps insufficient information blocked across retries and serialization', () => {const f=fixture(); f.c.authorizations=[]; const r=transition(f.m,'completed',f.c,f.a.assignmentId); const next=transition(JSON.parse(JSON.stringify(r.mission)),'ready',f.c); expect(next.status).toBe('blocked'); expect(next.mission?.status).toBe('blocked');});
  it('rejects duplicate assignment, authorization and evidence IDs', () => {const f=fixture(); f.m.assignments.push(structuredClone(f.a)); expect(()=>parseMission(f.m)).toThrow('DUPLICATE'); f.m.assignments.pop(); f.c.authorizations.push(structuredClone(f.c.authorizations[0])); expect(f.perform().errors).toContain('DUPLICATE_AUTHORIZATION'); f.c.authorizations.pop(); evidence(f); f.c.evidence.push(structuredClone(f.c.evidence[0])); expect(f.perform().errors).toContain('DUPLICATE_EVIDENCE');});
  it('rejects duplicate job with different reference', () => {const f=fixture(); evidence(f); f.c.evidence.push({...f.c.evidence[0],evidenceReference:'EV-002'}); expect(f.perform().ok).toBe(false);});
  it('does not trust an approver declared only by the mission', () => {const f=fixture(); f.c.approverIds=[]; expect(f.perform().ok).toBe(false);});
  it.each(['pending','denied','revoked'] as const)('rejects %s decisions', decision => {const f=fixture(); f.c.authorizations[0].decision=decision; if(decision !== 'revoked') f.c.authorizations[0].approvedAt=null; expect(f.perform().ok).toBe(false);});
  it('rejects malformed authorizations and evidence at runtime', () => {expect(isAuthorization({})).toBe(false); expect(isEvidence({})).toBe(false); const f=fixture(); (f.c.authorizations[0] as any).expiresAt='yesterday'; expect(f.perform().ok).toBe(false);});
  it('enforces authorization decision transitions and expiry', () => {const g=fixture().c.authorizations[0]; expect(authorizationStatus(g,now)).toBe('approved'); expect(transitionAuthorization(g,'revoked',now).decision).toBe('revoked'); expect(()=>transitionAuthorization(g,'pending',now)).toThrow(); expect(authorizationStatus(g,new Date(g.expiresAt))).toBe('expired');});
  it('rejects invalid state jumps for every pair outside the matrix', () => {for(const from of states) for(const to of states) if(!transitions[from].includes(to)){const f=fixture(); f.m.status=from; expect(transition(f.m,to,f.c).ok,`${from}->${to}`).toBe(false);}});
  it('validates explicit planning transitions', () => {const f=fixture(); f.m.status='draft'; f.a.status='draft'; for(const target of ['planned','awaiting_approval','approved','ready'] as State[]){const r=transition(f.m,target,f.c); expect(r.ok).toBe(true); f.m=r.mission!;}});
});

describe('BF-HOME-001 reconstruction (no jobs)', () => {
  it('reuses the existing job deterministically without duplicate execution', () => {const first=reconstructPilot(job(),observation,now); const second=reconstructPilot(job(),observation,now); expect(first).toEqual(second); expect(first.evidence).toHaveLength(1); expect(first.existingJobReused).toBe(true);});
  it('reconstructs pending approval, proposed Architect and blocked Designer/Dev/QA', () => {const r=reconstructPilot(job(),observation,now); expect(r.environmentVerified).toBe(true); expect(r.redesignExecuted).toBe(false); expect(r.mission.status).toBe('awaiting_approval'); expect(r.mission.assignments.map(a=>a.status)).toEqual(['planned','blocked','blocked','blocked']); expect(r.mission.assignments.every(a=>a.allowedActions.length===0)).toBe(true); expect(parseMission(JSON.parse(JSON.stringify(r.mission)))).toEqual(r.mission);});
  it('blocks absent evidence and absent live observation', () => {expect(reconstructPilot(undefined,observation,now).mission.status).toBe('blocked'); expect(reconstructPilot(job(),undefined,now).mission.status).toBe('blocked');});
  it('blocks incorrect historical SHA', () => {const j=job(); j.evidence.worktreeHeadSha='a'.repeat(40); expect(reconstructPilot(j,observation,now).mission.status).toBe('blocked');});
  it.each([{...observation,headSha:'a'.repeat(40)},{...observation,branch:'main'},{...observation,statusShort:'?? surprise'},{...observation,observedAt:'2026-11-05T12:00:00.000Z'}])('blocks drift or stale observation %j', o => expect(reconstructPilot(job(),o,now).mission.status).toBe('blocked'));
  it('rejects inconsistent job history and arbitrary paths', () => {const j=job(); j.transitions[2].status='running'; expect(reconstructPilot(j,observation,now).environmentVerified).toBe(false); const p=job(); p.evidence.worktreePath='/tmp/user-controlled'; expect(reconstructPilot(p,observation,now).environmentVerified).toBe(false);});
});
