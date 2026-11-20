import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EvidenceContract, planHash } from '../mission/contracts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fixture } from '../mission/demo/fixtures';
import { ApprovalStore } from '../mission/approval-store';
import { approveLocal, localApproverId, revokeLocal } from '../mission/approval-host';
import { releaseGate, RuntimeReport } from '../standards/gates';
import { nextFixture } from './fixtures/next-release';
import { collectNextBuild, HostBuildPolicy, ReleaseHostRequirements } from './next-build-collector';
import { directoryDigest, gitRead, inspectReleaseManifests, inspectReleaseSource, sha256 } from './release-source';

const roots: string[]=[];
const accept = async (_preview: string, challenge: string) => challenge; // synthetic test host ONLY
const buildScript = `const fs=require('fs');fs.mkdirSync('.next');fs.mkdirSync('.next/server');
fs.writeFileSync('.next/server/page.js','rendered output');fs.writeFileSync('.next/BUILD_ID','test-build');
console.log('Compiled successfully');`;
function git(root: string,...args: string[]) { return execFileSync('/usr/bin/git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],
  env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Isolated fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',
    GIT_COMMITTER_NAME:'Isolated fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}}).trim(); }
async function setup(script=buildScript, existingRoot?: string, other=false) {
  const parent=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'guardian-host-test-'))); if (!existingRoot) roots.push(parent);
  const root=existingRoot ?? path.join(parent,'source');
  if (!existingRoot) {
    fs.mkdirSync(root);
    fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'authorized-next-test',version:'1.0.0',dependencies:other ? {} : {next:'^15.0.0'}}));
    fs.writeFileSync(path.join(root,'package-lock.json'),other ? JSON.stringify({lockfileVersion:3,packages:{'':{dependencies:{}}}}) : nextFixture().policy.nextBuild.lockfileText);
    fs.writeFileSync(path.join(root,'.gitignore'),'node_modules/\n.next/\n');
    fs.writeFileSync(path.join(root,'page.js'),'export default function Page(){return null;}\n');
    git(root,'init','-b','fixture/next-host');git(root,'add','.');git(root,'-c','core.hooksPath=/dev/null','commit','-m','Disposable authorized test fixture');
    fs.mkdirSync(path.join(root,'node_modules/next/dist/bin'),{recursive:true});
    fs.writeFileSync(path.join(root,'node_modules/next/package.json'),JSON.stringify({name:'next',version:'15.1.2'}));
    fs.writeFileSync(path.join(root,'node_modules/next/dist/bin/next'),script);
  }
  if (existingRoot && !fs.existsSync(path.join(root,'.git'))) {
    // Disposable fixture history only; never changes an AMON branch or creates an AMON commit.
    git(root,'init','-b','fixture/next-host');git(root,'add','.');git(root,'-c','core.hooksPath=/dev/null','commit','-m','Disposable authentic Next fixture');
  }
  const source=inspectReleaseSource(root);
  const store=new ApprovalStore(path.join(parent,'private'));store.initialize({repositoryAliases:['LOCAL-FIXTURE'],allowedActions:['verify']});
  const {m}=fixture(['qa']);m.baseSha=source.headSha;m.branch=source.branch;m.authorizationPolicy.approverIds=[localApproverId()];
  const expiresAt=new Date(Date.now()+3600_000).toISOString();
  await approveLocal(store,m,'qa','verify',expiresAt,accept);
  const startedAt=new Date().toISOString();
  const host: ReleaseHostRequirements={declaredStack:'auto',repositoryAlias:m.repositoryAlias,sourceSha256:source.sourceSha256,
    dependenciesSha256:directoryDigest(path.join(root,'node_modules'),'dependencies'),mission:m,assignmentId:'qa',storeDirectory:store.directory,timeoutMs:120_000};
  const nextBuild={...nextFixture().policy.nextBuild,lockfileText:fs.readFileSync(path.join(root,'package-lock.json'),'utf8'),
    nodeVersion:process.version,platform:process.platform,advisoryNotBefore:'2026-11-18T00:00:00.000Z'};
  if (existingRoot && process.env.AMON_NEXT_REAL_ADVISORY) {
    const body=fs.readFileSync(process.env.AMON_NEXT_REAL_ADVISORY,'utf8');
    const id=JSON.parse(body).ghsa_id;
    nextBuild.advisories=[{id,source:`https://api.github.com/advisories/${id}`,retrievedAt:startedAt,sha256:sha256(body),body}];
  }
  const policy: HostBuildPolicy & {required: []; guardianVerdict:'PASS'}={runId:'HOST-NEXT-001',root,headSha:source.headSha,branch:source.branch,
    startedAt,now:startedAt,required:[],guardianVerdict:'PASS',nextBuild,releaseHost:host};
  const report=(): RuntimeReport => ({schemaVersion:'1.0',runId:policy.runId,root,headSha:source.headSha,branch:source.branch,
    observedAt:startedAt,checks:[]});
  const review=() => releaseGate(report(),{...policy,now:new Date().toISOString()});
  const collect=async () => {const result=await collectNextBuild(policy);host.buildRecord=result.recordName;return result;};
  return {parent,root,store,host,policy,report,review,collect};
}
afterEach(() => {for (const root of roots.splice(0)) fs.rmSync(root,{recursive:true,force:true});});

