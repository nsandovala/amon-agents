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
import { PrePrPolicy, freezePrePrCandidate, prePrReviewPacket, recordPrePrCheck, recordPrePrReview, reviewPrePr } from './pre-pr';
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
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
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
