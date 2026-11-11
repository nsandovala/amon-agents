import { AGENT_REGISTRY } from '../agents/registry';
import { AgentName } from '../core/types';
import { Action, MissionContract, State, parseMission, planHash } from './contracts';
import { Check, Context, Result, canPerform, transition } from './state';

export type Request = {kind: 'eligibility'; assignmentId: string; action: Action}
  | {kind: 'transition'; target: State; assignmentId?: string};

/** Interpretations of engine codes, never an independent authorization decision. */
const meanings: Record<string, [string, string]> = {
  INVALID_MISSION: ['El contrato de misión debe ser válido.', 'Corregir el contrato antes de solicitar decisiones.'],
  DUPLICATE_ASSIGNMENT: ['Cada asignación debe tener una identidad única.', 'Eliminar la duplicación de identidades.'],
  CYCLIC_DEPENDENCY: ['Las dependencias deben formar un grafo sin ciclos.', 'Replantear las dependencias y volver a aprobar el plan.'],
  INVALID_DEPENDENCY_OR_MISSION: ['Las dependencias deben existir en esta misión.', 'Corregir las referencias del plan y volver a aprobarlo.'],
  INVALID_CLOCK: ['El reloj del host debe ser válido.', 'Restablecer el reloj confiable.'],
  UNKNOWN_REPOSITORY: ['El alias debe estar registrado por el host.', 'Usar un alias confiable; el texto del plan no registra repositorios.'],
  INVALID_CONTEXT: ['Aprobaciones y evidencias deben cumplir sus contratos.', 'Aportar registros explícitos válidos desde el host.'],
  DUPLICATE_AUTHORIZATION: ['Debe existir un solo snapshot por ID de autorización.', 'Conservar IDs distintos para renovaciones y reemplazar el snapshot al revocar.'],
  DUPLICATE_EVIDENCE: ['Las identidades de evidencia y job deben ser únicas.', 'Resolver duplicados en el host sin reutilizar ejecuciones.'],
  INVALID_EVIDENCE_REFERENCE: ['La evidencia referenciada debe corresponder a la misión, base, rama y reloj.', 'Obtener evidencia de la base y rama correctas, observada antes del reloj actual.'],
  UNKNOWN_ASSIGNMENT: ['La asignación debe existir.', 'Seleccionar una asignación del plan validado.'],
  EXECUTOR_UNAVAILABLE: ['El rol necesita una función ejecutora registrada.', 'Implementar y verificar el ejecutor en un trabajo separado; no sustituirlo por otro rol.'],
  ACTION_OUT_OF_SCOPE: ['La acción debe estar permitida por host, misión y asignación.', 'Solicitar al responsable una política explícita; cambiarla requiere revisar y aprobar el plan.'],
  AUTHORIZATION_MISSING_OR_AMBIGUOUS: ['Debe haber exactamente una aprobación efectiva vigente para esta tarea y acción.', 'Emitir una aprobación explícita si falta; revocar las superpuestas antes de renovar.'],
  NOT_APPROVED: ['Debe existir una aprobación de un aprobador reconocido por host y misión.', 'Solicitar una nueva aprobación válida; un registro revocado o texto narrativo no concede permiso.'],
  AUTHORIZATION_EXPIRED_OR_FUTURE: ['La aprobación debe estar dentro de su ventana temporal efectiva.', 'Renovar con otro ID y fecha efectiva real; no retrotraer la aprobación.'],
  PLAN_OR_SCOPE_CHANGED: ['Versión, hash y alcance deben coincidir con la aprobación.', 'Revisar y aprobar el plan actual, revocando la aprobación anterior si aún está activa.'],
  AUTHORIZATION_SELECTED: ['El motor seleccionó una aprobación vigente ligada al plan.', 'No requiere corrección.'],
  NO_ACTIONS: ['La asignación debe declarar al menos una acción.', 'Definir acciones explícitas y obtener aprobación; el objetivo narrativo no las concede.'],
  COMPLETION_EVIDENCE_MISSING: ['Debe haber evidencia done por acción, ligada al plan, tarea, base y rama, desde approvedAt hasta ahora.', 'Obtener nueva evidencia tras la aprobación efectiva. La evidencia antigua no se vuelve válida al renovar.'],
  DEPENDENCY_INCOMPLETE: ['El estado declarado de la dependencia debe ser completed; su evidencia se comprueba por separado.', 'Completar primero esa tarea con aprobación vigente y evidencia válida.'],
  ASSIGNMENT_INCOMPLETE: ['Todas las asignaciones deben estar completadas.', 'Completar las tareas pendientes antes de cerrar la misión.'],
  INVALID_TRANSITION: ['El cambio debe respetar la tabla de estados.', 'Seguir las transiciones válidas; para recuperar blocked, replantear mediante planned.'],
  MISSION_NOT_APPROVED: ['La misión debe estar approved o ready.', 'Obtener aprobación global mediante la transición correspondiente.'],
  ASSIGNMENT_NOT_READY: ['La asignación debe estar ready para consultar ejecución.', 'Pasar por aprobación y verificar sus dependencias antes de habilitarla.'],
};

