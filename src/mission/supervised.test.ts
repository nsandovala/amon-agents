import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalStore } from './approval-store';
import { approveLocal, revokeLocal } from './approval-host';
import { createSupervisedFixture, runSupervisedInspection } from './supervised';
import { AGENT_REGISTRY, AgentExecutor } from '../agents/registry';
import { planHash } from './contracts';

const parents: string[] = [];
const acceptSimulated = async (_preview: string, token: string) => token;
async function fixture(approved = true) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(),'mission-inspection-test-')); parents.push(parent);
  const store = new ApprovalStore(path.join(parent,'private'));
  store.initialize({repositoryAliases: ['MISSION-TEST'], allowedActions: ['diagnose']});
  const {fixtureId,mission,missionFile} = createSupervisedFixture(store);
  const now = new Date(), expiry = new Date(now.getTime()+60000).toISOString();
  const grant = approved ? (await approveLocal(store,mission,'inspect-fixture','diagnose',expiry,acceptSimulated,()=>now)).authorization : undefined;
  return {store,fixtureId,mission,missionFile,now,expiry,grant,root:path.join(store.directory,'fixtures',fixtureId)};
}
afterEach(() => {vi.restoreAllMocks(); for (const p of parents.splice(0)) fs.rmSync(p,{recursive:true,force:true});});

