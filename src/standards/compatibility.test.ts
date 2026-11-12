import { describe, it, expect } from 'vitest';
import { validateOutput } from '../core/validate-json';
import { reviewWorkerJobEvidence } from '../guardian/evidence-gate';
import { CodingToolEvidence, WorkerJobState } from '../worker/types';
import { isEvidence, planHash } from '../mission/contracts';
import { canPerform, Context } from '../mission/state';
import { pilotMission } from '../mission/pilot';
import { releaseGate } from './gates';

describe('existing AA contracts remain authoritative', () => {
  it('accepts canonical handoff fields without a replacement schema', () => {
    expect(validateOutput({goal:'Local standards',scope:'AA only',files_to_touch:['.agents/skills'],
      plan:['Implement locally'],risks:['Client runtime not invoked'],validations:['Targeted tests'],
      done_when:['Human review'],executionStandardsVersion:'1.0'}).valid).toBe(true);
    expect(validateOutput({goal:'incomplete'}).valid).toBe(false);
  });
  it('a valid legacy Worker/Guardian PASS cannot substitute for missing browser/auth', () => {
    const root = '/qa/worktrees/AA-SKILLS-001';
    const headSha = 'a'.repeat(40);
    const branch = 'worker/aa-skills-001';
    const at = '2026-11-12T10:00:00.000Z';
    const evidence: CodingToolEvidence = {repoPath:'/qa/amon-agents',worktreePath:root,branch,headSha,
      gitStatusBefore:'',tool:'opencode',toolVersion:'fixture',startedAt:at,exitCode:0,stdout:'',stderr:'',
      finishedAt:at,durationMs:0,gitStatusAfter:'?? sandbox/result.md',diffStat:'',changedFiles:['sandbox/result.md'],
      diff:'',worktreeHeadShaAfter:headSha,worktreeBranchAfter:branch,expectedFile:'sandbox/result.md',
      expectedContentMatched:true,humanReview:false};
    const workerJob: WorkerJobState = {jobId:'TEST-001',action:'run_coding_tool',repo:'/qa/amon-agents',
      worktreePath:root,tool:'opencode',status:'done',exitCode:0,transitions:[{status:'done',at}],evidence};
    const legacy = reviewWorkerJobEvidence({workerJob,worktreeRoot:'/qa/worktrees'},
      {reviewId:'TEST-REVIEW',workerJobId:workerJob.jobId,reviewedAt:at});
    expect(legacy.verdict).toBe('PASS');
    const result = releaseGate({schemaVersion:'1.0',runId:'TEST-001',root,branch,headSha,observedAt:at,checks:[]},
      {runId:'TEST-001',root,branch,headSha,startedAt:at,now:at,required:['http','browser','authentication'],guardianVerdict:legacy.verdict});
    expect(result.verdict).toBe('BLOCKED');
    expect(result.reasons).toHaveLength(3);
  });
  it('reuses mission evidence validation and rejects revoked authorization at execution', () => {
    const mission = pilotMission();
    mission.assignments = [mission.assignments[0]];
    mission.status = 'approved';
    const assignment = mission.assignments[0];
    assignment.status = 'ready'; assignment.allowedActions = ['diagnose'];
    mission.authorizationPolicy.allowedActions = ['diagnose'];
    const at = '2026-11-06T12:00:00.000Z';
    const context: Context = {now:new Date(at),repositoryAliases:['BracketFlow'],approverIds:['nelson-sandoval'],
      allowedActions:['diagnose'],evidence:[],authorizations:[{
        authorizationId:'AUTH-TEST',missionId:mission.missionId,assignmentId:assignment.assignmentId,
        action:'diagnose',approvedBy:'nelson-sandoval',planVersion:mission.planVersion,planHash:planHash(mission),
        scope:assignment.scope,issuedAt:'2026-11-06T11:00:00.000Z',expiresAt:'2026-11-06T13:00:00.000Z',
        approvedAt:'2026-11-06T11:00:00.000Z',decision:'approved'}]};
    const evidence = {source:'assignment',jobId:'EVIDENCE-TEST',action:'diagnose',status:'done',observedAt:at,
      verifiedBaseSha:mission.baseSha,verifiedBranch:mission.branch,evidenceReference:'EV-TEST',
      missionId:mission.missionId,assignmentId:assignment.assignmentId,planHash:planHash(mission)};
    expect(isEvidence(evidence)).toBe(true);
    expect(isEvidence({...evidence,untrustedGrant:true})).toBe(false);
    expect(canPerform(mission,assignment.assignmentId,'diagnose',context).ok).toBe(true);
    context.authorizations[0].decision = 'revoked';
    expect(canPerform(mission,assignment.assignmentId,'diagnose',context).ok).toBe(false);
    context.authorizations[0].decision = 'approved';
    assignment.scope += ' expanded';
    expect(canPerform(mission,assignment.assignmentId,'diagnose',context).ok).toBe(false);
  });
});
