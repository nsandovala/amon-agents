/** ISOLATED SIMULATION. No product repository, filesystem observation or real approval. */
import { AgentName } from '../../core/types';
import { validateOutput } from '../../core/validate-json';
import { getFlowForTaskType } from '../../llm/router';
import { AuthorizationContract, MissionContract, planHash } from '../contracts';
import { Context, transitionAuthorization } from '../state';

export const CLOCK = '2026-11-11T12:00:00.000Z';
const descriptions: Record<AgentName, string> = {
  architect: 'Preparar el plan de revisión de un catálogo ficticio.',
  security: 'Revisar los límites y permisos del plan ficticio.',
  qa: 'Revisar la cobertura del plan ficticio; no ejecutar pruebas de producto.',
  ops: 'Evaluar la preparación del plan ficticio; no desplegar.',
  designer: 'Proponer el diseño del catálogo ficticio.',
  dev: 'Implementar el catálogo ficticio.',
};
export interface Fixture { m: MissionContract; c: Context }
export function fixture(roles: AgentName[] = ['architect']): Fixture {
  const m: MissionContract = {
    schemaVersion: '0.1', missionId: 'DEMO-001B', taskType: 'research_task',
    objective: 'SIMULACIÓN aislada de coordinación; no corresponde a un repositorio de producto.',
    repositoryAlias: 'LOCAL-FIXTURE', baseSha: '1'.repeat(40), branch: 'fixture/mission-001b',
    status: 'approved', planVersion: 1, evidenceRefs: [],
    authorizationPolicy: {mode: 'explicit', allowedActions: ['diagnose','verify'], approverIds: ['fixture-host']},
    assignments: roles.map((role, i) => ({
      assignmentId: role, missionId: 'DEMO-001B', role, goal: descriptions[role], scope: 'fixture-catalog',
      dependencies: i ? [roles[i - 1]] : [],
      expectedOutputs: {goal: descriptions[role], scope: 'fixture-catalog', files_to_touch: [],
        plan: ['SIMULADO: emitir revisión en memoria'], risks: ['No acredita ejecución real'],
        validations: ['Validar contratos y metadatos con el motor real'], done_when: ['Evidencia simulada aceptada por las reglas reales']},
      allowedActions: role === 'qa' ? ['verify'] : ['diagnose'], status: i ? 'planned' : 'ready', evidenceRefs: [],
    })),
  };
  const c: Context = {now: new Date(CLOCK), repositoryAliases: ['LOCAL-FIXTURE'], approverIds: ['fixture-host'],
    allowedActions: ['diagnose','verify'], evidence: [], authorizations: []};
  c.authorizations = m.assignments.map(a => ({
    authorizationId: `FIXTURE-GRANT-${a.assignmentId}`, missionId: m.missionId, assignmentId: a.assignmentId,
    action: a.allowedActions[0], approvedBy: 'fixture-host', planVersion: m.planVersion, planHash: planHash(m), scope: a.scope,
    issuedAt: '2026-11-11T10:00:00.000Z', approvedAt: '2026-11-11T11:00:00.000Z',
    expiresAt: '2026-11-11T14:00:00.000Z', decision: 'approved',
  }));
  return {m, c};
}
export function pipelineFixture(): Fixture {
  const f = fixture(getFlowForTaskType('research_task'));
  f.m.status = 'draft';
  f.m.assignments.forEach(a => { a.status = 'planned'; });
  return f;
}
/** Only the explicit demo runner calls this. The core coordinator cannot manufacture evidence. */
export function simulateResult(f: Fixture, id: string, observedAt = CLOCK): void {
  const a = f.m.assignments.find(a => a.assignmentId === id)!;
  const output = {...a.expectedOutputs, goal: 'SIMULADO: ' + a.goal};
  if (!validateOutput(output).valid) throw new Error('INVALID_SIMULATED_OUTPUT');
  const ref = `SIMULATED-EVIDENCE-${id}-${f.c.evidence.length + 1}`;
  f.c.evidence.push({source: 'assignment', jobId: `SIMULATED-JOB-${id}-${f.c.evidence.length + 1}`,
    action: a.allowedActions[0], status: 'done', observedAt, verifiedBaseSha: f.m.baseSha,
    verifiedBranch: f.m.branch, evidenceReference: ref, missionId: f.m.missionId,
    assignmentId: id, planHash: planHash(f.m)});
  a.evidenceRefs.push(ref);
}
export function renew(f: Fixture): AuthorizationContract {
  const old = f.c.authorizations[0];
  if (old.decision === 'approved') f.c.authorizations[0] = transitionAuthorization(old, 'revoked', f.c.now);
  const pending: AuthorizationContract = {...old, authorizationId: old.authorizationId + '-RENEWED',
    issuedAt: f.c.now.toISOString(), approvedAt: null, decision: 'pending', planHash: planHash(f.m)};
  const fresh = transitionAuthorization(pending, 'approved', f.c.now);
  f.c.authorizations.push(fresh);
  return fresh;
}
