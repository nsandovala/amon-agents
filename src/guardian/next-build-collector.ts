import fs from 'node:fs';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { ApprovalStore } from '../mission/approval-store';
import { approvalContext } from '../mission/approval-host';
import { canPerform } from '../mission/state';
import { MissionContract, parseMission, planHash } from '../mission/contracts';
import { NextBuildRequirements, reviewNextBuildEvidence } from './next-build';
import { directoryDigest, inside, inspectReleaseSource, ReleaseSource, requireRelease, sha256 } from './release-source';

/** Only the authenticated host supplies this object, never a worker observation.
 * Repository registration, reviewed source and installed dependencies are pinned by the host.
 * A store/OS owner is trusted, as in the existing local approval host. */
export interface ReleaseHostRequirements {
  declaredStack: 'auto'|'next'; repositoryAlias: string; sourceSha256: string;
  dependenciesSha256?: string; mission: MissionContract; assignmentId: string;
  storeDirectory: string; buildRecord?: string; timeoutMs: number;
}
export interface HostBuildPolicy {
  runId: string; root: string; headSha: string; branch: string; startedAt: string; now: string;
  nextBuild?: NextBuildRequirements; releaseHost?: unknown;
}
interface Artifact { sha256: string; treeSha256: string; buildId: string; createdAt: string; size: number }
interface BuildObservation {
  runId: string; root: string; headSha: string; branch: string; worktreeHeadShaAfter: string;
  treeClean: boolean; startedAt: string; finishedAt: string; command: string; completed: boolean;
  exitCode: number|null; signal: string|null; timedOut: boolean; logComplete: boolean;
  stdout: string; stderr: string; nodeVersion: string; platform: string; installNodeEnv: string|null;
  buildNodeEnv: string; lockfileSha256: string;
  result: {outcome: string; buildId: string; createdAt: string; evidenceRef: string};
}
interface Collection {
  schemaVersion: 'next-host-build/1'; runId: string; planHash: string; requirementsSha256: string;
  sourceBefore: ReleaseSource; sourceAfter: ReleaseSource|null;
  dependenciesBefore: string; dependenciesAfter: string|null;
  artifact: Artifact|null; observation: BuildObservation; reasons: string[];
  process: {executable: string; executableSha256: string; argv: string[]; pid: number|null; durationMs: number;
    environment: Record<string,string>; stdoutSha256: string; stderrSha256: string; redacted: boolean};
}
const code = (e: unknown): string => e instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(e.message)
  ? e.message : 'RELEASE_HOST_OBSERVATION_FAILED';

