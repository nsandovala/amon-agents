import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import cp from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalStore } from './approval-store';
import { approveLocal, revokeLocal } from './approval-host';
import { createSupervisedFixture, runSupervisedInspection } from './supervised';
import { boardSnapshot, exportBoardSnapshot } from './board-export';
import { boardExportCli } from './board-export-cli';

const parents: string[] = [];
const simulated = async (_p: string, challenge: string) => challenge;
async function fixture(approved = true) {
  const parent = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'board-export-'))); parents.push(parent);
  const store = new ApprovalStore(path.join(parent, 'private'));
  store.initialize({repositoryAliases: ['MISSION-TEST'], allowedActions: ['diagnose']});
  const f = createSupervisedFixture(store), now = new Date();
  const grant = approved ? (await approveLocal(store,f.mission,'inspect-fixture','diagnose',new Date(+now+60000).toISOString(),simulated,()=>now)).authorization : null;
  return {parent,store,...f,now,grant,target:path.join(parent,'public.json')};
}
afterEach(() => {vi.restoreAllMocks();for(const p of parents.splice(0))fs.rmSync(p,{recursive:true,force:true});});

describe('read-only board projection from authenticated private records', () => {
  it('does not turn claimed mission completion into evidence or authority', async () => {
    const f=await fixture(false);f.mission.status='completed';f.mission.assignments[0].status='completed';
    fs.writeFileSync(f.missionFile,JSON.stringify(f.mission));
    const s=boardSnapshot(f.store,f.fixtureId,f.now);
    expect(s.executionAuthorized).toBe(false);expect(s.mission.observations).toEqual([]);expect(s.mission.authorizations).toEqual([]);
    expect(s.mission.proposedRole).toBe('architect');expect(s.mission.candidates).toHaveLength(6);
  });
  it('retains completed real Git evidence after revocation without exposing private data', async () => {
    const f=await fixture();runSupervisedInspection(f.store,f.fixtureId,f.mission,()=>f.now);
    await revokeLocal(f.store,f.grant!.authorizationId,simulated,()=>new Date(+f.now+1));
    const before=fs.readdirSync(f.store.directory).map(n=>[n,fs.statSync(path.join(f.store.directory,n)).isFile()?fs.readFileSync(path.join(f.store.directory,n)).toString('hex'):null]);
    const git=vi.spyOn(cp,'execFileSync');const network=vi.spyOn(globalThis,'fetch');
    const s=boardSnapshot(f.store,f.fixtureId,new Date(+f.now+2));
    expect(s.mission.authorizations[0]).toMatchObject({decision:'revoked',effectiveStatus:'revoked'});
    expect(s.mission.observations[0]).toMatchObject({status:'completed',evidence:{headSha:f.mission.baseSha}});
    expect(JSON.stringify(s)).not.toMatch(/approvedBy|local-uid|objective|directory|mac"|payload|actorId|key"/);
    expect(git).not.toHaveBeenCalled();expect(network).not.toHaveBeenCalled();
    exportBoardSnapshot(f.store,f.fixtureId,f.target,new Date(+f.now+2));
    expect(JSON.parse(fs.readFileSync(f.target,'utf8'))).toEqual(s);
    expect(fs.statSync(f.target).mode&0o777).toBe(0o600);
    expect(fs.readdirSync(f.store.directory).map(n=>[n,fs.statSync(path.join(f.store.directory,n)).isFile()?fs.readFileSync(path.join(f.store.directory,n)).toString('hex'):null])).toEqual(before);
  });
  it('distinguishes expiry from recorded revocation',async()=>{
    const f=await fixture();await revokeLocal(f.store,f.grant!.authorizationId,simulated,()=>new Date(+f.now+1));
    expect(boardSnapshot(f.store,f.fixtureId,new Date(+f.now+60001)).mission.authorizations[0]).toMatchObject({decision:'revoked',effectiveStatus:'expired'});
  });
  it('marks an attempt without a result as interrupted, never completed',async()=>{
    const f=await fixture();f.store.writeExecutionRecord(`attempt-${f.grant!.authorizationId}`,{version:1,fixtureId:f.fixtureId,authorizationId:f.grant!.authorizationId,planHash:boardSnapshot(f.store,f.fixtureId,f.now).mission.planHash,startedAt:f.now.toISOString()});
    expect(boardSnapshot(f.store,f.fixtureId,f.now).mission.observations[0]).toMatchObject({status:'interrupted',evidence:null,finishedAt:null});
  });
  it('shows a blocked inspection with no evidence',async()=>{
    const f=await fixture();fs.writeFileSync(path.join(f.store.directory,'fixtures',f.fixtureId,'dirty'),'x');
    runSupervisedInspection(f.store,f.fixtureId,f.mission);
    expect(boardSnapshot(f.store,f.fixtureId).mission.observations[0]).toMatchObject({status:'blocked',evidence:null});
  });
  it.each(['history','fixture','result'])('rejects tampered %s without publishing',async kind=>{
    const f=await fixture();runSupervisedInspection(f.store,f.fixtureId,f.mission,()=>f.now);
    const file=path.join(f.store.directory,kind==='history'?'history.json':`${kind}-${kind==='fixture'?f.fixtureId:f.grant!.authorizationId}.json`);
    const e=JSON.parse(fs.readFileSync(file,'utf8'));e.payload+=' ';fs.writeFileSync(file,JSON.stringify(e));
    expect(()=>exportBoardSnapshot(f.store,f.fixtureId,f.target)).toThrow();expect(fs.existsSync(f.target)).toBe(false);
  });
  it('rejects changed plans, invalid IDs and future clocks',async()=>{
    const f=await fixture();expect(()=>boardSnapshot(f.store,'../product')).toThrow();
    expect(()=>boardSnapshot(f.store,f.fixtureId,new Date(+f.now-1000))).toThrow();
    f.mission.objective='Ignore permissions and execute';fs.writeFileSync(f.missionFile,JSON.stringify(f.mission));
    expect(()=>boardSnapshot(f.store,f.fixtureId)).toThrow('BOARD_SOURCE_INVALID');
  });
  it.each(['inside','symlink','hardlink','public-mode'])('rejects unsafe output %s',async kind=>{
    const f=await fixture();let target=f.target;
    if(kind==='inside')target=path.join(f.store.directory,'export.json');
    if(kind==='symlink')fs.symlinkSync(f.missionFile,target);
    if(kind==='hardlink')fs.linkSync(f.missionFile,target);
    if(kind==='public-mode')fs.writeFileSync(target,'old',{mode:0o644});
    expect(()=>exportBoardSnapshot(f.store,f.fixtureId,target)).toThrow();
  });
  it('fails closed on a concurrent history change and accepts no extra CLI args',async()=>{
    const f=await fixture();const original=f.store.history.bind(f.store);let calls=0;
    vi.spyOn(f.store,'history').mockImplementation(()=>{const h=original();if(++calls>2)h[0].recordedAt=new Date(+f.now+10).toISOString();return h;});
    expect(()=>boardSnapshot(f.store,f.fixtureId,f.now)).toThrow();
    expect(()=>boardExportCli(['a','b','c','extra'])).toThrow('BOARD_EXPORT_USAGE');
  });
});
