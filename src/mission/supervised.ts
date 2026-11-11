import fs from 'node:fs';
import path from 'node:path';
import childProcess from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { ApprovalStore } from './approval-store';
import { approvalContext, localApproverId } from './approval-host';
import { EvidenceContract, MissionContract, parseMission, planHash } from './contracts';
import { proposeAssignment } from './assignment-proposal';
import { canPerform, transition } from './state';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const ALIAS = 'MISSION-TEST', BRANCH = 'mission-test', CONTENT = 'AMON isolated supervised inspection fixture.\n';
const digest = (data: Buffer | string) => createHash('sha256').update(data).digest('hex');
function requireThat(condition: unknown, code: string): asserts condition { if (!condition) throw new Error(code); }
function privateDirectory(dir: string): fs.Stats {
  const s = fs.lstatSync(dir);
  requireThat(s.isDirectory() && !s.isSymbolicLink() && s.uid === process.geteuid!() && (s.mode & 0o077) === 0 && fs.realpathSync(dir) === dir, 'UNSAFE_FIXTURE_DIRECTORY');
  return s;
}
/** Fixed executable and argument arrays. No shell, inherited Git config/env, hooks or provider. */
function git(root: string, args: string[]): string {
  return childProcess.execFileSync('/usr/bin/git', ['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false',
    '-c','core.untrackedCache=false','-c','commit.gpgsign=false', '--git-dir=' + path.join(root,'.git'),
    '--work-tree=' + root, ...args], {cwd: root, encoding: 'utf8', timeout: 3000, maxBuffer: 65536,
    env: {PATH: '/usr/bin:/bin', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_SYSTEM: '/dev/null', GIT_OPTIONAL_LOCKS: '0'}, stdio: ['ignore','pipe','pipe']});
}
interface FixtureRecord {
  version: 1; fixtureId: string; baseSha: string; branch: string; planHash: string;
  directoryDevice: number; directoryInode: number; gitDevice: number; gitInode: number;
}
export interface Inspection {
  headSha: string; branch: string; clean: true; trackedFiles: 1; readmeSha256: string; readmeBytes: number;
}
export interface SupervisedResult {
  version: 1; fixtureId: string; authorizationId: string; executor: 'isolated-git-inspector';
  status: 'completed' | 'blocked'; startedAt: string; finishedAt: string;
  planHash: string; errors: string[]; inspection?: Inspection; evidence?: EvidenceContract; mission?: MissionContract;
}

/** Setup only. Creates a NEW repository below the host-owned store; never accepts a repo path. */
export function createSupervisedFixture(store: ApprovalStore): {fixtureId: string; mission: MissionContract; missionFile: string} {
  return store.exclusive(() => {
    const policy = store.policy();
    requireThat(policy.repositoryAliases.includes(ALIAS) && policy.allowedActions.includes('diagnose'), 'FIXTURE_NOT_ALLOWED');
    const fixtures = path.join(store.directory, 'fixtures');
    if (!fs.existsSync(fixtures)) fs.mkdirSync(fixtures, {mode: 0o700});
    privateDirectory(fixtures);
    const fixtureId = randomUUID(), root = path.join(fixtures, fixtureId);
    fs.mkdirSync(root, {mode: 0o700});
    git(root, ['init','--initial-branch=' + BRANCH]);
    fs.chmodSync(path.join(root,'.git'), 0o700);
    fs.writeFileSync(path.join(root,'README.md'), CONTENT, {flag: 'wx', mode: 0o600});
    git(root, ['add','--','README.md']);
    git(root, ['-c','user.name=AMON isolated fixture','-c','user.email=fixture@example.invalid','commit','-m','Initialize isolated inspection fixture']);
    const baseSha = git(root, ['rev-parse','HEAD']).trim();
    const mission: MissionContract = {schemaVersion: '0.1', missionId: `SUPERVISED-${fixtureId}`, taskType: 'research_task',
      objective: 'Inspeccionar exclusivamente el repositorio de prueba aislado; no ejecutar un LLM ni modificar archivos.',
      repositoryAlias: ALIAS, baseSha, branch: BRANCH, status: 'awaiting_approval', planVersion: 1, evidenceRefs: [],
      authorizationPolicy: {mode: 'explicit', approverIds: [localApproverId()], allowedActions: ['diagnose']},
      assignments: [{assignmentId: 'inspect-fixture', missionId: `SUPERVISED-${fixtureId}`, role: 'architect',
        goal: 'Observar HEAD, rama, limpieza y huella del único archivo de prueba.', scope: 'isolated-inspection',
        dependencies: [], allowedActions: ['diagnose'], status: 'planned', evidenceRefs: [],
        expectedOutputs: {goal: 'Inspección determinista de Git', scope: 'Repositorio de prueba aislado', files_to_touch: [],
          plan: ['Consultar Git y leer README.md'], risks: ['Abortar ante cambios concurrentes'], validations: ['Misma base y rama, permisos y aprobación vigentes'],
          done_when: ['Evidencia real de inspección persistida']}}]};
    const directory = privateDirectory(root), gitDir = privateDirectory(path.join(root,'.git'));
    store.writeExecutionRecord(`fixture-${fixtureId}`, {version: 1, fixtureId, baseSha, branch: BRANCH, planHash: planHash(mission),
      directoryDevice: directory.dev, directoryInode: directory.ino, gitDevice: gitDir.dev, gitInode: gitDir.ino} satisfies FixtureRecord);
    const missionFile = path.join(store.directory, `mission-${fixtureId}.json`);
    fs.writeFileSync(missionFile, JSON.stringify(mission,null,2)+'\n', {flag: 'wx', mode: 0o600});
    return {fixtureId, mission, missionFile};
  });
}