function hostContext(policy: HostBuildPolicy): {host: ReleaseHostRequirements; store: ApprovalStore; source: ReleaseSource} {
  const host = policy.releaseHost as ReleaseHostRequirements;
  requireRelease(host && typeof host === 'object' && ['auto','next'].includes(host.declaredStack) &&
    typeof host.sourceSha256 === 'string' && /^[a-f0-9]{64}$/.test(host.sourceSha256) &&
    typeof host.storeDirectory === 'string' && path.isAbsolute(host.storeDirectory) &&
    Number.isSafeInteger(host.timeoutMs) && host.timeoutMs >= 100 && host.timeoutMs <= 30*60*1000,'RELEASE_HOST_INVALID');
  const mission = parseMission(host.mission);
  requireRelease(mission.repositoryAlias === host.repositoryAlias && mission.baseSha === policy.headSha &&
    mission.branch === policy.branch,'RELEASE_AUTHORIZATION_CONTEXT_MISMATCH');
  const store = new ApprovalStore(host.storeDirectory);
  requireRelease(!inside(fs.realpathSync(policy.root),fs.realpathSync(store.directory)),'RELEASE_STORE_INSIDE_SOURCE');
  const permission = canPerform(mission,host.assignmentId,'verify',approvalContext(store,new Date()));
  requireRelease(permission.ok,permission.errors[0] ?? 'RELEASE_NOT_AUTHORIZED');
  const source = inspectReleaseSource(policy.root);
  requireRelease(source.headSha === policy.headSha && source.branch === policy.branch &&
    source.sourceSha256 === host.sourceSha256,'RELEASE_SOURCE_CHANGED');
  requireRelease(source.treeClean,'RELEASE_SOURCE_NOT_CLEAN');
  requireRelease(host.declaredStack !== 'next' || source.stack === 'next','RELEASE_STACK_AMBIGUOUS');
  return {host,store,source};
}
function nextRequirements(policy: HostBuildPolicy, source: ReleaseSource): NextBuildRequirements {
  requireRelease(!!policy.nextBuild,'NEXT_REQUIREMENTS_MISSING');
  const requirements = policy.nextBuild!;
  requireRelease(typeof requirements.lockfileText === 'string' && sha256(requirements.lockfileText) === source.lockfileSha256,
    'RELEASE_LOCKFILE_CHANGED');
  requireRelease(requirements.nodeVersion === process.version && requirements.platform === process.platform &&
    requirements.installNodeEnv === null,'RELEASE_RUNTIME_UNSUPPORTED');
  // Validate the existing security/environment policy BEFORE executing any project code.
  const precheck = reviewNextBuildEvidence(undefined,{...requirements,...policy,now:new Date().toISOString()});
  const reasons = precheck.findings.filter(f => f.code !== 'NEXT_BUILD_MISSING').map(f => f.code);
  requireRelease(!reasons.length,reasons[0] ?? 'NEXT_REQUIREMENTS_INVALID');
  return requirements;
}
function installedDependencies(root: string, version: string|null): string {
  const deps = path.join(root,'node_modules');
  const digest = directoryDigest(deps,'dependencies');
  const pkg = JSON.parse(fs.readFileSync(path.join(deps,'next/package.json'),'utf8'));
  requireRelease(pkg.name === 'next' && pkg.version === version,'RELEASE_INSTALLED_NEXT_MISMATCH');
  requireRelease(fs.realpathSync(path.join(deps,'next/dist/bin/next')) === path.join(deps,'next/dist/bin/next'),
    'RELEASE_NEXT_EXECUTABLE_INVALID');
  return digest;
}
function artifact(root: string): Artifact {
  const dir = path.join(root,'.next'), file = path.join(dir,'BUILD_ID');
  requireRelease(!fs.lstatSync(dir).isSymbolicLink(),'NEXT_ARTIFACT_INVALID');
  const s = fs.lstatSync(file);
  requireRelease(s.isFile() && !s.isSymbolicLink() && s.nlink === 1,'NEXT_ARTIFACT_INVALID');
  const bytes = fs.readFileSync(file), buildId = bytes.toString('utf8').trim();
  requireRelease(/^[a-zA-Z0-9_-]{1,256}$/.test(buildId),'NEXT_ARTIFACT_INVALID');
  return {sha256:sha256(bytes),treeSha256:directoryDigest(dir,'artifact'),buildId,createdAt:new Date(s.mtimeMs).toISOString(),size:s.size};
}

/** Redact complete captured streams, after joining chunks (secrets may cross chunks).
 * No inherited secrets are passed to the child. No raw logs are persisted. */