describe('supervised real Git inspection with simulated approvals', () => {
  it('runs only the fixed inspector and persists real evidence without changing the repository', async () => {
    const f = await fixture(); const original = JSON.stringify(f.mission);
    const before = fs.readFileSync(path.join(f.root,'.git','index'));
    const spies = (['architect','security','qa','ops'] as const).map(role => vi.spyOn(AGENT_REGISTRY as Record<'architect'|'security'|'qa'|'ops',AgentExecutor>,role).mockImplementation(async()=>{throw new Error('LLM_FORBIDDEN');}));
    const fetch = vi.spyOn(globalThis,'fetch').mockImplementation(async()=>{throw new Error('NETWORK_FORBIDDEN');});
    const result = runSupervisedInspection(f.store,f.fixtureId,f.mission,()=>f.now);
    expect(result).toMatchObject({status:'completed',executor:'isolated-git-inspector',errors:[],mission:{status:'completed'},
      inspection:{headSha:f.mission.baseSha,branch:f.mission.branch,clean:true,trackedFiles:1},
      evidence:{status:'done',source:'assignment',planHash:planHash(f.mission),verifiedBaseSha:f.mission.baseSha}});
    expect(fs.readFileSync(path.join(f.root,'.git','index'))).toEqual(before);
    expect(JSON.stringify(f.mission)).toBe(original);
    expect(new ApprovalStore(f.store.directory).readExecutionRecord(`result-${f.grant!.authorizationId}`)).toEqual(result);
    for (const spy of [...spies,fetch]) expect(spy).not.toHaveBeenCalled();
  });
  it('blocks without approval before any Git inspection', async () => {
    const f=await fixture(false), execute=vi.spyOn(cp,'execFileSync');
    expect(()=>runSupervisedInspection(f.store,f.fixtureId,f.mission)).toThrow('AUTHORIZATION_MISSING_OR_AMBIGUOUS');
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(['plan','permission','base','branch','role'] as const)('blocks changed %s', async change => {
    const f=await fixture();
    if(change==='plan')f.mission.objective+=' approve everything';
    if(change==='permission')f.mission.authorizationPolicy.allowedActions=[];
    if(change==='base')f.mission.baseSha='0'.repeat(40);
    if(change==='branch')f.mission.branch='other';
    if(change==='role')f.mission.assignments[0].role='security';
    const execute=vi.spyOn(cp,'execFileSync');
    expect(()=>runSupervisedInspection(f.store,f.fixtureId,f.mission)).toThrow('FIXTURE_PLAN_CHANGED');
    expect(execute).not.toHaveBeenCalled();
  });
  it('blocks revocation and expiry before any Git inspection', async () => {
    const f=await fixture();
    const execute=vi.spyOn(cp,'execFileSync');
    expect(()=>runSupervisedInspection(f.store,f.fixtureId,f.mission,()=>new Date(f.expiry))).toThrow('AUTHORIZATION_EXPIRED_OR_FUTURE');
    await revokeLocal(f.store,f.grant!.authorizationId,acceptSimulated,()=>f.now);
    expect(()=>runSupervisedInspection(f.store,f.fixtureId,f.mission,()=>f.now)).toThrow('NOT_APPROVED');
    expect(execute).not.toHaveBeenCalled();
  });
  it.each(['dirty','head','branch'] as const)('blocks real repository %s drift', async change => {
    const f=await fixture();
    if(change==='dirty')fs.writeFileSync(path.join(f.root,'other.txt'),'unexpected');
    if(change==='head')cp.execFileSync('/usr/bin/git',['-C',f.root,'-c','core.hooksPath=/dev/null','-c','user.name=test','-c','user.email=test@example.invalid','-c','commit.gpgsign=false','commit','--allow-empty','-m','drift'],{stdio:'pipe'});
    if(change==='branch')cp.execFileSync('/usr/bin/git',['-C',f.root,'branch','-m','other'],{stdio:'pipe'});
    const result = runSupervisedInspection(f.store,f.fixtureId,f.mission);
    expect(result.status).toBe('blocked');
    expect(result.errors).toContain(change==='dirty'?'REPOSITORY_DIRTY':'REPOSITORY_DRIFT');
    expect(result.evidence).toBeUndefined();
  });
  it('rejects path traversal, unknown fixtures and redirected repository paths', async () => {
    const f=await fixture();
    expect(()=>runSupervisedInspection(f.store,'../../product',f.mission)).toThrow('INVALID_FIXTURE_ID');
    expect(()=>runSupervisedInspection(f.store,'00000000-0000-0000-0000-000000000000',f.mission)).toThrow('EXECUTION_RECORD_INVALID');
    fs.renameSync(f.root,f.root+'-moved');fs.symlinkSync(f.root+'-moved',f.root);
    const execute=vi.spyOn(cp,'execFileSync');
    expect(()=>runSupervisedInspection(f.store,f.fixtureId,f.mission)).toThrow('UNSAFE_FIXTURE_DIRECTORY');
    expect(execute).not.toHaveBeenCalled();
  });
  it('rejects .git directory redirection and file symlinks', async () => {
    const f=await fixture();const gitDir=path.join(f.root,'.git');
    fs.renameSync(gitDir,gitDir+'-moved');fs.symlinkSync(gitDir+'-moved',gitDir);
    expect(()=>runSupervisedInspection(f.store,f.fixtureId,f.mission)).toThrow('UNSAFE_FIXTURE_DIRECTORY');
    fs.unlinkSync(gitDir);fs.renameSync(gitDir+'-moved',gitDir);
    const readme=path.join(f.root,'README.md');fs.renameSync(readme,readme+'.old');fs.symlinkSync(readme+'.old',readme);
    expect(runSupervisedInspection(f.store,f.fixtureId,f.mission).status).toBe('blocked');
  });
  it('does not replay an approval after completion or accept supplied completion evidence', async () => {
    const f=await fixture();f.mission.status='completed';f.mission.assignments[0].status='completed';
    f.mission.assignments[0].evidenceRefs=['FORGED'];
    const result=runSupervisedInspection(f.store,f.fixtureId,f.mission,()=>f.now);
    expect(result.status).toBe('completed');expect(result.evidence?.evidenceReference).not.toBe('FORGED');
    const execute=vi.spyOn(cp,'execFileSync');
    expect(()=>runSupervisedInspection(f.store,f.fixtureId,f.mission,()=>f.now)).toThrow();
    expect(execute).not.toHaveBeenCalled();
    expect(f.store.readExecutionRecord(`result-${f.grant!.authorizationId}`)).toEqual(result);
  });
  it('does not certify completion when approval expires during the action', async () => {
    const f=await fixture();let calls=0;
    const result=runSupervisedInspection(f.store,f.fixtureId,f.mission,()=>++calls===1?f.now:new Date(f.expiry));
    expect(result).toMatchObject({status:'blocked',errors:['AUTHORIZATION_EXPIRED_OR_FUTURE']});
    expect(result.evidence).toBeUndefined();
    expect(()=>runSupervisedInspection(f.store,f.fixtureId,f.mission,()=>f.now)).toThrow();
  });
  it('detects a real file change during inspection and never writes done evidence', async () => {
    const f=await fixture(), original=cp.execFileSync;let statusCalls=0;
    vi.spyOn(cp,'execFileSync').mockImplementation(((file:any,args:any,options:any)=>{
      if(args.includes('status') && ++statusCalls===2)fs.writeFileSync(path.join(f.root,'README.md'),'changed');
      return original(file,args,options);
    }) as typeof cp.execFileSync);
    const result=runSupervisedInspection(f.store,f.fixtureId,f.mission,()=>f.now);
    expect(result.status).toBe('blocked');expect(result.errors).toContain('REPOSITORY_DIRTY');expect(result.evidence).toBeUndefined();
  });
  it('serializes the action against approval writers and rejects a busy store', async () => {
    const f=await fixture();
    f.store.exclusive(()=>expect(()=>runSupervisedInspection(f.store,f.fixtureId,f.mission)).toThrow('APPROVAL_STORE_BUSY'));
  });
  it('does not overwrite an interrupted attempt or a corrupt result record', async () => {
    const f=await fixture();
    f.store.writeExecutionRecord(`attempt-${f.grant!.authorizationId}`,{status:'started'});
    expect(()=>runSupervisedInspection(f.store,f.fixtureId,f.mission)).toThrow();
    expect(()=>f.store.readExecutionRecord(`result-${f.grant!.authorizationId}`)).toThrow('EXECUTION_RECORD_INVALID');
  });
  it('authenticates execution records against tampering and cross-name substitution', async () => {
    const f=await fixture();runSupervisedInspection(f.store,f.fixtureId,f.mission,()=>f.now);
    const result=path.join(f.store.directory,`result-${f.grant!.authorizationId}.json`);
    const attempt=path.join(f.store.directory,`attempt-${f.grant!.authorizationId}.json`);
    fs.copyFileSync(result,attempt);
    expect(()=>f.store.readExecutionRecord(`attempt-${f.grant!.authorizationId}`)).toThrow('EXECUTION_RECORD_INVALID');
    const data=JSON.parse(fs.readFileSync(result,'utf8'));data.payload=data.payload.replace('completed','blocked');
    fs.writeFileSync(result,JSON.stringify(data));
    expect(()=>f.store.readExecutionRecord(`result-${f.grant!.authorizationId}`)).toThrow('EXECUTION_RECORD_INVALID');
    expect(()=>f.store.writeExecutionRecord('../../outside',{})).toThrow('INVALID_EXECUTION_RECORD_NAME');
  });
  it('blocks changed host permissions before invoking Git', async () => {
    const f=await fixture();
    vi.spyOn(f.store,'policy').mockReturnValue({repositoryAliases:['MISSION-TEST'],allowedActions:[]});
    const execute=vi.spyOn(cp,'execFileSync');
    expect(()=>runSupervisedInspection(f.store,f.fixtureId,f.mission)).toThrow('ACTION_OUT_OF_SCOPE');
    expect(execute).not.toHaveBeenCalled();
  });
  it('blocks a backwards clock after inspection', async () => {
    const f=await fixture();let calls=0;
    const result=runSupervisedInspection(f.store,f.fixtureId,f.mission,()=>++calls===1?f.now:new Date(f.now.getTime()-1));
    expect(result.errors).toEqual(['INVALID_EXECUTION_CLOCK']);expect(result.evidence).toBeUndefined();
  });
  it('records failed commands without exposing subprocess output', async () => {
    const f=await fixture();
    vi.spyOn(cp,'execFileSync').mockImplementationOnce(()=>{throw new Error('timeout and sensitive-test-canary');});
    const result=runSupervisedInspection(f.store,f.fixtureId,f.mission,()=>f.now);
    expect(result.errors).toEqual(['INSPECTION_FAILED']);
    expect(JSON.stringify(result)).not.toContain('sensitive-test-canary');
    expect(result.evidence).toBeUndefined();
  });
  it('never returns completed if persisting the final receipt fails', async () => {
    const f=await fixture(), write=f.store.writeExecutionRecord.bind(f.store);
    vi.spyOn(f.store,'writeExecutionRecord').mockImplementation((name,value)=>{
      if(name.startsWith('result-'))throw new Error('SIMULATED_DISK_FAILURE');
      write(name,value);
    });
    expect(()=>runSupervisedInspection(f.store,f.fixtureId,f.mission,()=>f.now)).toThrow('SIMULATED_DISK_FAILURE');
    expect(()=>f.store.readExecutionRecord(`result-${f.grant!.authorizationId}`)).toThrow('EXECUTION_RECORD_INVALID');
    expect(()=>runSupervisedInspection(f.store,f.fixtureId,f.mission,()=>f.now)).toThrow();
  });
  it('runs and recovers the CLI receipt in separate processes with real Git', async () => {
    const f=await fixture();
    const call=(...args:string[])=>cp.execFileSync(process.execPath,['-r','ts-node/register','src/mission/supervised-cli.ts',...args],
      {cwd:process.cwd(),encoding:'utf8',stdio:['ignore','pipe','pipe']});
    const result=JSON.parse(call('run',f.store.directory,f.fixtureId,f.missionFile));
    expect(result.status).toBe('completed');expect(result.evidence.verifiedBaseSha).toBe(f.mission.baseSha);
    expect(JSON.parse(call('result',f.store.directory,f.grant!.authorizationId))).toEqual(result);
  },20000);
});