export interface AssignmentExplanation {
  assignmentId: string; role: AgentName; task: string;
  requiredCapability: string; executorAvailable: boolean;
  alternatives: {role: AgentName; executorAvailable: boolean; reason: string}[];
  permissions: {action: Action; host: boolean; mission: boolean; assignment: boolean;
    selectedApprovals: string[]; authorizationChecked: boolean}[];
  dependencies: {assignmentId: string; declaredStatus: State; checked: boolean}[];
  evidenceChecks: Check[];
}
export interface Decision {
  schemaVersion: 'jarvis-explanation/1'; request: Request; ok: boolean; status: State;
  planHash?: string; checks: Check[]; errors: string[];
  assignments: AssignmentExplanation[];
}
export interface Coordination { result: Result; decision: Decision }

/** Pure coordination: every decision is made by the 001A engine, including global revalidation.
 * No scheduling, executor invocation, network, repository access, or narrative-derived permissions.
 * Host must supply non-sensitive metadata; arbitrary prose is excluded from structured traces.
 */
export function coordinate(input: unknown, request: Request, context: Context): Coordination {
  const result = request.kind === 'eligibility'
    ? canPerform(input, request.assignmentId, request.action, context)
    : transition(input, request.target, context, request.assignmentId);
  let mission: MissionContract | undefined;
  try { mission = parseMission(input); } catch { /* The engine already rejected the contract. */ }
  const checks = result.checks;
  const assignments = mission?.assignments.map(a => {
    const local = checks.filter(c => c.assignmentId === a.assignmentId);
    const required = [...new Set([...a.allowedActions,
      ...(request.kind === 'eligibility' && request.assignmentId === a.assignmentId ? [request.action] : [])])];
    return {
      assignmentId: a.assignmentId, role: a.role, task: a.goal,
      requiredCapability: `executor:${a.role}`, executorAvailable: typeof AGENT_REGISTRY[a.role] === 'function',
      alternatives: (Object.keys(AGENT_REGISTRY) as AgentName[]).filter(role => role !== a.role).map(role => ({
        role, executorAvailable: typeof AGENT_REGISTRY[role] === 'function',
        reason: typeof AGENT_REGISTRY[role] !== 'function'
          ? 'Sin ejecutor registrado y rol distinto del requerido por el plan.'
          : 'Su rol no coincide con el exigido por esta asignación del plan.',
      })),
      permissions: required.map(action => ({
        action, host: Array.isArray(context.allowedActions) && context.allowedActions.includes(action), mission: mission!.authorizationPolicy.allowedActions.includes(action),
        assignment: a.allowedActions.includes(action),
        selectedApprovals: [...new Set(local.filter(c => c.action === action && c.code === 'AUTHORIZATION_SELECTED')
          .map(c => String(c.facts.authorizationId)))],
        authorizationChecked: local.some(c => c.action === action && c.code === 'AUTHORIZATION_MISSING_OR_AMBIGUOUS'),
      })),
      dependencies: a.dependencies.map(id => ({assignmentId: id,
        declaredStatus: mission!.assignments.find(dep => dep.assignmentId === id)!.status,
        checked: local.some(c => c.code === 'DEPENDENCY_INCOMPLETE' && c.facts.dependencyId === id),
      })),
      evidenceChecks: local.filter(c => c.code === 'COMPLETION_EVIDENCE_MISSING'),
    };
  }) ?? [];
  return {result, decision: {
    schemaVersion: 'jarvis-explanation/1', request, ok: result.ok, status: result.status,
    planHash: mission ? planHash(mission) : undefined, checks, errors: result.errors.map(e => meanings[e] ? e : 'VALIDATION_FAILED'), assignments,
  }};
}