function redact(text: string): string {
  let result = text;
  for (const [key,value] of Object.entries(process.env)) {
    if (value && value.length >= 4 && /secret|token|password|credential|api.?key|database.?url/i.test(key))
      result = result.split(value).join('[REDACTED]');
  }
  return result.replace(/((?:password|secret|token|api[_-]?key|authorization)\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/gi,'$1[REDACTED]')
    .replace(/\b(Bearer)\s+\S+/gi,'$1 [REDACTED]')
    .replace(/\b(?:gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16}|xox[bapsr]-[A-Za-z0-9-]+)/g,'[REDACTED]')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi,'$1[REDACTED]@');
}
async function processBuild(root: string, environment: Record<string,string>, timeoutMs: number) {
  const argv = [path.join(root,'node_modules/next/dist/bin/next'),'build'];
  const start = performance.now();
  const startedAt = new Date().toISOString();
  const raw: Buffer[][] = [[],[]], hashes = [createHash('sha256'),createHash('sha256')];
  let bytes = 0, logComplete = true, spawned = false, failed = false, timedOut = false;
  const child = spawn(process.execPath,argv,{cwd:root,env:environment,stdio:['ignore','pipe','pipe'],detached:process.platform !== 'win32'});
  const stopOwnedGroup = (signal: NodeJS.Signals) => {
    try { if (child.pid && process.platform !== 'win32') process.kill(-child.pid,signal); else child.kill(signal); } catch { /* already exited */ }
  };
  let hardStop: NodeJS.Timeout|undefined;
  const timer = setTimeout(() => {timedOut=true; stopOwnedGroup('SIGTERM'); hardStop=setTimeout(() => stopOwnedGroup('SIGKILL'),1000);},timeoutMs);
  child.once('spawn',() => {spawned=true;}); child.once('error',() => {failed=true;});
  [child.stdout,child.stderr].forEach((stream,i) => {
    stream.on('error',() => {logComplete=false;});
    stream.on('data',(chunk: Buffer) => {
      hashes[i].update(chunk); bytes += chunk.length;
      if (bytes <= 1024*1024) raw[i].push(Buffer.from(chunk)); else logComplete=false;
    });
  });
  const exit = await new Promise<{exitCode: number|null; signal: string|null}>(resolve => {
    child.once('close',(exitCode,signal) => resolve({exitCode,signal}));
  });
  clearTimeout(timer); if (hardStop) clearTimeout(hardStop);
  const stdoutRaw=Buffer.concat(raw[0]).toString('utf8'), stderrRaw=Buffer.concat(raw[1]).toString('utf8');
  const stdout=redact(stdoutRaw), stderr=redact(stderrRaw);
  return {...exit,startedAt,finishedAt:new Date().toISOString(),completed:spawned && !failed,timedOut,logComplete,
    stdout,stderr,unredactedStdout:stdoutRaw,unredactedStderr:stderrRaw,process:{executable:process.execPath,executableSha256:sha256(fs.readFileSync(process.execPath)),argv,
      pid:child.pid ?? null,durationMs:performance.now()-start,environment,stdoutSha256:hashes[0].digest('hex'),
      stderrSha256:hashes[1].digest('hex'),redacted:stdout !== stdoutRaw || stderr !== stderrRaw}};
}

/** Runs ONLY after canPerform and source/dependency pins pass. No npm scripts,
 * shell, inherited environment, network acquisition, grant creation or publication.
 * It creates a new authenticated record in the existing private ApprovalStore. */
export async function collectNextBuild(input: HostBuildPolicy): Promise<{recordName: string; reasons: string[]}> {
  const policy = structuredClone(input);
  const {host,store,source} = hostContext(policy);
  requireRelease(source.stack === 'next','RELEASE_NOT_NEXT');
  const requirements = nextRequirements(policy,source);
  const dependenciesBefore = installedDependencies(source.root,source.nextVersion);
  requireRelease(dependenciesBefore === host.dependenciesSha256,'RELEASE_DEPENDENCIES_CHANGED');
  requireRelease(!fs.existsSync(path.join(source.root,'.next')),'NEXT_ARTIFACT_PREEXISTS');
  const id = randomUUID(), recordName = `result-${id}`;
  const home = path.join(store.directory,`build-${id}`); fs.mkdirSync(home,{mode:0o700});
  const environment = {PATH:`${path.dirname(process.execPath)}:/usr/bin:/bin`,HOME:home,TMPDIR:home,
    NODE_ENV:'production',NEXT_TELEMETRY_DISABLED:'1',CI:'1',LANG:'C.UTF-8',TZ:'UTC'};
  const attempt = `attempt-${id}`;
  store.writeExecutionRecord(attempt,{schemaVersion:'next-host-attempt/1',runId:policy.runId,planHash:planHash(host.mission),source,
    dependenciesSha256:dependenciesBefore,startedAt:new Date().toISOString(),recordName});
  // Recheck authorization/source immediately before execution after dependency inspection.
  hostContext(policy);
  const result = await processBuild(source.root,environment,host.timeoutMs);
  const reasons: string[] = [];
  let sourceAfter: ReleaseSource|null=null, dependenciesAfter: string|null=null, output: Artifact|null=null;
  try { sourceAfter=hostContext(policy).source; } catch (e) { reasons.push(code(e)); }
  try { dependenciesAfter=installedDependencies(source.root,source.nextVersion);
    requireRelease(dependenciesAfter === dependenciesBefore,'RELEASE_DEPENDENCIES_CHANGED'); } catch (e) { reasons.push(code(e)); }
  try { output=artifact(source.root);
    requireRelease(Date.parse(output.createdAt) >= Date.parse(result.startedAt) && Date.parse(output.createdAt) <= Date.parse(result.finishedAt),
      'NEXT_ARTIFACT_STALE'); } catch (e) { reasons.push(code(e)); }
  const observation: BuildObservation = {runId:policy.runId,root:source.root,headSha:source.headSha,branch:source.branch,
    worktreeHeadShaAfter:sourceAfter?.headSha ?? source.headSha,treeClean:sourceAfter?.treeClean ?? false,
    startedAt:result.startedAt,finishedAt:result.finishedAt,command:'next build',completed:result.completed,
    exitCode:result.exitCode,signal:result.signal,timedOut:result.timedOut,logComplete:result.logComplete,
    stdout:result.stdout,stderr:result.stderr,nodeVersion:process.version,platform:process.platform,installNodeEnv:requirements.installNodeEnv,
    buildNodeEnv:environment.NODE_ENV,lockfileSha256:source.lockfileSha256,
    result:{outcome:result.exitCode === 0 && output && !reasons.length ? 'passed':'failed',buildId:output?.buildId ?? '',
      createdAt:output?.createdAt ?? result.finishedAt,evidenceRef:`${recordName}:.next/BUILD_ID`}};
  reasons.push(...reviewNextBuildEvidence({...observation,stdout:result.unredactedStdout,stderr:result.unredactedStderr},{...requirements,...policy,now:new Date().toISOString()}).findings
    .filter(f => f.severity !== 'info').map(f => f.code));
  const record: Collection = {schemaVersion:'next-host-build/1',runId:policy.runId,planHash:planHash(host.mission),
    requirementsSha256:sha256(JSON.stringify(requirements)),sourceBefore:source,sourceAfter,dependenciesBefore,dependenciesAfter,
    artifact:output,observation,reasons:[...new Set(reasons)],process:result.process};
  store.writeExecutionRecord(recordName,record);
  return {recordName,reasons:record.reasons};
}

