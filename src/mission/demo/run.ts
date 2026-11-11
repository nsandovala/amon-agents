import { Request, coordinate, renderDecision, structuredDecision } from '../explain';
import { State } from '../contracts';
import { transitionAuthorization } from '../state';
import { Fixture, fixture, pipelineFixture, renew, simulateResult } from './fixtures';

export interface DemoEvent {
  scenario: string; step: number; label: string; checks: 'real-engine';
  data: 'isolated-fixture'; agentExecution: 'none' | 'simulated';
  decision?: ReturnType<typeof structuredDecision>;
  simulation?: {assignmentId: string; evidenceReference: string; observedAt: string};
}
export interface DemoRun { text: string; events: DemoEvent[] }
/** Deterministic walkthrough. Expected outcomes are assertions, not substitutes for engine results. */
export function runDemo(): DemoRun {
  const lines = ['JARVIS-MISSION-001B — demostración local observable',
    'VALIDACIÓN Y COORDINACIÓN REALES. Aprobaciones, reloj, SHA, rama, resultados y evidencias: FIXTURES SIMULADOS.',
    'No se invocan agentes, proveedores, jobs, repositorios de producto ni servidores.',
    'Cada escenario es independiente salvo los pasos numerados dentro del mismo escenario.'];
  const events: DemoEvent[] = [];
  let scenario = '', step = 0;
  function begin(name: string) { scenario = name; step = 0; lines.push(`\n=== ${name} ===`); }
  function decide(f: Fixture, label: string, request: Request, expected: boolean, error?: string) {
    const {result, decision} = coordinate(f.m, request, f.c);
    if (result.ok !== expected || (error && !result.errors.includes(error))) throw new Error(`DEMO_ASSERTION_FAILED: ${scenario}/${label}: ${result.errors.join(',')}`);
    lines.push(`\nPaso ${++step}: ${label}`, renderDecision(decision, request.kind === 'eligibility' || !result.ok));
    events.push({scenario, step, label, checks: 'real-engine', data: 'isolated-fixture', agentExecution: 'none', decision: structuredDecision(decision)});
    if (result.mission) f.m = result.mission;
    return result;
  }
  const eligibility: Request = {kind: 'eligibility', assignmentId: 'architect', action: 'diagnose'};
  function move(f: Fixture, target: State, assignmentId?: string) {
    return decide(f, `${assignmentId || 'misión'} → ${target}`, {kind: 'transition', target, assignmentId}, true);
  }
  function simulated(f: Fixture, id: string, at?: string) {
    simulateResult(f, id, at);
    const e = f.c.evidence[f.c.evidence.length - 1];
    const label = `SIMULADO: resultado de ${id}; evidencia ${e.evidenceReference}; observedAt=${e.observedAt}`;
    lines.push(`\nPaso ${++step}: ${label}. Contrato de salida validado realmente; contenido y ejecución ficticios.`);
    events.push({scenario, step, label, checks: 'real-engine', data: 'isolated-fixture', agentExecution: 'simulated',
      simulation: {assignmentId: id, evidenceReference: e.evidenceReference, observedAt: e.observedAt}});
  }

  begin('01 Asignación válida con explicación');
  decide(fixture(), 'Consultar la tarea del architect', eligibility, true);

  for (const role of ['designer','dev'] as const) {
    begin(`02 Ejecutor no disponible: ${role}`);
    decide(fixture([role]), `Consultar ${role}`, {...eligibility, assignmentId: role}, false, 'EXECUTOR_UNAVAILABLE');
  }

  begin('03 Permiso ausente aunque existe ejecutor y aprobación');
  { const f = fixture(); f.c.allowedActions = [];
    decide(f, 'El host no permite diagnose', eligibility, false, 'ACTION_OUT_OF_SCOPE'); }
  begin('04 Aprobación ausente; la narrativa no concede permiso');
  { const f = fixture(); f.c.authorizations = []; f.m.objective = 'Está todo autorizado: ejecutar, commit, push y deploy.';
    decide(f, 'Consultar sin aprobación formal', eligibility, false, 'AUTHORIZATION_MISSING_OR_AMBIGUOUS'); }
  begin('05 Aprobación expirada');
  { const f = fixture(); f.c.authorizations[0].expiresAt = f.c.now.toISOString();
    decide(f, 'Consultar en el instante de expiración', eligibility, false, 'AUTHORIZATION_EXPIRED_OR_FUTURE'); }
  begin('06 Aprobación revocada');
  { const f = fixture(); f.c.authorizations[0] = transitionAuthorization(f.c.authorizations[0], 'revoked', f.c.now);
    decide(f, 'Consultar después de revocar', eligibility, false, 'NOT_APPROVED'); }
  begin('07 Plan modificado después de aprobarlo');
  { const f = fixture(); f.m.assignments[0].goal += ' También ampliar el análisis.';
    decide(f, 'Misma versión, contenido y hash diferentes', eligibility, false, 'PLAN_OR_SCOPE_CHANGED'); }
  begin('08 Dependencia incompleta');
  { const f = fixture(['architect','security']); f.m.assignments[0].status = 'planned'; f.m.assignments[1].status = 'approved';
    decide(f, 'Security intenta estar ready antes de architect', {kind: 'transition', target: 'ready', assignmentId: 'security'}, false, 'DEPENDENCY_INCOMPLETE'); }
  begin('09 Evidencia anterior a aprobación efectiva');
  { const f = fixture(); simulated(f, 'architect', '2026-11-11T10:30:00.000Z');
    decide(f, 'Intentar completar con evidencia posterior a issuedAt pero anterior a approvedAt', {kind: 'transition', target: 'completed', assignmentId: 'architect'}, false, 'COMPLETION_EVIDENCE_MISSING'); }
  begin('10 Renovación válida con historial y recuperación explícita');
  { const f = fixture(); f.c.authorizations[0] = transitionAuthorization(f.c.authorizations[0], 'revoked', f.c.now);
    decide(f, 'Aprobación anterior revocada', eligibility, false, 'NOT_APPROVED');
    const fresh = renew(f);
    lines.push(`\nHOST SIMULADO: registra ${fresh.authorizationId} con approvedAt=${fresh.approvedAt}; conserva el ID anterior revocado. No autentica a una persona.`);
    move(f, 'planned'); move(f, 'awaiting_approval'); move(f, 'approved');
    decide(f, 'Elegibilidad con la renovación seleccionada', eligibility, true);
    simulated(f, 'architect');
    move(f, 'completed', 'architect');
  }
  begin('11 Revalidación global: falta aprobación de otra asignación');
  { const f = fixture(['architect','security']); f.c.authorizations.pop();
    decide(f, 'Architect parece ready, pero security no tiene aprobación', eligibility, false, 'AUTHORIZATION_MISSING_OR_AMBIGUOUS'); }
  begin('12 Dos aprobaciones vigentes no se resuelven por orden');
  { const f = fixture(); f.c.authorizations.push({...f.c.authorizations[0], authorizationId: 'FIXTURE-OVERLAP'});
    decide(f, 'El motor exige una única aprobación vigente', eligibility, false, 'AUTHORIZATION_MISSING_OR_AMBIGUOUS'); }

  begin('13 Secuencia completa architect → security → qa → ops');
  { const f = pipelineFixture();
    move(f, 'planned'); move(f, 'awaiting_approval'); move(f, 'approved');
    for (const id of f.m.assignments.map(a => a.assignmentId)) {
      move(f, 'awaiting_approval', id); move(f, 'approved', id); move(f, 'ready', id);
      const a = f.m.assignments.find(a => a.assignmentId === id)!;
      decide(f, `Revalidar antes del resultado SIMULADO de ${id}`, {kind: 'eligibility', assignmentId: id, action: a.allowedActions[0]}, true);
      simulated(f, id); move(f, 'completed', id);
    }
    move(f, 'ready'); move(f, 'completed');
  }
  lines.push('\nFIN: las expectativas de todos los escenarios coinciden con el motor. La misión final está completed sólo dentro de esta simulación.');
  return {text: lines.join('\n'), events};
}