describe('authorized host collector (real child processes, synthetic Next binary)', () => {
  it('detects a local Next release even when the caller omits every Next/host option', async () => {
    const f=await setup();delete f.policy.releaseHost;delete f.policy.nextBuild;
    expect(f.review().verdict).toBe('BLOCKED');
  });
  it('keeps non-Next legacy projects without an npm lockfile compatible', async () => {
    const f=await setup(undefined,undefined,true);delete f.policy.releaseHost;delete f.policy.nextBuild;
    fs.unlinkSync(path.join(f.root,'package-lock.json'));
    expect(f.review().verdict).toBe('PASS');
  });
  it.each(['next.config.js','package-script'])('blocks Next hints contradicting manifest/lock: %s', async hint => {
    const f=await setup(undefined,undefined,true);delete f.policy.releaseHost;delete f.policy.nextBuild;
    if (hint === 'next.config.js') fs.writeFileSync(path.join(f.root,hint),'module.exports = {};');
    else {
      const manifest=JSON.parse(fs.readFileSync(path.join(f.root,'package.json'),'utf8'));
      manifest.scripts={build:'next build'};fs.writeFileSync(path.join(f.root,'package.json'),JSON.stringify(manifest));
    }
    expect(f.review().verdict).toBe('BLOCKED');
  });
  it('preserves an authorized non-Next project without requiring a build policy', async () => {
    const f=await setup(undefined,undefined,true);delete f.policy.nextBuild;
    expect(f.review().verdict).toBe('PASS');
  });
  it('retains failure diagnostics even when credential redaction removes their text', async () => {
    process.env.GUARDIAN_DIAGNOSTIC_SECRET='Error: synthetic sensitive diagnostic';
    try {
      const f=await setup(buildScript+"console.log('Error: synthetic sensitive diagnostic');");
      expect((await f.collect()).reasons).toContain('NEXT_BUILD_LOG_FAILURE');
      expect(f.review().verdict).toBe('BLOCKED');
    } finally { delete process.env.GUARDIAN_DIAGNOSTIC_SECRET; }
  });

  it('approves complete legitimate execution and preserves signed evidence outside source', async () => {
    const f=await setup();const before=inspectReleaseSource(f.root);
    const result=await f.collect();expect(result.reasons).toEqual([]);expect(f.review().verdict).toBe('PASS');
    expect(inspectReleaseSource(f.root)).toEqual(before);
    const record=f.store.readExecutionRecord(result.recordName) as any;
    expect(record.observation).toMatchObject({exitCode:0,completed:true,logComplete:true,treeClean:true});
    expect(record.process.pid).toBeGreaterThan(0);expect(record.process.durationMs).toBeGreaterThan(0);
    expect(record.process.groupTerminated).toBe(true);expect(alive(-record.process.pid)).toBe(false);
    expect(record.artifact.treeSha256).toHaveLength(64);expect(record.sourceBefore).toEqual(record.sourceAfter);
  });
  it('blocks apparently successful output with exit 1', async () => {
    const f=await setup(buildScript+'process.exit(1);');const r=await f.collect();
    expect(r.reasons).toContain('NEXT_BUILD_EXIT_FAILED');expect(f.review().verdict).toBe('BLOCKED');
  });
  it('blocks omitted build and never executes it implicitly at release review', async () => {
    const f=await setup();expect(f.review().reasons).toContain('NEXT_HOST_BUILD_MISSING');
    expect(fs.existsSync(path.join(f.root,'.next'))).toBe(false);
  });
  it('blocks missing Next policy before process execution', async () => {
    const f=await setup();delete f.policy.nextBuild;
    expect(f.review().reasons).toContain('NEXT_REQUIREMENTS_MISSING');
    await expect(f.collect()).rejects.toThrow('NEXT_REQUIREMENTS_MISSING');
    expect(fs.existsSync(path.join(f.root,'.next'))).toBe(false);
  });
  it.each(['page.js','package-lock.json','new-ignored-file'])('blocks changed %s after a build', async name => {
    const f=await setup();await f.collect();fs.appendFileSync(path.join(f.root,name),'\nchanged');
    expect(f.review().verdict).toBe('BLOCKED');
  });
  it('blocks HEAD changes after a build', async () => {
    const f=await setup();await f.collect();git(f.root,'-c','core.hooksPath=/dev/null','commit','--allow-empty','-m','Disposable fixture revision');
    expect(f.review().reasons).toContain('RELEASE_SOURCE_CHANGED');
  });
  it('blocks source or lock changes during the actual child process', async () => {
    const f=await setup(buildScript+"fs.appendFileSync('package-lock.json','\\n');");
    const r=await f.collect();expect(r.reasons).toContain('RELEASE_SOURCE_CHANGED');expect(f.review().verdict).toBe('BLOCKED');
  });
  it('rejects an old artifact before execution, without deleting it', async () => {
    const f=await setup();fs.mkdirSync(path.join(f.root,'.next'));fs.writeFileSync(path.join(f.root,'.next/BUILD_ID'),'old-build');
    await expect(f.collect()).rejects.toThrow('NEXT_ARTIFACT_PREEXISTS');
    expect(fs.readFileSync(path.join(f.root,'.next/BUILD_ID'),'utf8')).toBe('old-build');
  });
  it('rejects a backdated artifact created by the build', async () => {
    const f=await setup(buildScript+"fs.utimesSync('.next/BUILD_ID',new Date(0),new Date(0));");
    expect((await f.collect()).reasons).toContain('NEXT_ARTIFACT_STALE');expect(f.review().verdict).toBe('BLOCKED');
  });
  it('detects artifact content changes even if BUILD_ID and timestamp were left alone', async () => {
    const f=await setup();await f.collect();fs.writeFileSync(path.join(f.root,'.next/server/page.js'),'tampered');
    expect(f.review().reasons).toContain('NEXT_ARTIFACT_CHANGED');
  });
  it('rejects worker attempts to change requirements, approvals or build results', async () => {
    const f=await setup();await f.collect();
    for (const extra of [{required:[]},{releaseHost:f.host},{approvals:[]},{exclusions:[]}])
      expect(releaseGate({...f.report(),...extra},f.policy).reasons).toContain('INVALID_RUNTIME_REPORT');
    expect(releaseGate({...f.report(),nextBuild:nextFixture().build},f.policy).reasons).toContain('NEXT_WORKER_BUILD_NOT_ACCEPTED');
  });
  it('rejects unsigned/altered/replayed records', async () => {
    const f=await setup();await f.collect();
    const recordPath=path.join(f.store.directory,f.host.buildRecord+'.json');
    const envelope=JSON.parse(fs.readFileSync(recordPath,'utf8'));const record=JSON.parse(envelope.payload);
    record.observation.exitCode=0;record.observation.stdout='forged';envelope.payload=JSON.stringify(record);
    fs.writeFileSync(recordPath,JSON.stringify(envelope));
    expect(f.review().reasons).toContain('EXECUTION_RECORD_INVALID');
  });
  it('rejects a valid build from another run', async () => {
    const f=await setup();await f.collect();f.policy.runId='ANOTHER-RUN';
    expect(f.review().reasons).toContain('NEXT_HOST_RECORD_MISMATCH');
  });
  it('checks revocation again at release time', async () => {
    const f=await setup();await f.collect();await revokeLocal(f.store,f.store.snapshots()[0].authorizationId,accept);
    expect(f.review().reasons).toContain('NOT_APPROVED');
  });
  it('never executes unknown or unapproved repositories', async () => {
    const f=await setup();f.host.repositoryAlias='UNKNOWN';
    await expect(f.collect()).rejects.toThrow('RELEASE_AUTHORIZATION_CONTEXT_MISMATCH');
    expect(fs.existsSync(path.join(f.root,'.next'))).toBe(false);
  });
  it('rejects changed plans and dependencies before execution', async () => {
    const f=await setup();f.host.mission.objective+='changed';await expect(f.collect()).rejects.toThrow('PLAN_OR_SCOPE_CHANGED');
    f.host.mission.objective=f.host.mission.objective.replace(/changed$/,'');
    fs.appendFileSync(path.join(f.root,'node_modules/next/dist/bin/next'),'//changed');
    await expect(f.collect()).rejects.toThrow('RELEASE_DEPENDENCIES_CHANGED');
  });
  it('does not inherit credentials and redacts streams across chunk boundaries', async () => {
    process.env.GUARDIAN_TEST_SECRET='credential-unit-fixture-12345';
    try {
      const f=await setup(buildScript+`process.stdout.write('token=');setTimeout(()=>console.log('credential-unit-fixture-12345'),10);
if(process.env.GUARDIAN_TEST_SECRET)throw Error('inherited');`);
      const r=await f.collect();const record=f.store.readExecutionRecord(r.recordName) as any;
      expect(JSON.stringify(record)).not.toContain('credential-unit-fixture-12345');expect(record.process.redacted).toBe(true);
      expect(record.observation.stdout).toContain('[REDACTED]');expect(f.review().verdict).toBe('PASS');
    } finally {delete process.env.GUARDIAN_TEST_SECRET;}
  });
  it('blocks environment files and external dependency links', async () => {
    const f=await setup();fs.writeFileSync(path.join(f.root,'.env.local'),'TOKEN=test');
    await expect(f.collect()).rejects.toThrow('RELEASE_ENV_FILE_UNSUPPORTED');fs.unlinkSync(path.join(f.root,'.env.local'));
    fs.symlinkSync(f.parent,path.join(f.root,'node_modules/external'));
    await expect(f.collect()).rejects.toThrow('RELEASE_EXTERNAL_OR_SOURCE_LINK');
  });
  it('captures timeout and signal as failures', async () => {
    const f=await setup('setInterval(()=>{},1000);');f.host.timeoutMs=100;
    const r=await f.collect();const record=f.store.readExecutionRecord(r.recordName) as any;
    expect(record.observation.timedOut).toBe(true);expect(record.observation.signal).toBe('SIGTERM');
    expect(f.review().verdict).toBe('BLOCKED');
  });
  it('blocks incomplete logs instead of certifying truncated evidence', async () => {
    const f=await setup(buildScript+"process.stdout.write('x'.repeat(1100000));");
    expect((await f.collect()).reasons).toContain('NEXT_BUILD_INCOMPLETE');expect(f.review().verdict).toBe('BLOCKED');
  });
  it('blocks manifest/lock contradictions and unresolved stack declarations', async () => {
    const f=await setup();const manifest=JSON.parse(fs.readFileSync(path.join(f.root,'package.json'),'utf8'));
    delete manifest.dependencies.next;fs.writeFileSync(path.join(f.root,'package.json'),JSON.stringify(manifest));
    expect(()=>inspectReleaseSource(f.root)).toThrow('RELEASE_MANIFEST_LOCK_MISMATCH');
  });
});