/** Called by releaseGate. Read-only, live revalidation; no worker observations
 * can select the store, source, policy, authorization or collection record. */
export function reviewHostRelease(policy: HostBuildPolicy): {reasons: string[]; stack?: 'next'|'other'; evidence?: BuildObservation} {
  try {
    const {host,store,source} = hostContext(policy);
    if (source.stack === 'other') {
      requireRelease(!policy.nextBuild && !host.buildRecord,'RELEASE_STACK_AMBIGUOUS');
      return {reasons:[],stack:'other'};
    }
    const requirements=nextRequirements(policy,source);
    requireRelease(typeof host.buildRecord === 'string','NEXT_HOST_BUILD_MISSING');
    const record=store.readExecutionRecord(host.buildRecord!) as Collection;
    requireRelease(record?.schemaVersion === 'next-host-build/1' && record.runId === policy.runId &&
      record.planHash === planHash(host.mission) && record.requirementsSha256 === sha256(JSON.stringify(requirements)),
      'NEXT_HOST_RECORD_MISMATCH');
    requireRelease(record.sourceBefore.sourceSha256 === source.sourceSha256 && record.sourceAfter?.sourceSha256 === source.sourceSha256 &&
      record.sourceBefore.headSha === source.headSha && record.sourceAfter.headSha === source.headSha &&
      record.sourceBefore.root === source.root && record.sourceBefore.branch === source.branch &&
      record.sourceBefore.lockfileSha256 === source.lockfileSha256 && record.sourceAfter.lockfileSha256 === source.lockfileSha256,
      'RELEASE_SOURCE_CHANGED');
    const deps=installedDependencies(source.root,source.nextVersion);
    requireRelease(deps === host.dependenciesSha256 && deps === record.dependenciesBefore && deps === record.dependenciesAfter,
      'RELEASE_DEPENDENCIES_CHANGED');
    requireRelease(JSON.stringify(artifact(source.root)) === JSON.stringify(record.artifact),'NEXT_ARTIFACT_CHANGED');
    requireRelease(sha256(fs.readFileSync(process.execPath)) === record.process.executableSha256,'RELEASE_RUNTIME_CHANGED');
    return {reasons:record.reasons,stack:'next',evidence:record.observation};
  } catch (e) { return {reasons:[code(e)]}; }
}
