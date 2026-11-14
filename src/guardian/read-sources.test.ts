import fs from 'node:fs';
import path from 'node:path';
import cp from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalStore } from '../mission/approval-store';
import { createSupervisedFixture } from '../mission/supervised';
import { exportBoardSnapshot } from '../mission/board-export';
import { createLocalReadSources, MISSION_EXPORT } from './read-sources';
import { createGuardianReadAdapter } from './read-adapter';
import { READ_LIMITS } from './read-contracts';

const roots: string[] = [];
const evidenceDir = path.join(process.cwd(), '.execution-qa');
const time = '2026-11-14T12:00:00.000Z';
function write(root: string, name: string, value: unknown) {
  const file = path.join(root,name); fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
  fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});
}
function fixture() {
  fs.mkdirSync(evidenceDir,{recursive:true});
  const root = fs.realpathSync(fs.mkdtempSync(path.join(evidenceDir,'read-tests-'))); roots.push(root);
  fs.mkdirSync(path.join(root,'outputs/worker/jobs'),{recursive:true});
  fs.mkdirSync(path.join(root,'outputs/guardian/reviews'),{recursive:true});
  write(root,'outputs/worker/worker-status.json',{workerId:'private-worker',status:'offline',platform:'darwin',arch:'arm64',
    workspace:{root:'/Users/private',available:true},lastHeartbeatAt:time,tools:[]});
  write(root,'outputs/worker/jobs/private-job.json',{jobId:'private-job',action:'inspect_repo',status:'done',repo:'/private/repo',
    startedAt:time,finishedAt:time,transitions:[],evidence:{stdout:'RAW SECRET'}});
  write(root,'outputs/guardian/reviews/private-review.json',{reviewId:'private-review',workerJobId:'private-job',verdict:'PASS',
    reviewedAt:time,policyVersion:'guardian-evidence-v0.1',findings:[{message:'RAW SECRET'}],summary:'RAW SECRET'});
  vi.spyOn(process,'cwd').mockReturnValue(root);
  const sources = createLocalReadSources();
  return {root,sources,adapter:createGuardianReadAdapter(sources,()=>new Date(time))};
}
function contents(root: string): Record<string,string> {
  const result: Record<string,string> = {};
  function walk(dir: string) {
    for (const name of fs.readdirSync(dir)) {
      const p=path.join(dir,name),s=fs.lstatSync(p);
      if(s.isDirectory()) walk(p);
      else if(s.isFile()) result[path.relative(root,p)]=fs.readFileSync(p).toString('hex');
    }
  }
  walk(root); return result;
}
afterEach(()=>{vi.restoreAllMocks(); for(const root of roots.splice(0)) fs.rmSync(root,{recursive:true,force:true});});

