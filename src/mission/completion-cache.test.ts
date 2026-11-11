import { describe, expect, it } from 'vitest';
import { planHash } from './contracts';
import { fixture } from './demo/fixtures';
import { canPerform, Result, transition } from './state';

/** Fully evidenced Fibonacci DAG: shared paths grow exponentially, unique edges do not. */
function sharedDependencies(count: number) {
  const f = fixture();
  const template = f.m.assignments[0];
  f.m.assignments = Array.from({length: count}, (_, i) => ({
    ...structuredClone(template), assignmentId: `TASK-${i}`, status: 'completed' as const,
    dependencies: [i - 1, i - 2].filter(n => n >= 0).map(n => `TASK-${n}`),
    evidenceRefs: [`EVIDENCE-${i}`],
  })).reverse(); // Exercise recursive traversal before the outer loop reaches the ancestors.
  const hash = planHash(f.m);
  const grant = f.c.authorizations[0];
  f.c.authorizations = f.m.assignments.map(a => ({
    ...grant, authorizationId: `GRANT-${a.assignmentId}`, assignmentId: a.assignmentId, planHash: hash,
  }));
  f.c.evidence = f.m.assignments.map(a => ({
    source: 'assignment', jobId: `JOB-${a.assignmentId}`, action: 'diagnose', status: 'done',
    observedAt: f.c.now.toISOString(), verifiedBaseSha: f.m.baseSha, verifiedBranch: f.m.branch,
    evidenceReference: a.evidenceRefs[0], missionId: f.m.missionId, assignmentId: a.assignmentId, planHash: hash,
  }));
  return f;
}

function expectBoundedTrace(f: ReturnType<typeof sharedDependencies>, result: Result) {
  expect(result.ok).toBe(true);
  const validations = result.checks.filter(c => c.code === 'COMPLETION_EVIDENCE_MISSING');
  const completed = f.m.assignments.filter(a => a.status === 'completed');
  expect(validations).toHaveLength(completed.length);
  expect(new Set(validations.map(c => c.assignmentId)).size).toBe(completed.length);
  expect(validations.every(c => c.passed)).toBe(true);
  for (const a of f.m.assignments) {
    for (const dep of a.dependencies) {
      expect(result.checks.some(c => c.code === 'DEPENDENCY_INCOMPLETE' && c.passed &&
        c.assignmentId === a.assignmentId && c.facts.dependencyId === dep)).toBe(true);
    }
  }
  // A deterministic work/trace bound, not a machine-dependent wall-clock assertion.
  expect(result.checks.length).toBeLessThan(100 * f.m.assignments.length);
}

describe('decision-scoped dependency completion', () => {
  it.each([15, 100])('bounds validation work for %i assignments while retaining every dependency edge', count => {
    const f = sharedDependencies(count);
    const before = JSON.stringify(f);
    expectBoundedTrace(f, transition(f.m, 'ready', f.c));
    expect(JSON.stringify(f)).toBe(before);
  });

  it('also bounds eligibility checks at the 100-assignment contract limit', () => {
    const f = sharedDependencies(100);
    f.m.assignments[0].status = 'ready';
    expectBoundedTrace(f, canPerform(f.m, f.m.assignments[0].assignmentId, 'diagnose', f.c));
  });

  for (const api of ['transition', 'canPerform'] as const) {
    it.each([
      ['revocation', 'NOT_APPROVED'],
      ['expiry', 'AUTHORIZATION_EXPIRED_OR_FUTURE'],
      ['plan change', 'PLAN_OR_SCOPE_CHANGED'],
      ['evidence change', 'COMPLETION_EVIDENCE_MISSING'],
      ['dependency status change', 'DEPENDENCY_INCOMPLETE'],
      ['host permission change', 'ACTION_OUT_OF_SCOPE'],
    ])(`${api} revalidates %s on the next decision`, (change, error) => {
      const f = sharedDependencies(8);
      if (api === 'canPerform') f.m.assignments[0].status = 'ready';
      const decide = () => api === 'transition' ? transition(f.m, 'ready', f.c) :
        canPerform(f.m, f.m.assignments[0].assignmentId, 'diagnose', f.c);
      expect(decide().ok).toBe(true);
      const root = f.m.assignments.find(a => a.assignmentId === 'TASK-0')!;
      if (change === 'revocation') f.c.authorizations.find(g => g.assignmentId === root.assignmentId)!.decision = 'revoked';
      if (change === 'expiry') f.c.now = new Date(f.c.authorizations[0].expiresAt);
      if (change === 'plan change') f.m.objective += ' changed';
      if (change === 'evidence change') f.c.evidence.find(e => e.assignmentId === root.assignmentId)!.planHash = '0'.repeat(64);
      if (change === 'dependency status change') root.status = 'planned';
      if (change === 'host permission change') f.c.allowedActions = [];
      const result = decide();
      expect(result.ok).toBe(false);
      expect(result.errors).toContain(error);
    });
  }

  it('does not reuse partial success from a failed decision', () => {
    const f = sharedDependencies(8);
    const rootEvidence = f.c.evidence.find(e => e.assignmentId === 'TASK-0')!;
    const hash = rootEvidence.planHash;
    rootEvidence.planHash = '0'.repeat(64);
    expect(transition(f.m, 'ready', f.c).errors).toContain('COMPLETION_EVIDENCE_MISSING');
    rootEvidence.planHash = hash;
    expectBoundedTrace(f, transition(f.m, 'ready', f.c));
  });
});