// These records are written by the synthetic trusted test host, never by the build worker.
async function dependentSetup() {
  const f=await setup();
  await revokeLocal(f.store,f.store.snapshots()[0].authorizationId,accept);
  const m=f.host.mission, qa=m.assignments[0];
  const dependency={...structuredClone(qa),assignmentId:'prior-qa',status:'completed' as const,evidenceRefs:['PRIOR-QA']};
  qa.dependencies=[dependency.assignmentId];m.assignments.unshift(dependency);m.evidenceRefs=['PRIOR-QA'];
  for (const id of ['prior-qa','qa']) await approveLocal(f.store,m,id,'verify',new Date(Date.now()+3600_000).toISOString(),accept);
  const evidence: EvidenceContract={source:'assignment',jobId:'PRIOR-QA-JOB',action:'verify',status:'done',
    observedAt:new Date().toISOString(),verifiedBaseSha:m.baseSha,verifiedBranch:m.branch,
    evidenceReference:'PRIOR-QA',missionId:m.missionId,assignmentId:'prior-qa',planHash:planHash(m)};
  const recordName=`result-${randomUUID()}`;
  f.store.writeExecutionRecord(recordName,evidence);
  f.host.evidenceRecords=[recordName];
  return {...f,evidence,recordName};
}
function alive(pid: number): boolean {
  try {process.kill(pid,0);return true;} catch (e) {if ((e as NodeJS.ErrnoException).code === 'ESRCH') return false;throw e;}
}
const delay=(ms: number) => new Promise(resolve=>setTimeout(resolve,ms));

