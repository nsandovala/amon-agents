import { constants } from 'fs';
import { open, realpath } from 'fs/promises';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { AssignmentContract, EvidenceContract, MissionContract, parseMission } from './contracts';

export const PILOT = Object.freeze({
  missionId: 'BF-HOME-001', jobId: 'BF-HOME-001-PREPARE-02', repositoryAlias: 'BracketFlow',
  branch: 'worker/BF-HOME-001', baseSha: 'e80aae09009f64d228a613ab7ac079882cfbd0b4',
  sourceRepo: '/Volumes/AMON-DEV/amon/bracketflow-base-bf-home-001',
  worktree: '/Volumes/AMON-DEV/.amon/worktrees/bracketflow-base-bf-home-001/BF-HOME-001-PREPARE-02',
  evidenceFile: '/Volumes/AMON-DEV/amon-agents/outputs/worker/jobs/BF-HOME-001-PREPARE-02.json',
});
export interface Observation { headSha: string; branch: string; statusShort: string; observedAt: string }
export function pilotMission(): MissionContract {
  const roles = ['architect','designer','dev','qa'] as const;
  const goals = ['Diagnóstico técnico sin escritura', 'Propuesta UX/UI pendiente de ejecutor', 'Implementación futura pendiente de aprobación', 'Verificación posterior QA/Guardian con evidencia'];
  const assignments: AssignmentContract[] = roles.map((role, i) => ({
    assignmentId: `BF-HOME-001-${role}`, missionId: PILOT.missionId, role, goal: goals[i],
    scope: 'BF-HOME-001-home', dependencies: i ? [`BF-HOME-001-${roles[i-1]}`] : [],
    expectedOutputs: {goal: goals[i], scope: 'Home de BracketFlow; sin ejecución en este sprint', files_to_touch: [], plan: [goals[i]], risks: ['Requiere autorización formal y evidencia'], validations: ['Revisión de Nelson'], done_when: ['Entregable revisado con evidencia']},
    allowedActions: [], status: i === 0 ? 'planned' : 'blocked', evidenceRefs: [],
  }));
  return parseMission({schemaVersion: '0.1', missionId: PILOT.missionId, taskType: 'ui_change', objective: 'Planificar rediseño Home de BracketFlow sin ejecutarlo', repositoryAlias: PILOT.repositoryAlias, baseSha: PILOT.baseSha, branch: PILOT.branch, status: 'awaiting_approval', planVersion: 1, assignments, authorizationPolicy: {mode: 'explicit', allowedActions: [], approverIds: ['nelson-sandoval']}, evidenceRefs: []});
}
/** Pure reconciliation: a preparation job never completes a redesign assignment. */
export function reconstructPilot(raw: unknown, observation: Observation | undefined, now: Date) {
  const mission = pilotMission();
  const evidence: EvidenceContract[] = [];
  const errors: string[] = [];
  try {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('PREPARATION_EVIDENCE_MISSING');
    const j = raw as Record<string, any>;
    const e = j.evidence;
    if (j.jobId !== PILOT.jobId || j.action !== 'prepare_worktree' || j.status !== 'done' || j.exitCode !== 0 || j.error || j.repo !== PILOT.sourceRepo || j.branch !== PILOT.branch || !e || e.repoPath !== PILOT.sourceRepo || e.worktreePath !== PILOT.worktree || e.sourceHeadSha !== PILOT.baseSha || e.worktreeHeadSha !== PILOT.baseSha || e.worktreeBranch !== PILOT.branch || e.worktreeStatusShort !== '' || e.created !== true) throw new Error('PREPARATION_EVIDENCE_MISMATCH');
    const times = [j.queuedAt, j.startedAt, j.finishedAt];
    if (!Number.isFinite(now.getTime()) || !times.every(t => typeof t === 'string' && Number.isFinite(Date.parse(t))) || Date.parse(times[0]) > Date.parse(times[1]) || Date.parse(times[1]) > Date.parse(times[2]) || Date.parse(times[2]) > now.getTime() || !Array.isArray(j.transitions) || j.transitions.length !== 3 || !['queued','running','done'].every((s, i) => j.transitions[i]?.status === s && j.transitions[i]?.at === times[i])) throw new Error('PREPARATION_HISTORY_INVALID');
    if (!observation || observation.headSha !== PILOT.baseSha || observation.branch !== PILOT.branch || observation.statusShort !== '' || !Number.isFinite(Date.parse(observation.observedAt)) || Date.parse(observation.observedAt) > now.getTime() || now.getTime() - Date.parse(observation.observedAt) > 60000) throw new Error('ENVIRONMENT_UNVERIFIED');
    evidence.push({source: 'worker', jobId: PILOT.jobId, action: 'prepare_worktree', status: 'done', observedAt: new Date(observation.observedAt).toISOString(), verifiedBaseSha: PILOT.baseSha, verifiedBranch: PILOT.branch, evidenceReference: PILOT.jobId, missionId: PILOT.missionId, assignmentId: null, planHash: null});
    mission.evidenceRefs.push(PILOT.jobId);
  } catch (err) { mission.status = 'blocked'; errors.push((err as Error).message); }
  return {mission, evidence, errors, environmentVerified: errors.length === 0, redesignExecuted: false, existingJobReused: evidence.length === 1};
}
/** Fixed host configuration only: mission text supplies neither paths nor shell commands. */
export async function inspectPilot() {
  try {
    if (await realpath(PILOT.evidenceFile) !== PILOT.evidenceFile || await realpath(PILOT.worktree) !== PILOT.worktree) throw new Error('UNTRUSTED_PATH');
    const file = await open(PILOT.evidenceFile, constants.O_RDONLY | constants.O_NOFOLLOW);
    let raw: unknown;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1024 * 1024) throw new Error('INVALID_EVIDENCE_FILE');
      raw = JSON.parse(await file.readFile('utf8'));
    } finally { await file.close(); }
    const git = promisify(execFile);
    const read = async (args: string[]) => (await git('git', ['--no-optional-locks', '-C', PILOT.worktree, ...args], {timeout: 3000, maxBuffer: 1024 * 1024})).stdout;
    const headSha = (await read(['rev-parse','HEAD'])).trim();
    const branch = (await read(['branch','--show-current'])).trim();
    const statusShort = await read(['status','--porcelain=v1','--untracked-files=all']);
    const headAfter = (await read(['rev-parse','HEAD'])).trim();
    if (headAfter !== headSha) throw new Error('ENVIRONMENT_CHANGED_DURING_READ');
    const now = new Date();
    return reconstructPilot(raw, {headSha, branch, statusShort, observedAt: now.toISOString()}, now);
  } catch {
    const result = reconstructPilot(undefined, undefined, new Date());
    result.errors = ['PILOT_READ_FAILED']; // No raw file content, paths or secrets in logs.
    return result;
  }
}