function fixtureRoot(store: ApprovalStore, id: string, m: MissionContract): {root: string; record: FixtureRecord} {
  requireThat(UUID.test(id), 'INVALID_FIXTURE_ID');
  const r = store.readExecutionRecord(`fixture-${id}`) as FixtureRecord;
  requireThat(r && r.version === 1 && r.fixtureId === id && r.branch === BRANCH && /^[a-f0-9]{40}$/.test(r.baseSha) &&
    /^[a-f0-9]{64}$/.test(r.planHash) && [r.directoryDevice,r.directoryInode,r.gitDevice,r.gitInode].every(Number.isSafeInteger), 'INVALID_FIXTURE_RECORD');
  requireThat(planHash(m) === r.planHash && m.baseSha === r.baseSha && m.branch === r.branch && m.repositoryAlias === ALIAS, 'FIXTURE_PLAN_CHANGED');
  const parent = path.join(store.directory,'fixtures'), root = path.join(parent,id);
  privateDirectory(parent);
  const s = privateDirectory(root), g = privateDirectory(path.join(root,'.git'));
  requireThat(s.dev === r.directoryDevice && s.ino === r.directoryInode && g.dev === r.gitDevice && g.ino === r.gitInode, 'FIXTURE_REPLACED');
  return {root, record: r};
}

