import { createHash } from 'crypto';
import { AgentName, StandardOutput, TaskType } from '../core/types';
import { WorkerJobAction, WorkerJobStatus } from '../worker/types';
import { validateOutput } from '../core/validate-json';

export const states = ['draft', 'planned', 'awaiting_approval', 'approved', 'ready', 'blocked', 'failed', 'completed'] as const;
export type State = typeof states[number];
export const actions = ['diagnose', 'design', 'implement', 'verify', 'commit', 'push', 'merge', 'deploy'] as const;
export type Action = typeof actions[number];
export interface AssignmentContract {
  assignmentId: string; missionId: string; role: AgentName; goal: string; scope: string;
  dependencies: string[]; expectedOutputs: StandardOutput; allowedActions: Action[];
  status: State; evidenceRefs: string[];
}
export interface MissionContract {
  schemaVersion: '0.1'; missionId: string; taskType: TaskType; objective: string;
  repositoryAlias: string; baseSha: string; branch: string; status: State; planVersion: number;
  assignments: AssignmentContract[];
  authorizationPolicy: { mode: 'explicit'; allowedActions: Action[]; approverIds: string[] };
  evidenceRefs: string[];
}
export interface AuthorizationContract {
  authorizationId: string; missionId: string; assignmentId: string; action: Action;
  approvedBy: string; planVersion: number; planHash: string; scope: string;
  issuedAt: string; expiresAt: string; approvedAt: string | null;
  decision: 'pending' | 'approved' | 'denied' | 'revoked';
}
export interface EvidenceContract {
  source: 'worker' | 'assignment'; jobId: string; action: WorkerJobAction | Action;
  status: WorkerJobStatus; observedAt: string; verifiedBaseSha: string;
  verifiedBranch: string; evidenceReference: string;
  missionId: string; assignmentId: string | null; planHash: string | null;
}

type Check = (v: unknown) => boolean;
const text: Check = v => typeof v === 'string' && v.trim().length > 0 && v.length <= 16000;
export const safeId: Check = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v);
const sha: Check = v => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
const hash: Check = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const version: Check = v => Number.isSafeInteger(v) && (v as number) > 0;
const choice = (values: readonly unknown[]): Check => v => values.includes(v);
const list = (check: Check): Check => v => Array.isArray(v) && v.length <= 1000 && v.every(check) && new Set(v).size === v.length;
const timestamp: Check = v => typeof v === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const branch: Check = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9/_-]{0,200}$/.test(v) && !v.includes('//') && !v.endsWith('/');
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
function shape(v: unknown, fields: Record<string, Check>): boolean {
  return object(v) && Object.keys(v).length === Object.keys(fields).length && Object.entries(fields).every(([k, check]) => Object.hasOwn(v, k) && check(v[k]));
}
function output(v: unknown): boolean {
  return shape(v, {goal: text, scope: text, files_to_touch: list(text), plan: list(text), risks: list(text), validations: list(text), done_when: list(text)}) && validateOutput(v).valid;
}
export function isAssignment(v: unknown): v is AssignmentContract {
  return shape(v, {assignmentId: safeId, missionId: safeId, role: choice(['architect','designer','dev','qa','security','ops']), goal: text, scope: safeId, dependencies: list(safeId), expectedOutputs: output, allowedActions: list(choice(actions)), status: choice(states), evidenceRefs: list(safeId)});
}
export function isAuthorization(v: unknown): v is AuthorizationContract {
  if (!shape(v, {authorizationId: safeId, missionId: safeId, assignmentId: safeId, action: choice(actions), approvedBy: safeId, planVersion: version, planHash: hash, scope: safeId, issuedAt: timestamp, expiresAt: timestamp, approvedAt: x => x === null || timestamp(x), decision: choice(['pending','approved','denied','revoked'])})) return false;
  const a = v as unknown as AuthorizationContract;
  if (Date.parse(a.expiresAt) <= Date.parse(a.issuedAt)) return false;
  return a.decision === 'approved' || a.decision === 'revoked'
    ? a.approvedAt !== null && Date.parse(a.approvedAt) >= Date.parse(a.issuedAt) && Date.parse(a.approvedAt) < Date.parse(a.expiresAt)
    : a.approvedAt === null;
}
export function isEvidence(v: unknown): v is EvidenceContract {
  if (!shape(v, {source: choice(['worker','assignment']), jobId: safeId, action: choice([...actions, 'inspect_repo','prepare_worktree','run_coding_tool']), status: choice(['queued','running','done','failed']), observedAt: timestamp, verifiedBaseSha: sha, verifiedBranch: branch, evidenceReference: safeId, missionId: safeId, assignmentId: x => x === null || safeId(x), planHash: x => x === null || hash(x)})) return false;
  const e = v as unknown as EvidenceContract;
  return e.source === 'worker'
    ? ['inspect_repo','prepare_worktree','run_coding_tool'].includes(e.action) && e.assignmentId === null && e.planHash === null
    : actions.includes(e.action as Action) && safeId(e.assignmentId) && hash(e.planHash);
}
export function parseMission(v: unknown): MissionContract {
  if (!shape(v, {schemaVersion: choice(['0.1']), missionId: safeId, taskType: choice(['feature_small','ui_change','bugfix','infra_change','security_check','research_task']), objective: text, repositoryAlias: safeId, baseSha: sha, branch, status: choice(states), planVersion: version, assignments: x => Array.isArray(x) && x.length > 0 && x.length <= 100 && x.every(isAssignment), authorizationPolicy: x => shape(x, {mode: choice(['explicit']), allowedActions: list(choice(actions)), approverIds: x => list(safeId)(x) && (x as unknown[]).length > 0}), evidenceRefs: list(safeId)})) throw new Error('INVALID_MISSION');
  const m = structuredClone(v) as MissionContract;
  const ids = new Set(m.assignments.map(a => a.assignmentId));
  if (ids.size !== m.assignments.length) throw new Error('DUPLICATE_ASSIGNMENT');
  const visited = new Set<string>(), visiting = new Set<string>();
  const visit = (id: string): void => {
    if (visiting.has(id)) throw new Error('CYCLIC_DEPENDENCY');
    if (visited.has(id)) return;
    const a = m.assignments.find(a => a.assignmentId === id);
    if (!a || a.missionId !== m.missionId) throw new Error('INVALID_DEPENDENCY_OR_MISSION');
    visiting.add(id); a.dependencies.forEach(visit); visiting.delete(id); visited.add(id);
  };
  m.assignments.forEach(a => visit(a.assignmentId));
  return m;
}
function canonical(v: unknown): string {
  if (Array.isArray(v)) return '[' + v.map(canonical).join(',') + ']';
  if (object(v)) return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canonical(v[k])).join(',') + '}';
  return JSON.stringify(v);
}
/** All plan content is bound, including outputs, scopes, repository and permissions. Runtime state is excluded. */
export function planHash(input: MissionContract): string {
  const {status, evidenceRefs, assignments, ...plan} = parseMission(input);
  return createHash('sha256').update(canonical({...plan, assignments: assignments.map(({status, evidenceRefs, ...a}) => a)})).digest('hex');
}
