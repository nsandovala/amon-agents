import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import history from './fixtures/pre-pr-history.json';
import { nextFixture } from './fixtures/next-release';
import { reviewWorkerJobEvidence, verdictFor, GUARDIAN_POLICY_VERSION } from './evidence-gate';
import { reviewNextBuildEvidence } from './next-build';
import { collectNextBuild, HostBuildPolicy } from './next-build-collector';
import { gitRead, directoryDigest, inspectReleaseSource, sha256 } from './release-source';
import { captureIntegrity } from '../standards/integrity';
import { fixture } from '../mission/demo/fixtures';
import { ApprovalStore } from '../mission/approval-store';
import { approvalContext, approveLocal, localApproverId } from '../mission/approval-host';
import { canPerform } from '../mission/state';
import { EvidenceContract, planHash } from '../mission/contracts';

// Explicit opt-in RED mode executes frozen historical function fragments in disposable
// fixtures. The default tests exercise current Guardian. No source checkout/revert occurs.
const legacy=process.env.GUARDIAN_PREPR_BENCHMARK_LEGACY==='1';
const roots:string[]=[];
const temp=()=>{const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),'prepr-benchmark-')));roots.push(root);return root;};
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
function historical(source:string,name:string,deps:Record<string,unknown>):any {
  const js=ts.transpileModule(source.replace(/export /g,''),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  return new Function(...Object.keys(deps),js+`\nreturn ${name};`)(...Object.values(deps));
}
const historicalReview=()=>historical(history.workerReview,'reviewWorkerJobEvidence',{
  reviewCodingToolEvidence:()=>[],finding:(x:unknown)=>x,isCodingToolEvidence:(x:unknown)=>!!x,
  reviewNextBuildEvidence,verdictFor,summarize:()=>'',GUARDIAN_POLICY_VERSION});
const git=(root:string,...args:string[])=>execFileSync('/usr/bin/git',['-C',root,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe'],
  env:{PATH:'/usr/bin:/bin',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_AUTHOR_NAME:'Fixture',GIT_AUTHOR_EMAIL:'fixture@example.invalid',GIT_COMMITTER_NAME:'Fixture',GIT_COMMITTER_EMAIL:'fixture@example.invalid'}}).trim();
function workerCase() {
  const {build,policy}=nextFixture(),evidence={repoPath:policy.root,worktreePath:policy.root,branch:policy.branch,headSha:policy.headSha,
    gitStatusBefore:'',tool:'opencode',toolVersion:'fixture',startedAt:policy.startedAt,exitCode:0,stdout:'',stderr:'',finishedAt:build.finishedAt,
    durationMs:60000,gitStatusAfter:'',diffStat:'',changedFiles:[],diff:'',worktreeHeadShaAfter:policy.headSha,worktreeBranchAfter:policy.branch,
    expectedFile:'code.ts',expectedContentMatched:true,humanReview:false};
  const workerJob:any={jobId:'BENCH',action:'run_coding_tool',status:'done',transitions:[],evidence};
  const options={reviewId:'BENCH',workerJobId:'BENCH',reviewedAt:policy.now,nextBuild:{evidence:build,policy:{...policy.nextBuild,...policy}}};
  return {workerJob,options};
}
async function buildCase(script:string,dependency=false) {
  const parent=temp(),root=path.join(parent,'source');fs.mkdirSync(root);
  const nf=nextFixture();fs.writeFileSync(path.join(root,'package.json'),JSON.stringify({name:'fixture',dependencies:{next:'^15.0.0'}}));
  fs.writeFileSync(path.join(root,'package-lock.json'),nf.policy.nextBuild.lockfileText);fs.writeFileSync(path.join(root,'.gitignore'),'node_modules/\n.next/\n');
  git(root,'init','-b','fixture/build');git(root,'add','.');git(root,'-c','core.hooksPath=/dev/null','commit','-m','Disposable fixture');
  fs.mkdirSync(path.join(root,'node_modules/next/dist/bin'),{recursive:true});fs.writeFileSync(path.join(root,'node_modules/next/package.json'),JSON.stringify({name:'next',version:'15.1.2'}));
  fs.writeFileSync(path.join(root,'node_modules/next/dist/bin/next'),script);
  const {m}=fixture(['qa']);m.baseSha=git(root,'rev-parse','HEAD');m.branch='fixture/build';m.authorizationPolicy.approverIds=[localApproverId()];
  if(dependency){const dep={...structuredClone(m.assignments[0]),assignmentId:'previous',status:'completed' as const,evidenceRefs:['PREVIOUS']};m.assignments[0].dependencies=['previous'];m.assignments.unshift(dep);}
  const store=new ApprovalStore(path.join(parent,'store'));store.initialize({repositoryAliases:[m.repositoryAlias],allowedActions:['verify']});
  for(const a of m.assignments)await approveLocal(store,m,a.assignmentId,'verify',new Date(Date.now()+3600_000).toISOString(),async(_p,c)=>c);
  const source=inspectReleaseSource(root),policy:HostBuildPolicy={runId:'BENCH',root,branch:m.branch,headSha:m.baseSha,startedAt:new Date().toISOString(),now:new Date().toISOString(),
    nextBuild:{...nf.policy.nextBuild,nodeVersion:process.version,platform:process.platform},releaseHost:{declaredStack:'next',repositoryAlias:m.repositoryAlias,sourceSha256:source.sourceSha256,
      dependenciesSha256:directoryDigest(path.join(root,'node_modules'),'dependencies'),mission:m,assignmentId:'qa',storeDirectory:store.directory,timeoutMs:500}};
  const evidence:EvidenceContract={source:'assignment',jobId:'PREVIOUS-JOB',action:'verify',status:'done',observedAt:new Date().toISOString(),verifiedBaseSha:m.baseSha,
    verifiedBranch:m.branch,evidenceReference:'PREVIOUS',missionId:m.missionId,assignmentId:'previous',planHash:planHash(m)};
  if(dependency){const name=`result-${randomUUID()}`;store.writeExecutionRecord(name,evidence);(policy.releaseHost as any).evidenceRecords=[name];}
  return {root,parent,store,policy,m,evidence};
}
const alive=(pid:number)=>{try{process.kill(pid,0);return true;}catch(e){if((e as NodeJS.ErrnoException).code==='ESRCH')return false;throw e;}};
const delay=(ms:number)=>new Promise(r=>setTimeout(r,ms));

describe(`historical adversarial benchmark (${legacy?'controlled defective RED':'current Guardian GREEN'})`,()=>{
  it('A: capture does not read a directory symlink as a file',()=>{
    const root=temp();fs.mkdirSync(path.join(root,'skills'));fs.symlinkSync('skills',path.join(root,'adapter'));
    const capture=()=>legacy ? fs.readFileSync(path.join(root,'adapter')) : captureIntegrity(root,['adapter']);
    expect(capture).not.toThrow();
  });
  it('PR14: build before worker changes cannot prove candidate identity',()=>{
    const {workerJob,options}=workerCase();workerJob.evidence.gitStatusAfter=' M code.ts';workerJob.evidence.changedFiles=['code.ts'];
    workerJob.evidence.finishedAt=options.reviewedAt;
    const result=(legacy?historicalReview():reviewWorkerJobEvidence)({workerJob,worktreeRoot:'/qa'},options);
    expect(result.verdict).toBe('BLOCKED');
  });
  it('PR14: one host review clock avoids a false context mismatch',()=>{
    const {workerJob,options}=workerCase();workerJob.evidence.startedAt='2026-11-17T00:00:00.000Z';workerJob.evidence.finishedAt='2026-11-17T00:01:00.000Z';
    options.nextBuild.policy.now='2026-11-18T00:01:59.999Z';
    const result=(legacy?historicalReview():reviewWorkerJobEvidence)({workerJob,worktreeRoot:'/qa'},options);
    expect(result.findings.map((f:any)=>f.code)).not.toContain('NEXT_WORKER_CONTEXT_MISMATCH');
  });
  it('PR14: /warning is a route, not a diagnostic',()=>{
    const {build,policy}=nextFixture();build.stdout='└ ○ /warning  1 kB  100 kB';
    const blocks=legacy ? new RegExp(history.warningPattern,'i').test(build.stdout) : reviewNextBuildEvidence(build,{...policy.nextBuild,...policy}).verdict!=='PASS';
    expect(blocks).toBe(false);
  });
  it('PR15: parent close must not cancel owned-group SIGKILL escalation',async()=>{
    const descendant=`const fs=require('fs');process.on('SIGTERM',()=>{});fs.writeFileSync(process.env.HOME+'/descendant',String(process.pid));setInterval(()=>{},20);setTimeout(()=>process.exit(0),8000);`;
    const script=`const {spawn}=require('child_process');const fs=require('fs');const fd=fs.openSync(process.env.HOME+'/child-output','w');spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',fd,fd]});setInterval(()=>{},1000);`;
    const f=await buildCase(script);let home:string,group:number;
    if(legacy){const run=historical(history.processBuild,'processBuild',{fs,path,createHash,spawn,performance,sha256,redact:(v:string)=>v});
      const result=await run(f.root,{PATH:'/usr/bin:/bin',HOME:f.parent},500);home=f.parent;group=result.process.pid;
    }else{const result=await collectNextBuild(f.policy);const record=f.store.readExecutionRecord(result.recordName) as any;home=record.process.environment.HOME;group=record.process.pid;}
    const pid=Number(fs.readFileSync(path.join(home,'descendant'),'utf8'));
    try{await delay(1200);expect(alive(pid)).toBe(false);expect(alive(-group)).toBe(false);}
    finally{if(alive(pid))process.kill(pid,'SIGKILL');for(let i=0;i<100&&alive(pid);i++)await delay(20);expect(alive(pid)).toBe(false);}
  },15000);
  it('PR15: a valid dependent mission needs authenticated completion evidence in context',async()=>{
    const f=await buildCase("const fs=require('fs');fs.mkdirSync('.next');fs.writeFileSync('.next/BUILD_ID','fixture');console.log('Compiled successfully');",true);
    if(legacy)expect(canPerform(f.m,'qa','verify',approvalContext(f.store,new Date())).ok).toBe(true);
    else expect((await collectNextBuild(f.policy)).reasons).toEqual([]);
  });
  it('PR15: a repository fsmonitor hook must not execute during host inspection',()=>{
    const root=temp();git(root,'init','-b','fixture/hook');fs.writeFileSync(path.join(root,'tracked'),'x');git(root,'add','.');git(root,'-c','core.hooksPath=/dev/null','commit','-m','Disposable fixture');
    const marker=path.join(root,'.git/hook-ran'),hook=path.join(root,'.git/benign-hook');
    fs.writeFileSync(hook,`#!/bin/sh\nprintf invoked > '${marker}'\nprintf '\\0'\n`,{mode:0o700});git(root,'config','core.fsmonitor',hook);
    git(root,'status','--porcelain');expect(fs.existsSync(marker)).toBe(true);fs.unlinkSync(marker);
    const read=legacy?historical(history.gitRead,'gitRead',{execFileSync}):gitRead;
    read(root,'status','--porcelain');expect(fs.existsSync(marker)).toBe(false);
  });
});