const yes = (v: boolean) => v ? 'sí' : 'NO';
export function renderDecision(d: Decision, details = true): string {
  const lines = [`${d.ok ? 'PERMITIDO' : 'BLOQUEADO'} — ${d.request.kind === 'eligibility' ? 'consultar elegibilidad (no ejecuta)' : `transición a ${d.request.target}`} → ${d.status}`];
  const edge = d.checks.find(c => c.code === 'INVALID_TRANSITION');
  if (edge) lines.push(`  Tabla de estados: ${edge.facts.from} → ${edge.facts.target} ${edge.passed ? 'es una transición válida' : 'no está permitido'}. Los demás requisitos se verifican después.`);
  if (!details) {
    const grants = [...new Set(d.checks.filter(c => c.code === 'AUTHORIZATION_SELECTED').map(c => String(c.facts.authorizationId)))];
    lines.push(`  Aprobaciones validadas contra el plan: ${grants.join(', ') || 'no evaluadas en este paso'}.`);
  }
  const selected = d.request.assignmentId ? d.assignments.filter(a => a.assignmentId === d.request.assignmentId) : d.assignments;
  for (const a of details ? selected : []) {
    lines.push(`Tarea ${a.assignmentId}: ${a.task}`,
      `  Propone ${a.role}: es el rol exigido por esta asignación del plan; no se infiere de su narrativa.`,
      `  Capacidad requerida ${a.requiredCapability}: ${a.executorAvailable ? 'disponible' : 'NO disponible'} (typeof AGENT_REGISTRY[rol] === function).`,
      `  Descarta: ${a.alternatives.map(other => `${other.role}: ${other.reason}`).join(' ')}`);
    for (const p of a.permissions) lines.push(`  Permiso ${p.action}: host=${yes(p.host)}, misión=${yes(p.mission)}, asignación=${yes(p.assignment)}. Aprobación seleccionada=${p.selectedApprovals.join(', ') || (p.authorizationChecked ? 'ninguna validada' : 'no evaluada aún')}.`);
    if (!a.permissions.length) lines.push('  Permisos: ninguna acción declarada; la narrativa no autoriza acciones.');
    lines.push(`  Dependencias: ${a.dependencies.map(dep => `${dep.assignmentId} (${dep.declaredStatus}; ${dep.checked ? 'estado comprobado por motor; evidencia en traza' : 'no comprobada en esta decisión'})`).join(', ') || 'ninguna'}.`,
      '  Para completar: evidencia done de cada acción, ligada a misión/asignación/hash/base/rama; observada desde la aprobación efectiva hasta el reloj actual.',
      `  Evidencia de finalización: ${a.evidenceChecks.length ? 'evaluada; detalle abajo' : 'no evaluada en esta decisión; no se afirma trabajo realizado'}.`);
  }
  // Collapse identical repeated checks for readability only; structured trace keeps every check in order.
  const checkedRoles = [...new Set(d.checks.filter(c => c.assignmentId).map(c => c.assignmentId))];
  lines.push(`  Motor: ${d.checks.length} comprobaciones; asignaciones comprobadas=${checkedRoles.join(', ') || 'ninguna todavía'}. Traza JSONL conserva cada comprobación.`);
  const dependencyIds = selected.flatMap(a => a.dependencies.map(dep => dep.assignmentId));
  const failedIds = d.checks.filter(c => !c.passed).map(c => c.assignmentId);
  const seen = new Set<string>();
  for (const c of d.checks) {
    if (!['EXECUTOR_UNAVAILABLE','ACTION_OUT_OF_SCOPE','AUTHORIZATION_MISSING_OR_AMBIGUOUS','AUTHORIZATION_SELECTED','PLAN_OR_SCOPE_CHANGED','DEPENDENCY_INCOMPLETE','COMPLETION_EVIDENCE_MISSING'].includes(c.code) && c.passed) continue;
    if (c.passed && d.request.assignmentId && c.assignmentId !== d.request.assignmentId && !failedIds.includes(c.assignmentId) && !(c.code === 'COMPLETION_EVIDENCE_MISSING' && dependencyIds.includes(c.assignmentId || ''))) continue;
    if (c.passed && !details && !['DEPENDENCY_INCOMPLETE','COMPLETION_EVIDENCE_MISSING'].includes(c.code)) continue;
    if (c.passed && c.code === 'AUTHORIZATION_MISSING_OR_AMBIGUOUS' && !Array.isArray(c.facts.history)) continue;
    const key = JSON.stringify(c); if (seen.has(key)) continue; seen.add(key);
    lines.push(`  ${c.passed ? 'OK' : 'FALLO'} [${c.assignmentId || 'misión'}${c.action ? '/' + c.action : ''}] ${c.code === 'AUTHORIZATION_MISSING_OR_AMBIGUOUS' && Array.isArray(c.facts.history) ? 'Debe existir al menos un registro de autorización para la tarea y acción.' : meanings[c.code]?.[0] || 'Validación del contrato.'}`);
    const f = c.facts;
    if (Array.isArray(f.history)) for (const g of f.history) lines.push(`    Aprobación ${g.authorizationId}: decisión=${g.decision}, estado efectivo=${g.effectiveStatus}, approvedAt=${g.approvedAt}, expira=${g.expiresAt}.`);
    if (c.code === 'AUTHORIZATION_SELECTED') lines.push(`    Seleccionada ${f.authorizationId}; aprobación efectiva=${f.approvedAt}.`);
    if (c.code === 'ACTION_OUT_OF_SCOPE') lines.push(`    Host=${yes(!!f.host)}, misión=${yes(!!f.mission)}, asignación=${yes(!!f.assignment)}.`);
    if (c.code === 'PLAN_OR_SCOPE_CHANGED') lines.push(`    Coinciden versión=${yes(!!f.versionMatches)}, hash=${yes(!!f.hashMatches)}, alcance=${yes(!!f.scopeMatches)}.`);
    if (c.code === 'DEPENDENCY_INCOMPLETE') lines.push(`    Dependencia ${f.dependencyId}: estado declarado=${f.status}.`);
    if (Array.isArray(f.candidates)) {
      if (!f.candidates.length) lines.push('    No hay evidencia candidata referenciada.');
      for (const e of f.candidates) lines.push(`    Evidencia ${e.evidenceReference}: desde aprobación=${yes(e.afterApproval)}, done=${yes(e.done)}, coincide plan=${yes(e.planMatches)}; ${Object.entries(e).filter(([k,v]) => k !== 'evidenceReference' && v === false).map(([k]) => k).join(', ') || 'todos los criterios satisfechos'}.`);
    }
  }
  for (const code of d.errors) lines.push(`  Bloqueo ${code}: ${meanings[code]?.[0] || 'Validación fallida; no se certifica el contrato.'}\n  Cómo resolver: ${meanings[code]?.[1] || 'Revisar los datos del host.'}`);
  lines.push(d.ok ? '  Avance: sólo el estado/consulta indicado. La elegibilidad no prueba ejecución.' : '  Avance detenido en el primer fallo; los controles posteriores no se declaran aprobados.');
  return lines.join('\n');
}

/** Deliberately omit free-form goals/outputs and full snapshots, including approver identities. */
export function structuredDecision(d: Decision): Omit<Decision, 'assignments'> & {assignments: Omit<AssignmentExplanation, 'task'>[]} {
  return {...d, assignments: d.assignments.map(({task, ...a}) => a)};
}