describe('PR15 P2 regressions', () => {
  it.each(['timeout','normal-exit'])('P2-A regression: kills a persistent descendant with independent output after parent %s', async mode => {
    const descendant=`const fs=require('fs');process.on('SIGTERM',()=>{});
      fs.writeFileSync(process.env.HOME+'/descendant',String(process.pid));
      setInterval(()=>fs.appendFileSync(process.env.HOME+'/heartbeat','x'),30);
      setTimeout(()=>process.exit(0),8000);`;
    const f=await setup(`const {spawn}=require('child_process');const fs=require('fs');
      const fd=fs.openSync(process.env.HOME+'/child-output','w');
      spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',fd,fd]});
      ${mode === 'timeout' ? 'setInterval(()=>{},1000);' : "setTimeout(()=>process.exit(0),200);"}`);
    f.host.timeoutMs=500;
    const result=await f.collect();const record=f.store.readExecutionRecord(result.recordName) as any;
    const pid=Number(fs.readFileSync(path.join(record.process.environment.HOME,'descendant'),'utf8'));
    try {
      expect(record.process.groupTerminated).toBe(true);
      expect(alive(-record.process.pid)).toBe(false);
      await delay(1200);
      expect(record.observation.timedOut).toBe(true);
      expect(alive(pid)).toBe(false);
      expect(alive(-record.process.pid)).toBe(false);
      expect(f.review().verdict).toBe('BLOCKED');
      console.log('P2-A owned parent/group',record.process.pid,'descendant',pid,'absent');
    } finally {
      // Exact descendant created by this test, authorized by the ticket's residual cleanup.
      if (alive(pid)) process.kill(pid,'SIGKILL');
      for (let i=0;i<100 && alive(pid);i++) await delay(20);
      expect(alive(pid)).toBe(false);
    }
  },15000);
  it('P2-B regression: accepts authenticated evidence for a valid dependency mission', async () => {
    const f=await dependentSetup();
    expect((await f.collect()).reasons).toEqual([]);
    expect(f.review().verdict).toBe('PASS');
  });
  it('P2-C regression: blocks a repository fsmonitor hook and still detects changes', async () => {
    const f=await setup();const marker=path.join(f.parent,'hook-ran'), hook=path.join(f.root,'.git/hooks/benign-fsmonitor');
    fs.writeFileSync(hook,`#!/bin/sh\nprintf invoked > '${marker}'\nprintf '\\0'\n`,{mode:0o700});
    git(f.root,'config','core.fsmonitor',hook);
    const config=fs.readFileSync(path.join(f.root,'.git/config'));
    git(f.root,'status','--porcelain');expect(fs.existsSync(marker)).toBe(true);
    fs.unlinkSync(marker);
    expect(gitRead(f.root,'status','--porcelain')).toBe('');
    expect(fs.existsSync(marker)).toBe(false);
    fs.appendFileSync(path.join(f.root,'page.js'),'// real change\n');
    expect(gitRead(f.root,'status','--porcelain')).toContain('page.js');
    expect(inspectReleaseSource(f.root).treeClean).toBe(false);
    expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readFileSync(path.join(f.root,'.git/config'))).toEqual(config);
    console.log('P2-C benign hook positive control ran; host blocked hook; real change detected; config unchanged');
  });
});