function inspect(root: string, record: FixtureRecord): Inspection {
  const headSha = git(root, ['rev-parse','HEAD']).trim(), branch = git(root, ['symbolic-ref','--short','HEAD']).trim();
  requireThat(headSha === record.baseSha && branch === record.branch, 'REPOSITORY_DRIFT');
  requireThat(git(root, ['status','--porcelain=v1','--untracked-files=all','--ignore-submodules=all']) === '', 'REPOSITORY_DIRTY');
  requireThat(git(root, ['ls-files','-z']) === 'README.md\0', 'UNEXPECTED_FIXTURE_FILES');
  const fd = fs.openSync(path.join(root,'README.md'), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let data: Buffer;
  try {
    const s = fs.fstatSync(fd);
    requireThat(s.isFile() && s.nlink === 1 && s.uid === process.geteuid!() && s.size === Buffer.byteLength(CONTENT), 'UNSAFE_FIXTURE_FILE');
    data = fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
  requireThat(data.equals(Buffer.from(CONTENT)), 'FIXTURE_CONTENT_CHANGED');
  return {headSha, branch, clean: true, trackedFiles: 1, readmeSha256: digest(data), readmeBytes: data.length};
}

/** One real bounded read-only inspection per approval. Both authorization checks occur under
 * the same store lock as revocations. Input paths/commands/evidence are never accepted.
 */
export function runSupervisedInspection(store: ApprovalStore, fixtureId: string, input: unknown,
  clock: () => Date = () => new Date()): SupervisedResult {
  return store.exclusive(() => {
    let m = parseMission(input);
    const {root, record} = fixtureRoot(store, fixtureId, m);
    let c = approvalContext(store, clock());
    const proposal = proposeAssignment(m, {assignmentId: 'inspect-fixture', action: 'diagnose', requiredCapabilities: ['architecture-plan']},
      {repositoryAliases: c.repositoryAliases, allowedActions: c.allowedActions});
    requireThat(proposal.status === 'proposed' && proposal.proposedRole === 'architect', proposal.errors[0] || 'UNSUPPORTED_EXECUTOR');
    // Rebuild operational state from the approved fixed plan, never from claimed completed states.
    m.status = 'awaiting_approval'; m.evidenceRefs = []; m.assignments[0].status = 'planned'; m.assignments[0].evidenceRefs = [];
    for (const [target,id] of [['approved',undefined],['awaiting_approval','inspect-fixture'],['approved','inspect-fixture'],['ready','inspect-fixture']] as const) {
      const r = transition(m, target, c, id); requireThat(r.ok, r.errors[0]); m = r.mission!;
    }
    const decision = canPerform(m, 'inspect-fixture', 'diagnose', c); requireThat(decision.ok, decision.errors[0]);
    const grantId = String(decision.checks.find(c => c.code === 'AUTHORIZATION_SELECTED' && c.assignmentId === 'inspect-fixture')!.facts.authorizationId);
    requireThat(UUID.test(grantId), 'INVALID_EXECUTION_APPROVAL_ID');
    const startedAt = c.now.toISOString();
    // Write-once reservation: a crash/failed run consumes this approval's attempt, never auto-retry.
    store.writeExecutionRecord(`attempt-${grantId}`, {version: 1, fixtureId, authorizationId: grantId, planHash: record.planHash, startedAt});
    let result: SupervisedResult;
    try {
      const before = inspect(root, record);
      const observation = inspect(root, record);
      fixtureRoot(store, fixtureId, m);
      const after = inspect(root, record);
      requireThat(JSON.stringify(before) === JSON.stringify(observation) && JSON.stringify(observation) === JSON.stringify(after), 'REPOSITORY_CHANGED_DURING_INSPECTION');
      c = approvalContext(store, clock());
      requireThat(c.now.getTime() >= Date.parse(startedAt), 'INVALID_EXECUTION_CLOCK');
      const again = canPerform(m,'inspect-fixture','diagnose',c); requireThat(again.ok, again.errors[0]);
      requireThat(again.checks.some(check => check.code === 'AUTHORIZATION_SELECTED' && check.facts.authorizationId === grantId), 'EXECUTION_APPROVAL_CHANGED');
      const evidence: EvidenceContract = {source: 'assignment', jobId: `INSPECTION-${grantId}`, action: 'diagnose', status: 'done',
        observedAt: c.now.toISOString(), verifiedBaseSha: observation.headSha, verifiedBranch: observation.branch,
        evidenceReference: `INSPECTION-${grantId}`, missionId: m.missionId, assignmentId: 'inspect-fixture', planHash: record.planHash};
      m.assignments[0].evidenceRefs = [evidence.evidenceReference]; c.evidence = [evidence];
      for (const [target,id] of [['completed','inspect-fixture'],['ready',undefined],['completed',undefined]] as const) {
        const r = transition(m,target,c,id); requireThat(r.ok,r.errors[0]); m = r.mission!;
      }
      result = {version: 1, fixtureId, authorizationId: grantId, executor: 'isolated-git-inspector', status: 'completed',
        startedAt, finishedAt: c.now.toISOString(), planHash: record.planHash, errors: [], inspection: observation, evidence, mission: m};
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      result = {version: 1, fixtureId, authorizationId: grantId, executor: 'isolated-git-inspector', status: 'blocked',
        startedAt, finishedAt: new Date().toISOString(), planHash: record.planHash,
        errors: [/^[A-Z_]+$/.test(message) ? message : 'INSPECTION_FAILED']};
    }
    store.writeExecutionRecord(`result-${grantId}`, result);
    return result;
  });
}
