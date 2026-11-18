import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
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