describe('PR15 P2 fail-closed authorization and lifecycle', () => {
  it('leaves an unrelated process group alive during build timeout cleanup', async () => {
    const sentinel=spawn(process.execPath,['-e','setInterval(()=>{},1000);setTimeout(()=>process.exit(0),8000);'],
      {detached:true,stdio:'ignore'});
    const closed=new Promise<void>(resolve=>sentinel.once('close',()=>resolve()));
    try {
      const f=await setup('setInterval(()=>{},1000);');f.host.timeoutMs=100;
      const result=await f.collect(), record=f.store.readExecutionRecord(result.recordName) as any;
      expect(record.process.groupTerminated).toBe(true);expect(alive(-record.process.pid)).toBe(false);
      expect(alive(sentinel.pid!)).toBe(true);
    } finally {sentinel.kill('SIGTERM');await closed;}
    expect(alive(sentinel.pid!)).toBe(false);
  });
  it('blocks unconfirmed group termination and bounds handles/timers', async () => {
    const f=await setup();f.host.timeoutMs=100;
    const kill=process.kill.bind(process), start=Date.now();
    const spy=vi.spyOn(process,'kill').mockImplementation((pid,signal) => {
      if (pid<0 && signal === 0) throw Object.assign(new Error('unverifiable group'),{code:'EPERM'});
      return kill(pid,signal);
    });
    let record: any;
    try {
      const result=await f.collect();record=f.store.readExecutionRecord(result.recordName);
      expect(result.reasons).toContain('NEXT_BUILD_PROCESS_GROUP_UNCONFIRMED');
      expect(record.process.groupTerminated).toBe(false);expect(record.observation.completed).toBe(false);
      expect(f.review().verdict).toBe('BLOCKED');
      expect(Date.now()-start).toBeLessThan(4500);
    } finally {spy.mockRestore();}
    expect(alive(-record.process.pid)).toBe(false);
  },6000);
  it('requires authenticated evidence instead of a self-declared completed dependency', async () => {
    const f=await dependentSetup();delete f.host.evidenceRecords;
    await expect(f.collect()).rejects.toThrow('RELEASE_AUTHENTICATED_EVIDENCE_MISSING');
    expect(f.review().reasons).toContain('RELEASE_AUTHENTICATED_EVIDENCE_MISSING');
    expect(fs.existsSync(path.join(f.root,'.next'))).toBe(false);
  });
  it('rejects missing, arbitrary and duplicate host record references', async () => {
    const f=await dependentSetup();
    for (const names of [[`result-${randomUUID()}`],['../history.json'],[f.recordName,f.recordName]]) {
      f.host.evidenceRecords=names;
      await expect(f.collect()).rejects.toThrow();expect(f.review().verdict).toBe('BLOCKED');
    }
    expect(fs.existsSync(path.join(f.root,'.next'))).toBe(false);
  });
  it('rejects altered evidence at collection and rechecks its authentication at release', async () => {
    const f=await dependentSetup();await f.collect();
    const file=path.join(f.store.directory,f.recordName+'.json'), envelope=JSON.parse(fs.readFileSync(file,'utf8'));
    envelope.payload=JSON.stringify({...f.evidence,jobId:'ALTERED'});fs.writeFileSync(file,JSON.stringify(envelope));
    expect(f.review().reasons).toContain('EXECUTION_RECORD_INVALID');
    await expect(f.collect()).rejects.toThrow('EXECUTION_RECORD_INVALID');
  });
  it.each([
    ['missionId','OTHER-MISSION'],['assignmentId','qa'],['planHash','0'.repeat(64)],
    ['verifiedBranch','other-branch'],['verifiedBaseSha','0'.repeat(40)],
    ['evidenceReference','ARBITRARY'],['source','worker'],['status','running'],
    ['observedAt','2099-01-01T00:00:00.000Z'],['observedAt','2000-01-01T00:00:00.000Z'],['action','deploy'],
  ])('rejects authenticated but mismatched %s = %s', async (key,value) => {
    const f=await dependentSetup(), name=`result-${randomUUID()}`;
    f.store.writeExecutionRecord(name,{...f.evidence,[key]:value});f.host.evidenceRecords=[name];
    await expect(f.collect()).rejects.toThrow();expect(f.review().verdict).toBe('BLOCKED');
    expect(fs.existsSync(path.join(f.root,'.next'))).toBe(false);
  });
  it('checks approval dates for mission-only references too', async () => {
    const f=await setup(), m=f.host.mission;
    m.evidenceRefs=['QA-EVIDENCE'];
    const e: EvidenceContract={source:'assignment',jobId:'QA-JOB',action:'verify',status:'done',
      observedAt:'2000-01-01T00:00:00.000Z',verifiedBaseSha:m.baseSha,verifiedBranch:m.branch,
      evidenceReference:'QA-EVIDENCE',missionId:m.missionId,assignmentId:'qa',planHash:planHash(m)};
    const name=`result-${randomUUID()}`;f.store.writeExecutionRecord(name,e);f.host.evidenceRecords=[name];
    await expect(f.collect()).rejects.toThrow('RELEASE_EVIDENCE_APPROVAL_MISMATCH');
  });
  it.each(['prior-qa','qa'])('preserves revocation of %s even with signed done evidence', async id => {
    const f=await dependentSetup();await f.collect();
    const grant=f.store.snapshots().find(g=>g.assignmentId===id && g.decision==='approved')!;
    await revokeLocal(f.store,grant.authorizationId,accept);
    expect(f.review().reasons).toContain('NOT_APPROVED');
    await expect(f.collect()).rejects.toThrow('NOT_APPROVED');
  });
  it('preserves expiry, missing human approval and changed plans', async () => {
    const f=await dependentSetup();await f.collect();
    vi.useFakeTimers({toFake:['Date']});
    try {
      vi.setSystemTime(new Date(Date.now()+2*3600_000));
      expect(f.review().reasons).toContain('AUTHORIZATION_EXPIRED_OR_FUTURE');
      await expect(f.collect()).rejects.toThrow('AUTHORIZATION_EXPIRED_OR_FUTURE');
    } finally {vi.useRealTimers();}
    const blank=new ApprovalStore(path.join(f.parent,'unapproved'));
    blank.initialize({repositoryAliases:['LOCAL-FIXTURE'],allowedActions:['verify']});
    blank.writeExecutionRecord(f.recordName,f.evidence);f.host.storeDirectory=blank.directory;
    await expect(f.collect()).rejects.toThrow('AUTHORIZATION_MISSING_OR_AMBIGUOUS');
    f.host.storeDirectory=f.store.directory;f.host.mission.objective+=' changed';
    await expect(f.collect()).rejects.toThrow();
  });
  it('bounds a genuinely stalled Git index read without changing repository configuration', async () => {
    const f=await setup(), index=path.join(f.root,'.git/index'), backup=index+'.saved';
    const config=fs.readFileSync(path.join(f.root,'.git/config'));
    fs.renameSync(index,backup);execFileSync('/usr/bin/mkfifo',[index]);
    const start=Date.now();
    try {
      expect(()=>gitRead(f.root,'status','--porcelain')).toThrow();
      expect(Date.now()-start).toBeGreaterThanOrEqual(2900);
      expect(Date.now()-start).toBeLessThan(4500);
    } finally {fs.unlinkSync(index);fs.renameSync(backup,index);}
    expect(gitRead(f.root,'status','--porcelain')).toBe('');
    expect(fs.readFileSync(path.join(f.root,'.git/config'))).toEqual(config);
    console.log('P2-C stalled Git index read terminated within host timeout');
  },6000);
});