describe('fixed local read capabilities (filesystem integration)',()=>{
  it('uses the existing Ops projection, correlates Guardian, and performs no writes or execution',async()=>{
    const f=fixture(),before=contents(f.root);
    const network=vi.spyOn(globalThis,'fetch'),execute=vi.spyOn(cp,'execFileSync');
    const projected=await f.sources.operational(new Date(time));
    expect(projected.snapshot.jobs[0].guardianVerdict).toBe('PASS');
    expect(projected.snapshot.guardianReviews[0].findingsCount).toBe(1);
    const runtime=await f.adapter.get_runtime_status();
    expect(runtime).toMatchObject({ok:true,data:{worker:{status:'offline'}}});
    const jobs=await f.adapter.list_recent_jobs();
    expect(jobs).toMatchObject({ok:true,data:{total:1,items:[{guardianVerdict:'PASS'}]}});
    expect(JSON.stringify([runtime,jobs,await f.adapter.get_guardian_summary()])).not.toMatch(/private|RAW SECRET|stdout|summary/);
    expect(contents(f.root)).toEqual(before);
    expect(network).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });
  it('captures the host root once and accepts no request-selected source',async()=>{
    const f=fixture(); vi.mocked(process.cwd).mockReturnValue('/unrelated/nonexistent');
    expect(await f.adapter.list_recent_jobs()).toMatchObject({ok:true,data:{total:1}});
    expect(await f.adapter.list_recent_jobs({cwd:f.root})).toMatchObject({error:{code:'INVALID_ARGUMENTS'}});
    expect(await f.adapter.get_mission_snapshot({path:MISSION_EXPORT})).toMatchObject({error:{code:'INVALID_ARGUMENTS'}});
  });
  it('reads the real sb-mission/1 exporter without approval, mutation or reauthorization',async()=>{
    const f=fixture();
    const store=new ApprovalStore(path.join(f.root,'private-store'));
    store.initialize({repositoryAliases:['MISSION-TEST'],allowedActions:['diagnose']});
    const supervised=createSupervisedFixture(store);
    const destination=path.join(f.root,MISSION_EXPORT); fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
    exportBoardSnapshot(store,supervised.fixtureId,destination);
    const before=contents(f.root),network=vi.spyOn(globalThis,'fetch'),execute=vi.spyOn(cp,'execFileSync');
    const result=await createGuardianReadAdapter(f.sources).get_mission_snapshot();
    expect(result).toMatchObject({ok:true,executionAuthorized:false,data:{sourceSchema:'sb-mission/1',executionAuthorized:false,
      mission:{repositoryAlias:'MISSION-TEST',authorizations:[],observations:[]}}});
    expect(JSON.stringify(result)).not.toContain(supervised.fixtureId);
    expect(contents(f.root)).toEqual(before); expect(network).not.toHaveBeenCalled(); expect(execute).not.toHaveBeenCalled();
  });
  it('distinguishes absent sources from existing empty collections',async()=>{
    const f=fixture(); fs.rmSync(path.join(f.root,'outputs'),{recursive:true});
    expect(await f.adapter.get_runtime_status()).toMatchObject({ok:true,data:{worker:{status:'unknown',heartbeat:'unknown'}}});
    expect(await f.adapter.list_recent_jobs()).toMatchObject({error:{code:'SOURCE_UNAVAILABLE'}});
    expect(await f.adapter.get_mission_snapshot()).toMatchObject({error:{code:'SOURCE_UNAVAILABLE'}});
    fs.mkdirSync(path.join(f.root,'outputs/worker/jobs'),{recursive:true});
    expect(await f.adapter.list_recent_jobs()).toMatchObject({ok:true,data:{total:0,truncated:false}});
  });
  it.each(['invalid-json','null','array','wrong-shape'])('fails closed when projection would swallow %s',async kind=>{
    const f=fixture(),file=path.join(f.root,'outputs/worker/jobs/private-job.json');
    fs.writeFileSync(file,kind==='invalid-json'?'{':kind==='null'?'null':kind==='array'?'[]':'{"jobId":17}');
    const result=await f.adapter.list_recent_jobs();
    expect(result).toMatchObject({ok:false,error:{code:'SOURCE_INVALID'}});
    expect(JSON.stringify(result)).not.toContain(f.root);
  });
  it.each(['file-symlink','directory-symlink','hardlink'])('rejects %s instead of following it',async kind=>{
    const f=fixture(),file=path.join(f.root,'outputs/worker/jobs/private-job.json');
    const other=path.join(f.root,'secret.json'); fs.writeFileSync(other,'{"secret":"never return"}');
    if(kind==='directory-symlink') {
      fs.rmSync(path.join(f.root,'outputs/worker/jobs'),{recursive:true});
      fs.symlinkSync(f.root,path.join(f.root,'outputs/worker/jobs'));
    } else {
      fs.unlinkSync(file);
      if(kind==='file-symlink')fs.symlinkSync(other,file);else fs.linkSync(other,file);
    }
    expect(await f.adapter.list_recent_jobs()).toMatchObject({ok:false,error:{code:'SOURCE_INVALID'}});
  });
  it('bounds file bytes before parsing',async()=>{
    const f=fixture(); fs.writeFileSync(path.join(f.root,'outputs/worker/jobs/private-job.json'),' '.repeat(READ_LIMITS.fileBytes+1));
    expect(await f.adapter.list_recent_jobs()).toMatchObject({error:{code:'SOURCE_LIMIT_EXCEEDED'}});
  });
  it('returns a safe unavailable error for unreadable files',async()=>{
    const f=fixture(),file=path.join(f.root,'outputs/worker/jobs/private-job.json');
    fs.chmodSync(file,0o000);
    try {
      expect(await f.adapter.list_recent_jobs()).toMatchObject({ok:false,error:{code:'SOURCE_UNAVAILABLE'}});
    } finally {fs.chmodSync(file,0o600);}
  });
  it('rejects a non-array Guardian findings field rather than counting its characters',async()=>{
    const f=fixture(),file=path.join(f.root,'outputs/guardian/reviews/private-review.json');
    const review=JSON.parse(fs.readFileSync(file,'utf8'));review.findings='private malformed findings';
    fs.writeFileSync(file,JSON.stringify(review));
    expect(await f.adapter.get_guardian_summary()).toMatchObject({error:{code:'SOURCE_INVALID'}});
  });
  it('rejects malformed and symlinked mission exports without exposing their path',async()=>{
    const f=fixture(),file=path.join(f.root,MISSION_EXPORT);
    fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,'{');
    expect(await f.adapter.get_mission_snapshot()).toMatchObject({error:{code:'SOURCE_INVALID'}});
    fs.unlinkSync(file); fs.symlinkSync(path.join(f.root,'outputs/worker/worker-status.json'),file);
    const result=await f.adapter.get_mission_snapshot();
    expect(result).toMatchObject({error:{code:'SOURCE_INVALID'}});expect(JSON.stringify(result)).not.toContain(f.root);
  });
  it('bounds total bytes and directory entries without partial success',async()=>{
    const f=fixture();
    for(let i=0;i<17;i++)write(f.root,`outputs/worker/jobs/large-${i}.json`,{jobId:`id-${i}`,action:'inspect_repo',status:'done',
      requiresHumanReview:false,raw:'x'.repeat(250000)});
    expect(await f.adapter.list_recent_jobs()).toMatchObject({error:{code:'SOURCE_LIMIT_EXCEEDED'}});
    for(let i=0;i<READ_LIMITS.maxRecords;i++)fs.writeFileSync(path.join(f.root,`outputs/worker/jobs/empty-${i}.json`),'{}');
    expect(await f.adapter.list_recent_jobs()).toMatchObject({error:{code:'SOURCE_LIMIT_EXCEEDED'}});
  });
});
