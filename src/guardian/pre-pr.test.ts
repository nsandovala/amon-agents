import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalStore } from '../mission/approval-store';
import { approveLocal, localApproverId, revokeLocal } from '../mission/approval-host';
import { fixture } from '../mission/demo/fixtures';
import { planHash } from '../mission/contracts';
import * as releaseSource from './release-source';
import { PrePrPolicy, freezePrePrCandidate, prePrReviewPacket, recordPrePrCheck, recordPrePrReview, reviewPrePr } from './pre-pr';
vi.mock('node:child_process',async importOriginal=>{
  const original=await importOriginal<typeof import('node:child_process')>();
  return {...original,execFileSync:vi.fn(original.execFileSync)};
});
const roots:string[]=[];
const git=(root:string,...args:string[])=>execFileSync('/usr/bin/git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',root,...args],
  {encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'test@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'test@example.invalid'}}).trim();
async function setup(approve=true,dependency=false) {
  const parent=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'guardian-prepr-')));roots.push(parent);
  const root=path.join(parent,'source');fs.mkdirSync(root);fs.writeFileSync(path.join(root,'code.ts'),'original\n');
  fs.writeFileSync(path.join(root,'.gitignore'),'dist/\nignored.ts\n');
  fs.writeFileSync(path.join(root,'.env.example'),'EXAMPLE=placeholder\n');
  git(root,'init','-b','fixture/prepr');git(root,'remote','add','origin','https://example.invalid/fixture.git');git(root,'add','.');git(root,'commit','-m','Disposable fixture');
  const {m}=fixture(['qa']);m.baseSha=git(root,'rev-parse','HEAD');m.branch='fixture/prepr';m.authorizationPolicy.approverIds=[localApproverId()];
  m.assignments[0].expectedOutputs.files_to_touch=['code.ts','new.ts','ignored.ts'];
  if(dependency){
    m.assignments.push({...structuredClone(m.assignments[0]),assignmentId:'previous',status:'completed',evidenceRefs:['PREVIOUS']});
    m.assignments[0].dependencies=['previous'];
  }
  const store=new ApprovalStore(path.join(parent,'store'));store.initialize({repositoryAliases:[m.repositoryAlias],allowedActions:['verify']});
  if(approve)for(const a of m.assignments)await approveLocal(store,m,a.assignmentId,'verify',new Date(Date.now()+3600_000).toISOString(),async(_p,c)=>c); // SIMULATED approval test host only
  const policy:PrePrPolicy={root,repositoryUrl:'https://example.invalid/fixture.git',mission:m,assignmentId:'qa',storeDirectory:store.directory,
    authorId:'developer',independentReviewerIds:['test-independent'],requiredChecks:['tests']};
  if(dependency){
    const name=`result-${randomUUID()}`;
    store.writeExecutionRecord(name,{source:'assignment',jobId:'PREVIOUS-JOB',action:'verify',status:'done',observedAt:new Date().toISOString(),
      verifiedBaseSha:m.baseSha,verifiedBranch:m.branch,evidenceReference:'PREVIOUS',missionId:m.missionId,assignmentId:'previous',planHash:planHash(m)});
    policy.missionEvidenceRecords=[name];
  }
  fs.writeFileSync(path.join(root,'code.ts'),'candidate\n');
  const name=freezePrePrCandidate(policy);
  const check=()=>recordPrePrCheck(policy,name,'tests',async()=>({exitCode:0,output:'synthetic successful check'}));
  const independent=()=>recordPrePrReview(policy,name,'test-independent','independent',[]);
  const review=()=>reviewPrePr(policy,name);
  return {root,parent,store,policy,name,check,independent,review};
}
afterEach(()=>{vi.restoreAllMocks();for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
const shellQuote=(s:string)=>"'"+s.replace(/'/g,"'\\''")+"'";
// Disposable filter protocol v2: persistent across requests, exits naturally at Git EOF.
// The marker contains only PID/request metadata, never source contents.
const filterProgram=String.raw`
const fs=require('node:fs'),marker=process.argv[2],kind=process.argv[3];
const note=event=>fs.appendFileSync(marker,JSON.stringify({pid:process.pid,event})+'\n');
function exact(n){const b=Buffer.alloc(n);let at=0;while(at<n){const k=fs.readSync(0,b,at,n-at,null);if(!k)return null;at+=k;}return b;}
function packet(){const h=exact(4);if(!h)return null;const n=parseInt(h.toString(),16);return n===0?Buffer.alloc(0):exact(n-4);}
function group(){const chunks=[];for(;;){const b=packet();if(b===null)return null;if(!b.length)return chunks;chunks.push(b);}}
function send(b){b=Buffer.from(b);fs.writeSync(1,Buffer.from((b.length+4).toString(16).padStart(4,'0')));fs.writeSync(1,b);}
const flush=()=>fs.writeSync(1,'0000');
note('start');
try {
 if(kind==='clean'){note('request');fs.writeSync(1,fs.readFileSync(0));}
 else {
  group();send('git-filter-server\n');send('version=2\n');flush();
  group();send('capability=clean\n');flush();
  while(group()!==null){const content=group();if(content===null)break;note('request');
   send('status=success\n');flush();for(const b of content)send(b);flush();flush();}
 }
} finally {note('closed');}
`;
async function filterFixture(kind:'clean'|'process') {
  const f=await setup(false),marker=path.join(f.parent,'filter-marker.jsonl'),script=path.join(f.parent,'fixture-filter.cjs');
  fs.writeFileSync(script,filterProgram);
  fs.writeFileSync(path.join(f.root,'second.ts'),'second original\n');
  fs.writeFileSync(path.join(f.root,'.gitattributes'),'*.ts filter=canary\n');
  git(f.root,'add','second.ts','.gitattributes');git(f.root,'commit','-m','Disposable filter attributes');
  f.policy.mission.baseSha=git(f.root,'rev-parse','HEAD');f.policy.mission.assignments[0].expectedOutputs.files_to_touch.push('second.ts','.gitattributes');
  fs.writeFileSync(path.join(f.root,'second.ts'),'second changed\n');
  const command=[process.execPath,script,marker,kind].map(shellQuote).join(' ');
  git(f.root,'config','filter.canary.'+kind,command);git(f.root,'config','filter.canary.required','true');
  return {...f,marker,command};
}
async function filterExited(marker:string) {
  if(!fs.existsSync(marker))return [];
  const rows=fs.readFileSync(marker,'utf8').trim().split('\n').map(s=>JSON.parse(s) as {pid:number;event:string});
  for(const pid of new Set(rows.map(r=>r.pid))){
    let alive=true;
    for(let i=0;i<100&&alive;i++){try{process.kill(pid,0);await new Promise(r=>setTimeout(r,10));}catch(e){if((e as NodeJS.ErrnoException).code!=='ESRCH')throw e;alive=false;}}
    expect(alive,'fixture filter '+pid+' must exit at EOF without termination').toBe(false);
    expect(rows.some(r=>r.pid===pid&&r.event==='closed')).toBe(true);
  }
  return rows;
}
describe('PR16 security regressions (disposable filters and masked index)',()=>{
  it.each(['clean','process'] as const)('P1 RED/GREEN: blocks %s before inspection even without authorization',async kind=>{
    const f=await filterFixture(kind);
    // Positive exploit control: the exact legacy inspection invokes both filter variants.
    releaseSource.gitReadRaw(f.root,'diff','--no-ext-diff','--no-textconv','--no-renames','--name-only','-z','--');
    const control=await filterExited(f.marker);expect(control.filter(r=>r.event==='request').length).toBeGreaterThanOrEqual(2);
    if(kind==='process')expect(new Set(control.map(r=>r.pid)).size).toBe(1);
    fs.unlinkSync(f.marker);
    const before=fs.readdirSync(f.store.directory).sort();let denial:string|undefined;
    try{freezePrePrCandidate(f.policy);}catch(e){denial=(e as Error).message;}
    await filterExited(f.marker);
    expect({denial,executed:fs.existsSync(f.marker)}).toEqual({denial:'PREPR_GIT_FILTER_UNSAFE',executed:false});
    expect(fs.readdirSync(f.store.directory).sort()).toEqual(before);
  });
  it.each(['assume-unchanged','skip-worktree'])('P2 RED/GREEN: rejects %s before trusting the allowlist',async flag=>{
    const f=await setup(false);fs.writeFileSync(path.join(f.root,'hidden.ts'),'original\n');
    git(f.root,'add','hidden.ts');git(f.root,'commit','-m','Disposable hidden file');
    f.policy.mission.baseSha=git(f.root,'rev-parse','HEAD');
    git(f.root,'update-index','--'+flag,'hidden.ts');fs.writeFileSync(path.join(f.root,'hidden.ts'),'unauthorized modification\n');
    expect(releaseSource.gitReadRaw(f.root,'diff','--name-only','--')).toContain('code.ts');
    expect(releaseSource.gitReadRaw(f.root,'diff','--name-only','--')).not.toContain('hidden.ts');
    const indexBefore=fs.readFileSync(path.join(f.root,'.git','index')),before=fs.readdirSync(f.store.directory).sort();
    let denial:string|undefined,omitted=false;
    try{const name=freezePrePrCandidate(f.policy);omitted=!prePrReviewPacket(f.policy,name).changedFiles.includes('hidden.ts');}catch(e){denial=(e as Error).message;}
    expect({denial,omitted}).toEqual({denial:'PREPR_INDEX_FLAGS_UNSAFE',omitted:false});
    expect(fs.readdirSync(f.store.directory).sort()).toEqual(before);
    expect(fs.readFileSync(path.join(f.root,'.git','index'))).toEqual(indexBefore);
  });
  it.each(['include','recursive','onbranch','gitdir','worktree'])('blocks executable filters from effective %s configuration',async source=>{
    const f=await filterFixture('process'),config=path.join(f.root,'.git','config'),included=path.join(f.parent,'included.config');
    fs.writeFileSync(included,'[filter "canary"]\n\tprocess = '+JSON.stringify(f.command)+'\n');
    git(f.root,'config','--remove-section','filter.canary');
    if(source==='include')git(f.root,'config','include.path',included);
    if(source==='recursive'){
      const first=path.join(f.parent,'first.config');fs.writeFileSync(first,'[include]\n\tpath = included.config\n');
      git(f.root,'config','include.path',first);
    }
    if(source==='onbranch')git(f.root,'config','includeIf.onbranch:fixture/*.path',included);
    if(source==='gitdir')git(f.root,'config','includeIf.gitdir:'+f.root+'/.git.path',included);
    if(source==='worktree'){
      git(f.root,'config','extensions.worktreeConfig','true');
      fs.copyFileSync(included,path.join(f.root,'.git','config.worktree'));
    }
    const configBefore=fs.readFileSync(config),includeBefore=fs.readFileSync(included),read=vi.spyOn(releaseSource,'gitReadRaw');
    expect(()=>freezePrePrCandidate(f.policy)).toThrow('PREPR_GIT_FILTER_UNSAFE');
    expect(read.mock.calls.some(a=>a.includes('status')||a.includes('diff'))).toBe(false);
    expect(fs.existsSync(f.marker)).toBe(false);
    expect(fs.readFileSync(config)).toEqual(configBefore);expect(fs.readFileSync(included)).toEqual(includeBefore);
  });
  it.each(['nested','info','external'])('blocks filters selected by %s attributes without executing them',async source=>{
    const f=await filterFixture('clean');fs.writeFileSync(path.join(f.root,'.gitattributes'),'# no root selection\n');
    let attributes:string,target='code.ts';
    if(source==='nested'){
      fs.mkdirSync(path.join(f.root,'nested'));target='nested/code.ts';fs.writeFileSync(path.join(f.root,target),'nested\n');
      attributes=path.join(f.root,'nested/.gitattributes');
    }else if(source==='info')attributes=path.join(f.root,'.git/info/attributes');
    else{attributes=path.join(f.parent,'attributes');git(f.root,'config','core.attributesFile',attributes);}
    fs.writeFileSync(attributes,'*.ts filter=canary\n');
    expect(git(f.root,'check-attr','filter','--',target)).toContain(': filter: canary');
    const before=fs.readFileSync(attributes);
    expect(()=>freezePrePrCandidate(f.policy)).toThrow('PREPR_GIT_FILTER_UNSAFE');
    expect(fs.existsSync(f.marker)).toBe(false);expect(fs.readFileSync(attributes)).toEqual(before);
  });
  it('rejects unused and empty executable driver declarations conservatively',async()=>{
    const f=await setup(false);
    git(f.root,'config','filter.unused.smudge','');
    expect(()=>freezePrePrCandidate(f.policy)).toThrow('PREPR_GIT_FILTER_UNSAFE');
  });
  it.each(['malformed','cycle'])('fails closed when %s configuration cannot be inspected',async kind=>{
    const f=await setup(false),config=path.join(f.root,'.git','config');
    if(kind==='malformed')fs.appendFileSync(config,'\n[unterminated');
    else git(f.root,'config','include.path','config');
    expect(()=>freezePrePrCandidate(f.policy)).toThrow('PREPR_GIT_FILTER_UNSAFE');
  });
  it.each(['ETIMEDOUT','ENOBUFS','EACCES'])('blocks failed config inspection (%s) with bounded host Git options',async code=>{
    const f=await setup(false),run=vi.mocked(execFileSync);
    run.mockClear();run.mockImplementationOnce(()=>{throw Object.assign(new Error('private detail'),{code});});
    expect(()=>freezePrePrCandidate(f.policy)).toThrow('PREPR_GIT_FILTER_UNSAFE');
    expect(run.mock.calls[0][1]).toEqual(expect.arrayContaining(['core.fsmonitor=false','core.hooksPath=/dev/null','config','--includes','--null','--name-only']));
    expect(run.mock.calls[0][2]).toMatchObject({timeout:3000,killSignal:'SIGKILL',maxBuffer:1024*1024,env:{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_OPTIONAL_LOCKS:'0'}});
    expect(run).toHaveBeenCalledTimes(1);
  });
  it.each(['assume-unchanged','skip-worktree'])('blocks a later %s flag without changing the index or issuing a packet/check',async flag=>{
    const f=await setup(false),before=fs.readdirSync(f.store.directory).sort(),execute=vi.fn(async()=>({exitCode:0,output:'must not run'}));
    git(f.root,'update-index','--'+flag,'.env.example');
    const index=fs.readFileSync(path.join(f.root,'.git','index')),read=vi.spyOn(releaseSource,'gitReadRaw');
    expect(()=>prePrReviewPacket(f.policy,f.name)).toThrow('PREPR_INDEX_FLAGS_UNSAFE');
    await expect(recordPrePrCheck(f.policy,f.name,'tests',execute)).rejects.toThrow('PREPR_INDEX_FLAGS_UNSAFE');
    expect(f.review()).toMatchObject({adversarialStatus:'NOT_REVIEWED',review:{verdict:'BLOCKED'}});
    expect(read.mock.calls.some(a=>a.includes('status')||a.includes('diff'))).toBe(false);
    expect(execute).not.toHaveBeenCalled();expect(fs.readdirSync(f.store.directory).sort()).toEqual(before);
    expect(fs.readFileSync(path.join(f.root,'.git','index'))).toEqual(index);
  });
  it('rechecks configuration after freezing, before exporting or invoking an unauthorized callback',async()=>{
    const f=await setup(false),marker=path.join(f.parent,'late-filter'),execute=vi.fn(async()=>({exitCode:0,output:'must not run'}));
    fs.writeFileSync(path.join(f.root,'.git/info/attributes'),'*.ts filter=late\n');
    git(f.root,'config','filter.late.clean','printf invoked > '+shellQuote(marker)+'; cat');
    const config=fs.readFileSync(path.join(f.root,'.git/config')),before=fs.readdirSync(f.store.directory).sort();
    expect(()=>prePrReviewPacket(f.policy,f.name)).toThrow('PREPR_GIT_FILTER_UNSAFE');
    await expect(recordPrePrCheck(f.policy,f.name,'tests',execute)).rejects.toThrow('PREPR_GIT_FILTER_UNSAFE');
    expect(f.review()).toMatchObject({adversarialStatus:'NOT_REVIEWED',review:{verdict:'BLOCKED'}});
    expect(execute).not.toHaveBeenCalled();expect(fs.existsSync(marker)).toBe(false);
    expect(fs.readdirSync(f.store.directory).sort()).toEqual(before);expect(fs.readFileSync(path.join(f.root,'.git/config'))).toEqual(config);
  });
  it('rejects submodules before status could inspect nested filter configuration',async()=>{
    const f=await setup(false);git(f.root,'update-index','--add','--cacheinfo','160000,'+f.policy.mission.baseSha+',new.ts');
    const read=vi.spyOn(releaseSource,'gitReadRaw');expect(()=>freezePrePrCandidate(f.policy)).toThrow('PREPR_SUBMODULE_UNSUPPORTED');
    expect(read.mock.calls.some(a=>a.includes('status')||a.includes('diff'))).toBe(false);
  });
  it('keeps ordinary inspection available and suppresses repository fsmonitor/hooks without configuration edits',async()=>{
    const f=await setup(false),marker=path.join(f.parent,'hook-marker'),script=path.join(f.parent,'hook.sh');
    fs.writeFileSync(script,'#!/bin/sh\nprintf invoked > '+shellQuote(marker)+'\n',{mode:0o700});
    git(f.root,'config','core.fsmonitor',script);git(f.root,'config','core.hooksPath',f.parent);
    fs.copyFileSync(script,path.join(f.parent,'post-index-change'));
    const config=fs.readFileSync(path.join(f.root,'.git/config')),index=fs.readFileSync(path.join(f.root,'.git/index'));
    const name=freezePrePrCandidate(f.policy),packet=prePrReviewPacket(f.policy,name);
    expect(packet.changedFiles).toContain('code.ts');expect(packet.diff.unstaged).toContain('+candidate');
    expect(fs.existsSync(marker)).toBe(false);expect(fs.readFileSync(path.join(f.root,'.git/config'))).toEqual(config);
    expect(fs.readFileSync(path.join(f.root,'.git/index'))).toEqual(index);
    expect(reviewPrePr(f.policy,name)).toMatchObject({adversarialStatus:'NOT_REVIEWED',publicationAuthorized:false});
  });
});
async function partialFixture() {
  const f=await setup(false),remote=path.join(f.parent,'remote.git'),clone=path.join(f.parent,'partial');
  git(f.parent,'clone','--bare','--no-local',f.root,remote);git(remote,'config','uploadpack.allowFilter','true');
  git(f.parent,'clone','--filter=blob:none','--no-checkout','file://'+remote,clone);
  git(clone,'read-tree','HEAD'); // Populate only index metadata; do not fetch blob contents.
  for(const file of ['code.ts','.gitignore','.env.example'])fs.copyFileSync(path.join(f.root,file),path.join(clone,file));
  const marker=path.join(f.parent,'transport-marker.jsonl'),script=path.join(f.parent,'fixture-transport.cjs');
  fs.writeFileSync(script,"const fs=require('node:fs');fs.appendFileSync(process.argv[2],JSON.stringify({pid:process.pid,event:'closed'})+'\\n');process.exit(1);");
  git(clone,'config','remote.origin.uploadpack',[process.execPath,script,marker].map(shellQuote).join(' '));
  f.policy.root=clone;f.policy.repositoryUrl='file://'+remote;
  return {...f,root:clone,marker};
}
describe('trust boundary closure regressions',()=>{
  it('TRUST RED/GREEN: rejects a partial clone before lazy transport execution',async()=>{
    const f=await partialFixture();
    // Deliberately unprotected legacy control; local file transport only, no network.
    expect(()=>git(f.root,'diff','--no-ext-diff','--no-textconv','--no-renames','--name-only','-z','--')).toThrow();
    expect((await filterExited(f.marker)).length).toBeGreaterThan(0);fs.unlinkSync(f.marker);
    const before=fs.readdirSync(f.store.directory).sort();let denial:string|undefined;
    try{freezePrePrCandidate(f.policy);}catch(e){denial=(e as Error).message;}
    await filterExited(f.marker);
    expect({denial,executed:fs.existsSync(f.marker)}).toEqual({denial:'PREPR_PARTIAL_CLONE_UNSUPPORTED',executed:false});
    expect(fs.readdirSync(f.store.directory).sort()).toEqual(before);
  });
  it.each(['filemode','eol'])('TRUST RED/GREEN: reconciles hidden %s changes before scope',async kind=>{
    const f=await setup(false),file=path.join(f.root,'hidden.sh');
    fs.writeFileSync(file,'#!/bin/sh\nexit 0\n');fs.writeFileSync(path.join(f.root,'.gitattributes'),'hidden.sh text eol=lf\n');
    git(f.root,'add','hidden.sh','.gitattributes');git(f.root,'commit','-m','Disposable raw comparison fixture');
    f.policy.mission.baseSha=git(f.root,'rev-parse','HEAD');
    if(kind==='filemode'){git(f.root,'config','core.filemode','false');fs.chmodSync(file,0o755);}
    else fs.writeFileSync(file,'#!/bin/sh\r\nexit 0\r\n');
    expect(git(f.root,'ls-files','-v','hidden.sh')).toBe('H hidden.sh');
    expect(git(f.root,'diff','--name-only')).not.toContain('hidden.sh');
    let denial:string|undefined,omitted=false;
    try{const name=freezePrePrCandidate(f.policy);omitted=!prePrReviewPacket(f.policy,name).changedFiles.includes('hidden.sh');}catch(e){denial=(e as Error).message;}
    expect({denial,omitted}).toEqual({denial:'PREPR_OUT_OF_SCOPE',omitted:false});
  });
  it('denies lazy fetch in the reader itself even when bypassing the Pre-PR precheck',async()=>{
    const f=await partialFixture(),before=releaseSource.directoryDigest(path.join(f.root,'.git'),'artifact');
    const run=vi.mocked(execFileSync);run.mockClear();
    expect(()=>releaseSource.gitReadRaw(f.root,'diff','--no-ext-diff','--no-textconv','--no-renames','--name-only','-z','--')).toThrow();
    expect(fs.existsSync(f.marker)).toBe(false);
    expect(releaseSource.directoryDigest(path.join(f.root,'.git'),'artifact')).toBe(before);
    expect(run.mock.calls.every(c=>(c[2] as any).env.GIT_NO_LAZY_FETCH==='1' && (c[2] as any).env.GIT_ALLOW_PROTOCOL==='')).toBe(true);
  });
  it.each(['extensions.partialclone','remote.other.promisor','remote.other.partialclonefilter'])('rejects unsupported %s declarations before object access',async key=>{
    const f=await setup(false);git(f.root,'config',key,key.endsWith('promisor')?'false':'origin');
    const run=vi.mocked(execFileSync);run.mockClear();
    expect(()=>freezePrePrCandidate(f.policy)).toThrow('PREPR_PARTIAL_CLONE_UNSUPPORTED');
    expect(run.mock.calls.some(c=>c[1]?.some(a=>['merge-base','status','diff','cat-file'].includes(a)))).toBe(false);
  });
  it('detects promisor settings in effective includes',async()=>{
    const f=await setup(false),config=path.join(f.parent,'promisor.config');
    fs.writeFileSync(config,'[remote "other"]\n promisor = true\n');git(f.root,'config','include.path',config);
    expect(()=>freezePrePrCandidate(f.policy)).toThrow('PREPR_PARTIAL_CLONE_UNSUPPORTED');
  });
  it('blocks a missing unchanged index blob without recovery or store writes',async()=>{
    const f=await setup(false),oid=git(f.root,'rev-parse','HEAD:.env.example');
    const object=path.join(f.root,'.git/objects',oid.slice(0,2),oid.slice(2));fs.unlinkSync(object); // Disposable fixture ONLY.
    const before=fs.readdirSync(f.store.directory).sort(),objects=releaseSource.directoryDigest(path.join(f.root,'.git/objects'),'artifact');
    expect(()=>freezePrePrCandidate(f.policy)).toThrow('PREPR_OBJECT_UNAVAILABLE');
    expect(fs.existsSync(object)).toBe(false);expect(releaseSource.directoryDigest(path.join(f.root,'.git/objects'),'artifact')).toBe(objects);
    expect(fs.readdirSync(f.store.directory).sort()).toEqual(before);
  });
  it('rejects unsupported object formats before reading candidate objects',async()=>{
    const f=await setup(false),root=path.join(f.parent,'sha256');fs.mkdirSync(root);git(root,'init','--object-format=sha256');
    f.policy.root=root;expect(()=>freezePrePrCandidate(f.policy)).toThrow('PREPR_OBJECT_FORMAT_UNSUPPORTED');
  });
  it.each(['filemode','eol'])('retains exact preimage/current bytes for an authorized hidden %s change',async kind=>{
    const f=await setup(false),file=path.join(f.root,'new.ts');
    fs.writeFileSync(file,'#!/bin/sh\nexit 0\n');fs.writeFileSync(path.join(f.root,'.gitattributes'),'new.ts text eol=lf\n');
    git(f.root,'add','new.ts','.gitattributes');git(f.root,'commit','-m','Disposable allowed raw change');f.policy.mission.baseSha=git(f.root,'rev-parse','HEAD');
    if(kind==='filemode'){git(f.root,'config','core.filemode','false');fs.chmodSync(file,0o755);}
    else fs.writeFileSync(file,'#!/bin/sh\r\nexit 0\r\n');
    expect(git(f.root,'diff','--name-only')).not.toContain('new.ts');
    const name=freezePrePrCandidate(f.policy),packet=prePrReviewPacket(f.policy,name);
    expect(packet.changedFiles).toContain('new.ts');
    const raw=packet.rawWorktreeChanges.find(e=>e.path==='new.ts')!;
    expect(raw.indexMode).toBe('100644');expect(raw.indexOid).toBe(git(f.root,'rev-parse',':new.ts'));
    expect(Buffer.from(raw.indexContentBase64,'base64').toString()).toBe('#!/bin/sh\nexit 0\n');
    const current=packet.files.find(e=>e.path==='new.ts')!;
    expect(Buffer.from(current.contentBase64!,'base64')).toEqual(fs.readFileSync(file));expect(current.mode).toBe(kind==='filemode'?0o755:0o644);
    expect(reviewPrePr(f.policy,name)).toMatchObject({adversarialStatus:'NOT_REVIEWED',publicationAuthorized:false});
    fs.appendFileSync(file,'later\n');expect(()=>prePrReviewPacket(f.policy,name)).toThrow('PREPR_CONTENT_CHANGED');
  });
  it('reconciles the staged preimage rather than HEAD and retains physical CRLF bytes',async()=>{
    const f=await setup(false);fs.writeFileSync(path.join(f.root,'.git/info/attributes'),'code.ts text eol=lf\n');
    fs.writeFileSync(path.join(f.root,'code.ts'),'staged\r\n');git(f.root,'add','code.ts');
    fs.appendFileSync(path.join(f.root,'code.ts'),'unstaged\r\n');
    const packet=prePrReviewPacket(f.policy,freezePrePrCandidate(f.policy));
    expect(packet.diff.staged).toContain('+staged');expect(packet.diff.unstaged).toContain('+unstaged');
    expect(Buffer.from(packet.rawWorktreeChanges.find(e=>e.path==='code.ts')!.indexContentBase64,'base64').toString()).toBe('staged\n');
    expect(Buffer.from(packet.files.find(e=>e.path==='code.ts')!.contentBase64!,'base64').toString()).toBe('staged\r\nunstaged\r\n');
  });
  it.each([0o600,0o1644])('does not ignore physical permission bits %i outside scope',async mode=>{
    const f=await setup(false);git(f.root,'config','core.filemode','false');fs.chmodSync(path.join(f.root,'.env.example'),mode);
    expect(()=>freezePrePrCandidate(f.policy)).toThrow('PREPR_OUT_OF_SCOPE');
  });
  it.each(['autocrlf','ident','encoding'])('detects raw differences hidden by %s conversion',async kind=>{
    const f=await setup(false),file=path.join(f.root,'hidden.txt'),original=kind==='ident'?'$Id$\n':'plain text\n';
    fs.writeFileSync(file,original);git(f.root,'add','hidden.txt');git(f.root,'commit','-m','Disposable normalization fixture');
    f.policy.mission.baseSha=git(f.root,'rev-parse','HEAD');
    if(kind==='autocrlf'){git(f.root,'config','core.autocrlf','true');fs.writeFileSync(file,'plain text\r\n');}
    if(kind==='ident'){fs.writeFileSync(path.join(f.root,'.git/info/attributes'),'hidden.txt ident\n');fs.writeFileSync(file,'$Id: synthetic $\n');}
    if(kind==='encoding'){fs.writeFileSync(path.join(f.root,'.git/info/attributes'),'hidden.txt working-tree-encoding=UTF-16LE\n');fs.writeFileSync(file,Buffer.from(original,'utf16le'));}
    expect(git(f.root,'diff','--name-only')).not.toContain('hidden.txt');
    expect(()=>freezePrePrCandidate(f.policy)).toThrow('PREPR_OUT_OF_SCOPE');
  });
  it('captures symlink targets as raw blobs and detects a link replaced by a regular stub',async()=>{
    const f=await setup(false);fs.symlinkSync('code.ts',path.join(f.root,'new.ts'));
    git(f.root,'add','new.ts');git(f.root,'commit','-m','Disposable indexed link');f.policy.mission.baseSha=git(f.root,'rev-parse','HEAD');
    git(f.root,'config','core.symlinks','false');fs.unlinkSync(path.join(f.root,'new.ts'));fs.writeFileSync(path.join(f.root,'new.ts'),'code.ts');
    const packet=prePrReviewPacket(f.policy,freezePrePrCandidate(f.policy));
    expect(packet.rawWorktreeChanges.find(e=>e.path==='new.ts')).toMatchObject({indexMode:'120000',indexContentBase64:Buffer.from('code.ts').toString('base64')});
    expect(packet.files.find(e=>e.path==='new.ts')).toMatchObject({kind:'file',contentBase64:Buffer.from('code.ts').toString('base64')});
  });
  it('keeps a deleted tracked file and its exact preimage in the frozen packet',async()=>{
    const f=await setup(false);fs.unlinkSync(path.join(f.root,'code.ts'));
    const packet=prePrReviewPacket(f.policy,freezePrePrCandidate(f.policy));
    expect(packet.changedFiles).toContain('code.ts');expect(packet.files.some(e=>e.path==='code.ts')).toBe(false);
    expect(Buffer.from(packet.rawWorktreeChanges.find(e=>e.path==='code.ts')!.indexContentBase64,'base64').toString()).toBe('original\n');
    expect(packet.diff.unstaged).toContain('deleted file mode');
  });
  it('does not omit an out-of-scope empty intent-to-add file',async()=>{
    const f=await setup(false);fs.writeFileSync(path.join(f.root,'outside'),'');git(f.root,'add','--intent-to-add','outside');
    expect(()=>freezePrePrCandidate(f.policy)).toThrow('PREPR_OUT_OF_SCOPE');
  });
  it('retains binary preimages and rejects tampering with the new raw evidence',async()=>{
    const f=await setup(false),before=Buffer.from([0,128,10,2]),after=Buffer.from([0,255,10,1]);
    fs.writeFileSync(path.join(f.root,'code.ts'),before);git(f.root,'add','code.ts');git(f.root,'commit','-m','Disposable binary source');f.policy.mission.baseSha=git(f.root,'rev-parse','HEAD');
    fs.writeFileSync(path.join(f.root,'code.ts'),after);const name=freezePrePrCandidate(f.policy),packet=prePrReviewPacket(f.policy,name);
    expect(Buffer.from(packet.rawWorktreeChanges[0].indexContentBase64,'base64')).toEqual(before);
    expect(Buffer.from(packet.files.find(e=>e.path==='code.ts')!.contentBase64!,'base64')).toEqual(after);
    const file=path.join(f.store.directory,name+'.json'),envelope=JSON.parse(fs.readFileSync(file,'utf8')),record=JSON.parse(envelope.payload);
    record.content.rawWorktreeChanges[0].indexContentBase64='';envelope.payload=JSON.stringify(record);fs.writeFileSync(file,JSON.stringify(envelope));
    expect(()=>prePrReviewPacket(f.policy,name)).toThrow('EXECUTION_RECORD_INVALID');
  });
  it('does not export replacement objects instead of the indexed preimage',async()=>{
    const f=await setup(false),original=git(f.root,'rev-parse',':code.ts');
    fs.writeFileSync(path.join(f.parent,'replacement'),'fake preimage\n');
    const replacement=git(f.root,'hash-object','-w',path.join(f.parent,'replacement'));git(f.root,'replace',original,replacement);
    const packet=prePrReviewPacket(f.policy,freezePrePrCandidate(f.policy));
    expect(Buffer.from(packet.rawWorktreeChanges.find(e=>e.path==='code.ts')!.indexContentBase64,'base64').toString()).toBe('original\n');
  });
  it('blocks excessive raw preimage output explicitly without partial evidence',async()=>{
    const f=await setup(false);fs.writeFileSync(path.join(f.root,'new.ts'),'x'.repeat(1100*1024));git(f.root,'add','new.ts');git(f.root,'commit','-m','Disposable large preimage');
    f.policy.mission.baseSha=git(f.root,'rev-parse','HEAD');fs.chmodSync(path.join(f.root,'new.ts'),0o755);
    const before=fs.readdirSync(f.store.directory).sort();expect(()=>freezePrePrCandidate(f.policy)).toThrow('PREPR_OBJECT_OUTPUT_TOO_LARGE');
    expect(fs.readdirSync(f.store.directory).sort()).toEqual(before);
  });
});
describe('existing Guardian pre-PR composition (synthetic principals; no independent review of this implementation)',()=>{
  it('blocks the callback before execution when stored authorization is missing',async()=>{
    const f=await setup(false),execute=vi.fn(async()=>({exitCode:0,output:'must not run'}));
    const outcome=await recordPrePrCheck(f.policy,f.name,'tests',execute).then(()=> 'executed',e=>e.message);
    expect(execute).not.toHaveBeenCalled();
    expect(outcome).toBe('AUTHORIZATION_MISSING_OR_AMBIGUOUS');
    expect(fs.readdirSync(f.store.directory).filter(n=>/^(attempt|result)-/.test(n))).toEqual([]);
  });
  it.each(['revoked','expired'])('does not invoke the callback with %s approval',async state=>{
    const f=await setup(),execute=vi.fn(async()=>({exitCode:0,output:'must not run'}));
    if(state==='revoked')await revokeLocal(f.store,f.store.snapshots()[0].authorizationId,async(_p,c)=>c);
    const clock=()=>new Date(Date.now()+(state==='expired'?7200_000:0));
    await expect(recordPrePrCheck(f.policy,f.name,'tests',execute,clock)).rejects.toThrow(state==='revoked'?'NOT_APPROVED':'AUTHORIZATION_EXPIRED_OR_FUTURE');
    expect(execute).not.toHaveBeenCalled();
    expect(fs.readdirSync(f.store.directory).filter(n=>/^(attempt|result)-/.test(n))).toEqual([]);
  });
  it.each(['incomplete','missing','foreign','altered','valid'])('requires authenticated dependency evidence before invoking the callback: %s',async state=>{
    const f=await setup(true,true),execute=vi.fn(async()=>({exitCode:0,output:'authorized dependency fixture'}));
    const record=f.policy.missionEvidenceRecords![0];
    if(state==='incomplete')f.policy.mission.assignments[1].status='planned';
    if(state==='missing')f.policy.missionEvidenceRecords=[];
    if(state==='foreign'){
      const e=f.store.readExecutionRecord(record) as any,name=`result-${randomUUID()}`;
      f.store.writeExecutionRecord(name,{...e,missionId:'OTHER-MISSION'});f.policy.missionEvidenceRecords=[name];
    }
    if(state==='altered'){
      const file=path.join(f.store.directory,record+'.json'),envelope=JSON.parse(fs.readFileSync(file,'utf8'));
      envelope.mac='0'.repeat(64);fs.writeFileSync(file,JSON.stringify(envelope));
    }
    const name=freezePrePrCandidate(f.policy),run=recordPrePrCheck(f.policy,name,'tests',execute);
    if(state==='valid'){
      await run;expect(execute).toHaveBeenCalledOnce();recordPrePrReview(f.policy,name,'test-independent','independent',[]);
      expect(reviewPrePr(f.policy,name).review.verdict).toBe('PASS');
    }else{
      const codes:Record<string,string>={incomplete:'DEPENDENCY_INCOMPLETE',missing:'INVALID_EVIDENCE_REFERENCE',foreign:'PREPR_MISSION_EVIDENCE_INVALID',altered:'EXECUTION_RECORD_INVALID'};
      await expect(run).rejects.toThrow(codes[state]);expect(execute).not.toHaveBeenCalled();
      expect(fs.readdirSync(f.store.directory).filter(n=>n.startsWith('attempt-'))).toEqual([]);
    }
  });
  it('keeps read-only candidate inspection available without an approval',async()=>{
    const f=await setup(false);
    expect(prePrReviewPacket(f.policy,f.name).changedFiles).toEqual(['code.ts']);
    expect(f.store.history()).toEqual([]);
  });
  it.each(['revocation','expiry','replacement'])('leaves an unfinished attempt if %s occurs during a check',async state=>{
    const f=await setup();let now=new Date();
    const execute=vi.fn(async()=>{
      if(state==='expiry')now=new Date(Date.now()+7200_000);
      else {
        await revokeLocal(f.store,f.store.snapshots()[0].authorizationId,async(_p,c)=>c);
        if(state==='replacement')await approveLocal(f.store,f.policy.mission,'qa','verify',new Date(Date.now()+3600_000).toISOString(),async(_p,c)=>c);
      }
      return {exitCode:0,output:'authorization changed during check'};
    });
    await expect(recordPrePrCheck(f.policy,f.name,'tests',execute,()=>state==='expiry'?now:new Date())).rejects.toThrow();
    expect(execute).toHaveBeenCalledOnce();
    const records=fs.readdirSync(f.store.directory);expect(records.filter(n=>n.startsWith('attempt-'))).toHaveLength(1);
    expect(records.filter(n=>n.startsWith('result-'))).toHaveLength(0);
    if(state==='revocation')await approveLocal(f.store,f.policy.mission,'qa','verify',new Date(Date.now()+3600_000).toISOString(),async(_p,c)=>c);
    // Later success/renewal cannot erase an incomplete, previously started execution.
    if(state!=='expiry'){await f.check();f.independent();expect(f.review().review.findings.map(f=>f.code)).toContain('PREPR_CHECK_UNFINISHED');}
  });
  it('rejects legacy unbound receipts after a late approval and a later successful check',async()=>{
    const f=await setup(false),id=randomUUID(),at=new Date().toISOString(),candidateId=prePrReviewPacket(f.policy,f.name).candidateId;
    // Controlled legacy receipt: the old implementation could execute without a grant.
    f.store.writeExecutionRecord(`attempt-${id}`,{kind:'guardian-prepr-attempt/1',candidateId,checkId:'tests',startedAt:at});
    f.store.writeExecutionRecord(`result-${id}`,{kind:'guardian-prepr-check/1',candidateId,checkId:'tests',startedAt:at,finishedAt:at,exitCode:0,outputSha256:'0'.repeat(64),
      evidence:{source:'assignment',jobId:`result-${id}`,action:'verify',status:'done',observedAt:at,verifiedBaseSha:f.policy.mission.baseSha,verifiedBranch:f.policy.mission.branch,
        evidenceReference:`result-${id}`,missionId:f.policy.mission.missionId,assignmentId:'qa',planHash:planHash(f.policy.mission)}});
    await approveLocal(f.store,f.policy.mission,'qa','verify',new Date(Date.now()+3600_000).toISOString(),async(_p,c)=>c);
    await f.check();f.independent();expect(f.review().review.findings.map(f=>f.code)).toContain('PREPR_CHECK_AUTHORIZATION_INVALID');
  });
  it('does not let a developer review substitute for independent review',async()=>{
    const f=await setup();await f.check();recordPrePrReview(f.policy,f.name,'developer','developer',[]);
    expect(f.review()).toMatchObject({adversarialStatus:'NOT_REVIEWED',publicationAuthorized:false,review:{verdict:'HUMAN_REVIEW'}});
  });
  it('produces PASS only for a fully evidenced authorized fixture, never publication permission',async()=>{
    const f=await setup();await f.check();f.independent();
    expect(f.review()).toMatchObject({adversarialStatus:'REVIEWED',publicationAuthorized:false,review:{verdict:'PASS'}});
  });
  it.each(['unstaged','staged','untracked','ignored','mode','head','branch','deleted'])('invalidates a reviewed candidate after %s changes',async change=>{
    const f=await setup();await f.check();f.independent();
    if(change==='deleted')fs.unlinkSync(path.join(f.root,'code.ts'));
    if(change==='unstaged')fs.appendFileSync(path.join(f.root,'code.ts'),'later');
    if(change==='staged')git(f.root,'add','code.ts');
    if(change==='untracked')fs.writeFileSync(path.join(f.root,'new.ts'),'new');
    if(change==='ignored')fs.writeFileSync(path.join(f.root,'ignored.ts'),'new');
    if(change==='mode')fs.chmodSync(path.join(f.root,'code.ts'),0o755);
    if(change==='head')git(f.root,'commit','--allow-empty','-m','Disposable changed head');
    if(change==='branch')git(f.root,'switch','-c','fixture/other');
    expect(f.review().review.verdict).toBe('BLOCKED');
  });
  it('freezes staged, unstaged and untracked bytes independently of HEAD',async()=>{
    const f=await setup();git(f.root,'add','code.ts');fs.appendFileSync(path.join(f.root,'code.ts'),'unstaged\n');
    fs.writeFileSync(path.join(f.root,'new.ts'),'new file\n');
    const name=freezePrePrCandidate(f.policy),packet=prePrReviewPacket(f.policy,name);
    expect(packet.diff.staged).toContain('+candidate');expect(packet.diff.unstaged).toContain('+unstaged');
    expect(packet.files.find(f=>f.path==='new.ts')?.contentBase64).toBe(Buffer.from('new file\n').toString('base64'));
    packet.criteria.files_to_touch.push('unauthorized');packet.diff.staged='forged';
    expect(prePrReviewPacket(f.policy,name).diff.staged).not.toBe('forged');
    expect(prePrReviewPacket(f.policy,name).criteria.files_to_touch).not.toContain('unauthorized');
  });
  it('invalidates evidence if code changes during the deterministic check',async()=>{
    const f=await setup();
    await expect(recordPrePrCheck(f.policy,f.name,'tests',async()=>{fs.appendFileSync(path.join(f.root,'code.ts'),'during');return {exitCode:0,output:'passed'};})).rejects.toThrow('PREPR_CONTENT_CHANGED');
    fs.writeFileSync(path.join(f.root,'code.ts'),'candidate\n');
    await f.check();f.independent();expect(f.review().review.findings.map(f=>f.code)).toContain('PREPR_CHECK_UNFINISHED');
  });
  it('blocks missing and failed checks, including an earlier failure hidden by a later success',async()=>{
    const f=await setup();f.independent();expect(f.review().review.verdict).toBe('BLOCKED');
    await recordPrePrCheck(f.policy,f.name,'tests',async()=>({exitCode:1,output:'failure'}));await f.check();
    expect(f.review().review.findings.map(f=>f.code)).toContain('PREPR_CHECK_FAILED');
  });
  it('cannot forge PASS, reviewer identity, or erase an earlier blocking hypothesis',async()=>{
    const f=await setup();await f.check();
    expect(()=>recordPrePrReview(f.policy,f.name,'developer','independent',[])).toThrow('PREPR_REVIEWER_NOT_AUTHORIZED');
    expect(()=>recordPrePrReview(f.policy,f.name,'unknown','independent',[])).toThrow('PREPR_REVIEWER_NOT_AUTHORIZED');
    expect(()=>recordPrePrReview(f.policy,f.name,'test-independent','independent',{verdict:'PASS'} as any)).toThrow('PREPR_REVIEW_INVALID');
    recordPrePrReview(f.policy,f.name,'test-independent','independent',[{finding:{code:'P2_CASE',severity:'error',message:'counterexample fails'},
      hypothesis:'child may survive',counterexample:'child ignores SIGTERM',reproduction:'run isolated persistent-descendant regression'}]);
    f.independent();expect(f.review().review.verdict).toBe('BLOCKED');
  });
  it('keeps missing approval, revocation and expiry blocking even with an independent fixture review',async()=>{
    const f=await setup(false);await expect(f.check()).rejects.toThrow('AUTHORIZATION_MISSING_OR_AMBIGUOUS');
    f.independent();expect(f.review().review.verdict).toBe('BLOCKED');
    await approveLocal(f.store,f.policy.mission,'qa','verify',new Date(Date.now()+3600_000).toISOString(),async(_p,c)=>c);
    expect(f.review().review.verdict).toBe('BLOCKED'); // Approval alone cannot supply a missing check.
    await f.check();expect(f.review().review.verdict).toBe('PASS');
    expect(reviewPrePr(f.policy,f.name,()=>new Date(Date.now()+7200_000)).review.verdict).toBe('BLOCKED');
    await revokeLocal(f.store,f.store.snapshots()[0].authorizationId,async(_p,c)=>c);expect(f.review().review.verdict).toBe('BLOCKED');
  });
  it('rejects altered records, foreign checks, changed criteria and changed reviewer policy',async()=>{
    const f=await setup();const receipt=await f.check();f.independent();
    f.policy.mission.assignments[0].expectedOutputs.done_when.push('changed');expect(f.review().review.verdict).toBe('BLOCKED');
    f.policy.mission.assignments[0].expectedOutputs.done_when.pop();
    f.policy.independentReviewerIds=[];expect(f.review().review.verdict).toBe('BLOCKED');f.policy.independentReviewerIds=['test-independent'];
    const file=path.join(f.store.directory,receipt+'.json'),raw=JSON.parse(fs.readFileSync(file,'utf8'));
    const r=JSON.parse(raw.payload);r.exitCode=0;r.candidateId='foreign';raw.payload=JSON.stringify(r);fs.writeFileSync(file,JSON.stringify(raw));
    expect(f.review().review.verdict).toBe('BLOCKED');
  });
  it('blocks unsafe scope, broken links, external links and staged submodules',async()=>{
    const f=await setup();fs.writeFileSync(path.join(f.root,'outside'),'x');expect(()=>freezePrePrCandidate(f.policy)).toThrow('PREPR_OUT_OF_SCOPE');fs.unlinkSync(path.join(f.root,'outside'));
    for(const target of ['missing',f.parent]){fs.symlinkSync(target,path.join(f.root,'new.ts'));expect(()=>freezePrePrCandidate(f.policy)).toThrow('PREPR_INTEGRITY_UNSAFE');fs.unlinkSync(path.join(f.root,'new.ts'));}
    git(f.root,'update-index','--add','--cacheinfo',`160000,${f.policy.mission.baseSha},new.ts`);
    expect(()=>freezePrePrCandidate(f.policy)).toThrow('PREPR_SUBMODULE_UNSUPPORTED');
  });
  it('captures the public env example but blocks runtime env files before reading',async()=>{
    const f=await setup();
    expect(f.store.readExecutionRecord(f.name)).toMatchObject({content:{files:expect.arrayContaining([expect.objectContaining({path:'.env.example',kind:'file'})])}});
    for(const file of ['.env','.env.local']){
      f.policy.mission.assignments[0].expectedOutputs.files_to_touch.push(file);
      fs.writeFileSync(path.join(f.root,file),'TEST_PLACEHOLDER=not-a-secret');
      expect(()=>freezePrePrCandidate(f.policy)).toThrow('PREPR_ENV_FILE_UNSUPPORTED');
      fs.unlinkSync(path.join(f.root,file));
    }
  });
  it('fails closed on a backward host clock and unknown test identity',async()=>{
    const f=await setup();
    await expect(recordPrePrCheck(f.policy,f.name,'tests',async()=>({exitCode:0,output:''}),()=>new Date(0))).rejects.toThrow('PREPR_INVALID_CLOCK');
    await expect(recordPrePrCheck(f.policy,f.name,'not-required',async()=>({exitCode:0,output:''}))).rejects.toThrow('PREPR_UNKNOWN_CHECK');
    expect(reviewPrePr(f.policy,f.name,()=>new Date(0)).review.verdict).toBe('BLOCKED');
  });
  it('does not certify semantics from superficial tests and a developer opinion',async()=>{
    const f=await setup();fs.writeFileSync(path.join(f.root,'code.ts'),'export const add=(a,b)=>a-b;');
    const name=freezePrePrCandidate(f.policy);
    await recordPrePrCheck(f.policy,name,'tests',async()=>({exitCode:0,output:'only verifies file exists'}));
    recordPrePrReview(f.policy,name,'developer','developer',[]);
    expect(reviewPrePr(f.policy,name)).toMatchObject({adversarialStatus:'NOT_REVIEWED',review:{verdict:'HUMAN_REVIEW'}});
  });
  it('rejects a malformed signed review claiming PASS',async()=>{
    const f=await setup();await f.check();const name=`result-${randomUUID()}`,candidateId=prePrReviewPacket(f.policy,f.name).candidateId;
    f.store.writeExecutionRecord(name,{kind:'guardian-prepr-review/1',candidateId,role:'independent',reviewerId:'test-independent',hypotheses:[],
      review:{reviewId:name,workerJobId:candidateId,policyVersion:'guardian-evidence-v0.1',reviewedAt:new Date().toISOString(),verdict:'PASS',findings:[{code:'BAD',severity:'unknown',message:'invalid'}]}});
    expect(f.review().review.findings.map(f=>f.code)).toContain('PREPR_REVIEW_INVALID');
  });
  it('does not treat an arbitrary signed EvidenceContract as a host check result',async()=>{
    const f=await setup();f.independent();f.store.writeExecutionRecord(`result-${randomUUID()}`,{candidateId:prePrReviewPacket(f.policy,f.name).candidateId,status:'done',verdict:'PASS'});
    expect(f.review().review.findings.map(f=>f.code)).toContain('PREPR_CHECK_MISSING');
  });
});

describe('PR16 P2 regressions (disposable sources, fictitious credentials only)',()=>{
  it('PR16 P2-A RED: blocks staged environment deletion without storing or exporting its fictitious value',async()=>{
    const f=await setup(false),fake='PR16_FICTITIOUS_CREDENTIAL_DO_NOT_USE';
    fs.writeFileSync(path.join(f.root,'.env.local'),'TOKEN='+fake+'\n');
    git(f.root,'add','.env.local');git(f.root,'commit','-m','Disposable fictitious environment fixture');
    f.policy.mission.baseSha=git(f.root,'rev-parse','HEAD');f.policy.mission.assignments[0].expectedOutputs.files_to_touch.push('.env.local');
    fs.unlinkSync(path.join(f.root,'.env.local'));git(f.root,'add','.env.local');
    let leaked=false,denial:string|undefined;
    try{const name=freezePrePrCandidate(f.policy);leaked=JSON.stringify(prePrReviewPacket(f.policy,name)).includes(fake);}catch(e){denial=(e as Error).message;}
    expect({leaked,denial}).toEqual({leaked:false,denial:'PREPR_ENV_FILE_UNSUPPORTED'});
    expect(fs.readdirSync(f.store.directory).filter(n=>n.endsWith('.json')).some(n=>fs.readFileSync(path.join(f.store.directory,n),'utf8').includes(fake))).toBe(false);
  });
  it('PR16 P2-B RED: freezes a tiny change beside an unchanged 3 MiB source file',async()=>{
    const f=await setup(false),large=('// fixture source'.padEnd(127,'x')+'\n').repeat(3*1024*1024/128);
    fs.writeFileSync(path.join(f.root,'large.ts'),large);
    git(f.root,'add','large.ts');git(f.root,'commit','-m','Disposable unchanged large source');
    f.policy.mission.baseSha=git(f.root,'rev-parse','HEAD');f.policy.mission.assignments[0].expectedOutputs.files_to_touch.push('large.ts');
    fs.appendFileSync(path.join(f.root,'code.ts'),'small change\n');
    let name!:string;expect(()=>{name=freezePrePrCandidate(f.policy);}).not.toThrow();
    const record=f.store.readExecutionRecord(name) as any,packet=prePrReviewPacket(f.policy,name);
    const entry=record.content.files.find((e:any)=>e.path==='large.ts');
    expect(entry).toMatchObject({kind:'file',mode:0o644,sha256:releaseSource.sha256(large)});expect(entry).not.toHaveProperty('contentBase64');
    expect(fs.statSync(path.join(f.store.directory,name+'.json')).size).toBeLessThan(4*1024*1024);
    expect(packet.candidateId).toBe(releaseSource.sha256(JSON.stringify(record.content)));
    expect(packet.diff).toEqual(record.content.diff);
    expect(packet.files).toEqual(record.content.files.filter((e:any)=>record.content.changedFiles.includes(e.path)));
    expect(Buffer.from(packet.files.find(e=>e.path==='code.ts')!.contentBase64!,'base64').toString()).toContain('small change');
    expect(reviewPrePr(f.policy,name).adversarialStatus).toBe('NOT_REVIEWED');
    fs.appendFileSync(path.join(f.root,'large.ts'),'// subsequent change\n');
    expect(()=>prePrReviewPacket(f.policy,name)).toThrow('PREPR_CONTENT_CHANGED');
    expect(reviewPrePr(f.policy,name).review.verdict).toBe('BLOCKED');
    const file=path.join(f.store.directory,name+'.json'),envelope=JSON.parse(fs.readFileSync(file,'utf8'));
    record.content.files.find((e:any)=>e.path==='large.ts').sha256='0'.repeat(64);envelope.payload=JSON.stringify(record);fs.writeFileSync(file,JSON.stringify(envelope));
    expect(()=>prePrReviewPacket(f.policy,name)).toThrow('EXECUTION_RECORD_INVALID');
  });
  it.each(['unstaged','staged','committed'].flatMap(layer=>['.env','nested/.env.production'].map(file=>({layer,file}))))('blocks $layer deletion of $file before reading content diffs',async({layer,file})=>{
    const f=await setup(false),fake='PR16_ONLY_FICTITIOUS_VALUE';
    fs.mkdirSync(path.dirname(path.join(f.root,file)),{recursive:true});fs.writeFileSync(path.join(f.root,file),'TOKEN='+fake+'\n');
    git(f.root,'add','--',file);git(f.root,'commit','-m','Disposable environment fixture');
    f.policy.mission.baseSha=git(f.root,'rev-parse','HEAD');f.policy.mission.assignments[0].expectedOutputs.files_to_touch.push(file);
    fs.unlinkSync(path.join(f.root,file));if(layer!=='unstaged')git(f.root,'add','--',file);
    if(layer==='committed')git(f.root,'commit','-m','Disposable deletion');
    const before=fs.readdirSync(f.store.directory).sort(),read=vi.spyOn(releaseSource,'gitReadRaw'),write=vi.spyOn(ApprovalStore.prototype,'writeExecutionRecord');
    expect(()=>freezePrePrCandidate(f.policy)).toThrow('PREPR_ENV_FILE_UNSUPPORTED');
    expect(read.mock.calls.some(args=>args.includes('--binary'))).toBe(false);expect(write).not.toHaveBeenCalled();
    expect(()=>prePrReviewPacket(f.policy,f.name)).toThrow();
    expect(fs.readdirSync(f.store.directory).sort()).toEqual(before);
    expect(before.filter(n=>n.endsWith('.json')).some(n=>fs.readFileSync(path.join(f.store.directory,n),'utf8').includes(fake))).toBe(false);
  });
  it.each(['unstaged','staged','committed'])('blocks %s environment renames, including a rename into the public example',async layer=>{
    const f=await setup(false);fs.writeFileSync(path.join(f.root,'.env'),'TOKEN=FICTITIOUS_RENAME_VALUE\n');
    git(f.root,'add','.env');git(f.root,'commit','-m','Disposable environment rename fixture');
    f.policy.mission.baseSha=git(f.root,'rev-parse','HEAD');f.policy.mission.assignments[0].expectedOutputs.files_to_touch.push('.env','.env.example');
    fs.renameSync(path.join(f.root,'.env'),path.join(f.root,'.env.example'));
    if(layer!=='unstaged')git(f.root,'add','--','.env','.env.example');if(layer==='committed')git(f.root,'commit','-m','Disposable rename');
    const read=vi.spyOn(releaseSource,'gitReadRaw');expect(()=>freezePrePrCandidate(f.policy)).toThrow('PREPR_ENV_FILE_UNSUPPORTED');
    expect(read.mock.calls.some(args=>args.includes('--binary'))).toBe(false);
  });
  it('preserves all three diff layers and review bytes for the exact .env.example exception',async()=>{
    const f=await setup(false);f.policy.mission.assignments[0].expectedOutputs.files_to_touch.push('.env.example');
    fs.writeFileSync(path.join(f.root,'.env.example'),'PUBLIC=committed\n');git(f.root,'add','.env.example');git(f.root,'commit','-m','Disposable public template');
    fs.writeFileSync(path.join(f.root,'.env.example'),'PUBLIC=staged\n');git(f.root,'add','.env.example');fs.writeFileSync(path.join(f.root,'.env.example'),'PUBLIC=unstaged\n');
    const name=freezePrePrCandidate(f.policy),packet=prePrReviewPacket(f.policy,name);
    expect(packet.diff.committed).toContain('+PUBLIC=committed');expect(packet.diff.staged).toContain('+PUBLIC=staged');expect(packet.diff.unstaged).toContain('+PUBLIC=unstaged');
    expect(packet.files.find(e=>e.path==='.env.example')?.contentBase64).toBe(Buffer.from('PUBLIC=unstaged\n').toString('base64'));
  });
  it.each(['.env.example.local','.env.example ','nested/.ENV.EXAMPLE','ambiguous\\.env'])('blocks unsafe or non-exact example path %s',async file=>{
    const f=await setup(false);f.policy.mission.assignments[0].expectedOutputs.files_to_touch.push(file);fs.mkdirSync(path.dirname(path.join(f.root,file)),{recursive:true});fs.writeFileSync(path.join(f.root,file),'FICTITIOUS_ONLY');
    const read=vi.spyOn(releaseSource,'gitReadRaw');expect(()=>freezePrePrCandidate(f.policy)).toThrow(file.includes('\\')?'PREPR_UNSAFE_SCOPE':'PREPR_ENV_FILE_UNSUPPORTED');
    expect(read.mock.calls.some(args=>args.includes('--binary'))).toBe(false);
  });
  it('blocks packet export if a prohibited file appears after freezing',async()=>{
    const f=await setup(false);f.policy.mission.assignments[0].expectedOutputs.files_to_touch.push('.env');
    const name=freezePrePrCandidate(f.policy),before=fs.readdirSync(f.store.directory).sort();fs.writeFileSync(path.join(f.root,'.env'),'TOKEN=FICTITIOUS_AFTER_FREEZE');
    expect(()=>prePrReviewPacket(f.policy,name)).toThrow('PREPR_ENV_FILE_UNSUPPORTED');
    expect(reviewPrePr(f.policy,name)).toMatchObject({review:{verdict:'BLOCKED'},adversarialStatus:'NOT_REVIEWED'});
    expect(fs.readdirSync(f.store.directory).sort()).toEqual(before);
  });
  it('treats pathspec-like filenames literally when capturing the exact diff',async()=>{
    const f=await setup(false),file='literal[1].ts';f.policy.mission.assignments[0].expectedOutputs.files_to_touch.push(file);
    fs.writeFileSync(path.join(f.root,file),'old\n');git(f.root,'add','--',file);git(f.root,'commit','-m','Disposable literal filename');
    f.policy.mission.baseSha=git(f.root,'rev-parse','HEAD');fs.writeFileSync(path.join(f.root,file),'new\n');
    const packet=prePrReviewPacket(f.policy,freezePrePrCandidate(f.policy));expect(packet.diff.unstaged).toContain('+new');
  });
  it.each(['candidate','diff','source'] as const)('rejects an oversized %s explicitly without partial storage or truncation',async kind=>{
    const f=await setup(false),before=fs.readdirSync(f.store.directory).sort();
    if(kind==='candidate')fs.writeFileSync(path.join(f.root,'new.ts'),'x'.repeat(3*1024*1024));
    if(kind==='diff')fs.appendFileSync(path.join(f.root,'code.ts'),'x'.repeat(1100*1024));
    if(kind==='source')fs.writeFileSync(path.join(f.root,'new.ts'),'x'.repeat(9*1024*1024));
    const code={candidate:'PREPR_CANDIDATE_TOO_LARGE',diff:'PREPR_DIFF_TOO_LARGE',source:'PREPR_SOURCE_TOO_LARGE'}[kind];
    expect(()=>freezePrePrCandidate(f.policy)).toThrow(code);expect(fs.readdirSync(f.store.directory).sort()).toEqual(before);
  });

});