// Explicit opt-in fixture path supplied by this task's trusted test host. Never runs on Convergence.
it.runIf(!!process.env.AMON_NEXT_REAL_FIXTURE)('builds the explicitly authorized authentic Next fixture', async () => {
  const root=fs.realpathSync(process.env.AMON_NEXT_REAL_FIXTURE!);
  expect(root.startsWith('/private/tmp/GUARDIAN-NEXT-HOST-001/real-next-fixture')).toBe(true);
  const f=await setup(undefined,root);const r=await f.collect();const decision=f.review();
  const evidenceDir=process.env.AMON_NEXT_REAL_EVIDENCE;
  if (evidenceDir) {
    fs.mkdirSync(evidenceDir,{recursive:true,mode:0o700});
    fs.writeFileSync(path.join(evidenceDir,'real-next-build.json'),JSON.stringify(f.store.readExecutionRecord(r.recordName),null,2),{mode:0o600});
    fs.writeFileSync(path.join(evidenceDir,'real-next-decision.json'),JSON.stringify(decision,null,2),{mode:0o600});
    fs.writeFileSync(path.join(evidenceDir,'real-next-fixture.json'),JSON.stringify({root,storeDirectory:f.store.directory,recordName:r.recordName,head:gitRead(root,'rev-parse','HEAD'),
      manifestSha256:sha256(fs.readFileSync(path.join(root,'package.json'))),lockfileSha256:sha256(fs.readFileSync(path.join(root,'package-lock.json')))},null,2),{mode:0o600});
  }
  expect(r.reasons).toEqual([]);expect(decision.verdict).toBe('PASS');
},180_000);


describe('resolved Next version and declared stable range', () => {
  function manifests(range: string, version: string) {
    const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'guardian-next-range-')));roots.push(root);
    fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({dependencies:{next:range}}));
    fs.writeFileSync(path.join(root,'package-lock.json'),JSON.stringify({lockfileVersion:3,packages:{
      '':{dependencies:{next:range}},'node_modules/next':{version}}}));
    fs.mkdirSync(path.join(root,'node_modules/next'),{recursive:true});
    fs.writeFileSync(path.join(root,'node_modules/next/package.json'),JSON.stringify({name:'next',version}));
    return root;
  }
  it('review regression: rejects declared ^16.4.6 with resolved and installed 15.1.2', () => {
    const root=manifests('^16.4.6','15.1.2');
    expect(()=>inspectReleaseManifests(root)).toThrow('RELEASE_NEXT_RANGE_MISMATCH');
  });
  it.each([
    ['^15.0.0','15.1.2'],['^16.4.6','16.4.6'],['^16.4.6','16.9.0'],
    ['^0.2.5','0.2.9'],['^0.0.4','0.0.4'],['^0.0.0','0.0.0'],
    ['~15.1.2','15.1.9'],['15.1.2','15.1.2'],['=15.1.2','15.1.2'],
    ['>=15.1.2','15.1.2'],['>15.1.2','15.1.3'],['<=15.1.2','15.1.2'],['<15.1.2','15.1.1'],
    ['>=15.0.0 <16.0.0','15.1.2'],['^16.4.6 || ^15.0.0','15.1.2'],
    ['  >= 15.0.0   < 16.0.0  ','15.1.2'],['^15.0.0 >=15.1.2','15.1.2'],
    ['15.1.1 || 15.1.2','15.1.2'],['<=9007199254740991.0.0','15.1.2'],
  ])('accepts supported %s with %s', (range,version) => {
    expect(inspectReleaseManifests(manifests(range,version))).toMatchObject({stack:'next',nextVersion:version});
  });
  it.each([
    ['^15.0.0','16.0.0'],['^16.4.6','16.4.5'],['^0.2.5','0.3.0'],['^0.0.4','0.0.5'],['^0.0.0','0.0.1'],
    ['~15.1.2','15.2.0'],['~15.1.2','15.1.1'],['15.1.2','15.1.3'],['=15.1.2','15.1.1'],
    ['>15.1.2','15.1.2'],['<15.1.2','15.1.2'],['>=15.1.2','15.1.1'],['<=15.1.2','15.1.3'],
    ['>=15.0.0 <16.0.0','16.0.0'],['>=16.0.0 <15.0.0','15.1.2'],['^14.0.0 || ^16.0.0','15.1.2'],
  ])('blocks supported %s excluding %s', (range,version) => {
    expect(()=>inspectReleaseManifests(manifests(range,version))).toThrow('RELEASE_NEXT_RANGE_MISMATCH');
  });
  it.each(['','*','15','15.x','^15','^15.0','latest','v15.1.2','^15.1.2-beta.1','15.1.2+meta',
    '15.0.0 - 16.0.0','>=15.0.0, <16.0.0','!=16.0.0','^015.0.0','9007199254740992.0.0',
    '^15.0.0 || unknown','^15.0.0 ||','|| ^15.0.0','>=15.0.0<16.0.0','npm:next@15.1.2','file:../next'])
  ('blocks unsupported range %j without interpreting it optimistically', range => {
    expect(()=>inspectReleaseManifests(manifests(range,'15.1.2'))).toThrow('RELEASE_NEXT_RANGE_UNSUPPORTED');
  });
  it.each([['latest','RELEASE_NEXT_RANGE_UNSUPPORTED'],['^16.4.6','RELEASE_NEXT_RANGE_MISMATCH']])
  ('returns a clear BLOCKED diagnostic through both host paths for %s', async (range,diagnostic) => {
    const f=await setup();
    const manifest=JSON.parse(fs.readFileSync(path.join(f.root,'package.json'),'utf8'));
    const lock=JSON.parse(fs.readFileSync(path.join(f.root,'package-lock.json'),'utf8'));
    manifest.dependencies.next=range;lock.packages[''].dependencies.next=range;
    fs.writeFileSync(path.join(f.root,'package.json'),JSON.stringify(manifest));
    fs.writeFileSync(path.join(f.root,'package-lock.json'),JSON.stringify(lock));
    expect(f.review()).toMatchObject({verdict:'BLOCKED',reasons:[diagnostic]});
    await expect(f.collect()).rejects.toThrow(diagnostic);
    delete f.policy.releaseHost;delete f.policy.nextBuild;
    expect(f.review()).toMatchObject({verdict:'BLOCKED',reasons:[diagnostic]});
    expect(fs.existsSync(path.join(f.root,'.next'))).toBe(false);
  });
  it.each(['015.1.2','9007199254740992.0.0','15.1.2-beta.1','15.1.2+meta','15.1.2\n'])
  ('rejects noncanonical or unsupported resolved version %j', version => {
    expect(()=>inspectReleaseManifests(manifests('^15.0.0',version))).toThrow('RELEASE_NEXT_VERSION_INVALID');
  });
  it('reuses installed-version validation before execution even when the host dependency pin matches', async () => {
    const f=await setup();
    fs.writeFileSync(path.join(f.root,'node_modules/next/package.json'),JSON.stringify({name:'next',version:'16.4.6'}));
    f.host.dependenciesSha256=directoryDigest(path.join(f.root,'node_modules'),'dependencies');
    await expect(f.collect()).rejects.toThrow('RELEASE_INSTALLED_NEXT_MISMATCH');
    expect(fs.existsSync(path.join(f.root,'.next'))).toBe(false);
  });
  it('reuses installed-version validation when reviewing an earlier build', async () => {
    const f=await setup();await f.collect();
    fs.writeFileSync(path.join(f.root,'node_modules/next/package.json'),JSON.stringify({name:'next',version:'16.4.6'}));
    expect(f.review()).toMatchObject({verdict:'BLOCKED',reasons:['RELEASE_INSTALLED_NEXT_MISMATCH']});
  });
});
