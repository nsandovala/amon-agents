import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ApprovalStore } from '../mission/approval-store';
import { approvalContext } from '../mission/approval-host';
import { canPerform } from '../mission/state';
import { EvidenceContract, MissionContract, isEvidence, parseMission, planHash, safeId } from '../mission/contracts';
import { captureIntegrity, safeRelative } from '../standards/integrity';
import { scopeGate } from '../standards/gates';
import { GuardianFinding, GuardianReview } from './types';
import { GUARDIAN_POLICY_VERSION, verdictFor } from './evidence-gate';
import { assertPrePrGitInspectionSafe, gitRead, gitReadRaw as readGitRaw, inside, readPrePrIndexBlobs, requireRelease, sha256 } from './release-source';

// Recheck at every content-inspection boundary, including the final stability read.
// Other commands below only inspect repository/index metadata.
function gitReadRaw(root:string,...args:string[]):string {
  if (args[0]==='status' || args[0]==='diff' || (args[0]==='--literal-pathspecs' && args[1]==='diff'))
    assertPrePrGitInspectionSafe(root);
  return readGitRaw(root,...args);
}

/** Trusted host configuration, never extracted from a diff, worker report or reviewer text.
 * Reviewer IDs must come from an authenticated host adapter, not a model's self-identification. */
export interface PrePrPolicy {
  root: string; repositoryUrl: string; mission: MissionContract; assignmentId: string;
  storeDirectory: string; authorId: string; independentReviewerIds: string[];
  requiredChecks: string[]; missionEvidenceRecords?: string[];
}
interface CandidateContent {
  root: string; repositoryUrl: string; branch: string; baseSha: string; headSha: string;
  policySha256: string; index: string; status: string; changedFiles: string[];
  diff: {committed: string; staged: string; unstaged: string};
  files: ReturnType<typeof captureIntegrity>['entries'];
  rawWorktreeChanges: {path:string;indexMode:string;indexOid:string;indexContentBase64:string}[];
}
interface Candidate {
  kind: 'guardian-prepr-candidate/1'; candidateId: string; frozenAt: string; content: CandidateContent;
}
interface CheckRecord {
  kind: 'guardian-prepr-check/1'; candidateId: string; checkId: string;
  startedAt: string; finishedAt: string; exitCode: number|null; outputSha256: string;
  evidence: EvidenceContract; authorizationIds: string[];
}
export interface DefectHypothesis {
  finding: GuardianFinding; hypothesis: string; counterexample: string; reproduction: string;
}
interface ReviewRecord {
  kind: 'guardian-prepr-review/1'; candidateId: string; reviewerId: string;
  role: 'developer'|'independent'; review: GuardianReview; hypotheses: DefectHypothesis[];
}
export interface PrePrDecision {
  review: GuardianReview; candidateId?: string;
  adversarialStatus: 'NOT_REVIEWED'|'REVIEWED'; publicationAuthorized: false;
}
const stamp=(clock:()=>Date) => {
  const time=clock();requireRelease(Number.isFinite(time.getTime()),'PREPR_INVALID_CLOCK');return time.toISOString();
};
const errorCode=(e:unknown) => e instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(e.message) ? e.message : 'PREPR_INSPECTION_FAILED';
const validTime=(v:unknown):v is string => typeof v==='string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString()===v;
const validFinding=(f:any):f is GuardianFinding => f && safeId(f.code) && ['info','warn','error','human_review'].includes(f.severity) && typeof f.message==='string' && f.message.trim().length>0;
const fail=(code:string):GuardianFinding => ({code,severity:'error',message:code});
function host(input: PrePrPolicy) {
  const policy=structuredClone(input), mission=parseMission(policy.mission);
  const assignment=mission.assignments.find(a=>a.assignmentId===policy.assignmentId);
  requireRelease(assignment && assignment.expectedOutputs.files_to_touch.length>0,'PREPR_SCOPE_MISSING');
  requireRelease(safeId(policy.authorId) && Array.isArray(policy.independentReviewerIds) &&
    policy.independentReviewerIds.every(id=>safeId(id) && id!==policy.authorId) &&
    new Set(policy.independentReviewerIds).size===policy.independentReviewerIds.length,'PREPR_REVIEWER_POLICY_INVALID');
  requireRelease(Array.isArray(policy.requiredChecks) && policy.requiredChecks.length>0 &&
    policy.requiredChecks.every(safeId) && new Set(policy.requiredChecks).size===policy.requiredChecks.length,'PREPR_CHECK_POLICY_INVALID');
  const root=fs.realpathSync(policy.root), store=new ApprovalStore(policy.storeDirectory);
  requireRelease(!inside(root,fs.realpathSync(store.directory)),'PREPR_STORE_INSIDE_SOURCE');
  requireRelease(assignment!.expectedOutputs.files_to_touch.every(safeRelative),'PREPR_UNSAFE_SCOPE');
  // Bind every host requirement, including principal identities and evidence provenance.
  const policySha256=sha256(JSON.stringify({root,repositoryUrl:policy.repositoryUrl,planHash:planHash(mission),
    assignmentId:policy.assignmentId,storeDirectory:store.directory,authorId:policy.authorId,
    reviewers:policy.independentReviewerIds,requiredChecks:policy.requiredChecks,
    missionEvidenceRecords:policy.missionEvidenceRecords ?? []}));
  return {policy,mission,assignment:assignment!,root,store,policySha256};
}
const nul=(text:string) => text.split('\0').filter(Boolean);
function indexEntries(index:string) {
  requireRelease(index==='' || index.endsWith('\0'),'PREPR_INDEX_UNSUPPORTED');
  const entries=new Map<string,{mode:string;oid:string}>();
  for(const row of nul(index)){
    const m=/^([0-7]{6}) ([a-f0-9]{40}) ([0-3])\t([\s\S]+)$/.exec(row);
    requireRelease(m && m[3]==='0','PREPR_INDEX_UNSUPPORTED');
    requireRelease(m![1]!=='160000','PREPR_SUBMODULE_UNSUPPORTED');
    requireRelease(['100644','100755','120000'].includes(m![1]) && !entries.has(m![4]),'PREPR_INDEX_UNSUPPORTED');
    entries.set(m![4],{mode:m![1],oid:m![2]});
  }
  requireRelease(entries.size<=5000,'PREPR_INDEX_UNSUPPORTED');return entries;
}
function requireSourcePaths(paths:string[]) {
  requireRelease(paths.every(f=>safeRelative(f) && !f.includes('\ufffd')),'PREPR_UNSAFE_PATH');
  requireRelease(paths.every(f=>!f.split('/').some(p=>p!=='.env.example' && /^\.env(?:\.|$)/i.test(p))),'PREPR_ENV_FILE_UNSUPPORTED');
}
function snapshot(input: PrePrPolicy, expected?:CandidateContent): CandidateContent {
  const h=host(input), {root,mission}=h;
  assertPrePrGitInspectionSafe(root);
  requireRelease(gitRead(root,'rev-parse','--show-object-format')==='sha1','PREPR_OBJECT_FORMAT_UNSUPPORTED');
  requireRelease(gitRead(root,'rev-parse','--show-toplevel')===root,'PREPR_ROOT_MISMATCH');
  const branch=gitRead(root,'symbolic-ref','--short','HEAD'), headSha=gitRead(root,'rev-parse','HEAD');
  requireRelease(branch===mission.branch,'PREPR_BRANCH_MISMATCH');
  requireRelease(gitRead(root,'remote','get-url','origin')===h.policy.repositoryUrl,'PREPR_REPOSITORY_MISMATCH');
  gitRead(root,'merge-base','--is-ancestor',mission.baseSha,headSha);
  const index=gitReadRaw(root,'ls-files','--stage','-z');
  requireRelease(gitReadRaw(root,'ls-files','--unmerged','-z')==='','PREPR_UNMERGED_INDEX');
  const tracked=indexEntries(index);
  const ignored=nul(gitReadRaw(root,'ls-files','--others','--ignored','--exclude-standard','-z','--','.',
    ...['node_modules','dist','coverage','.next','.execution-qa','outputs'].map(p=>`:(exclude)${p}/**`)));
  const untracked=nul(gitReadRaw(root,'ls-files','--others','--exclude-standard','-z'));
  const files=[...new Set([...tracked.keys(),...untracked,...ignored])];
  const nameArgs=['--no-ext-diff','--no-textconv','--no-renames','--ignore-submodules=none','--submodule=short','--name-only','-z'];
  // Tree/index-only path reads precede source capture. No worktree status/diff yet.
  const knownChanges=new Set([
    ...nul(gitReadRaw(root,'diff',...nameArgs,mission.baseSha,headSha,'--')),
    ...nul(gitReadRaw(root,'diff',...nameArgs,'--cached','--ita-visible-in-index','--')),...untracked,...ignored,
  ]);
  requireSourcePaths([...files,...knownChanges]);
  const capture=captureIntegrity(root,files,knownChanges,{gitBlobHashes:true,allowMissing:true});
  requireRelease(!capture.errors.some(e=>e.endsWith('INTEGRITY_SIZE_LIMIT')),'PREPR_SOURCE_TOO_LARGE');
  requireRelease(capture.errors.length===0,'PREPR_INTEGRITY_UNSAFE');
  requireRelease(capture.missing!.every(f=>tracked.has(f)),'PREPR_CONTENT_CHANGED');
  // On reuse, compare physical identity before materializing any new preimages.
  // A formerly unchanged large file must invalidate the old candidate, not first
  // fail an export-size check while constructing evidence for different content.
  if(expected){
    const identities=(entries:CandidateContent['files'])=>entries.map(({contentBase64,...identity})=>identity);
    requireRelease(index===expected.index && JSON.stringify(identities(capture.entries))===JSON.stringify(identities(expected.files)),
      'PREPR_CONTENT_CHANGED');
  }
  const byPath=new Map(capture.entries.map(e=>[e.path,e]));
  const physicalChanges=[...tracked].filter(([file,indexEntry])=>{
    const entry=byPath.get(file);if(!entry)return true;
    requireRelease(entry.kind!=='directory','PREPR_TRACKED_TYPE_UNSUPPORTED');
    return entry.kind!==(indexEntry.mode==='120000'?'symlink':'file') || entry.gitBlobOid!==indexEntry.oid ||
      (entry.kind==='file' && entry.mode!==Number.parseInt(indexEntry.mode.slice(-3),8));
  }).map(([file])=>file).sort();
  // Raw local blob hashes and physical modes are authoritative for scope even when
  // Git normalizes content or ignores permissions. Git's lists only ADD evidence.
  const status=gitReadRaw(root,'status','--porcelain=v1','-z','--untracked-files=all','--ignore-submodules=none');
  const changedFiles=[...new Set([...knownChanges,...physicalChanges,
    ...nul(gitReadRaw(root,'diff',...nameArgs,'--'))])].sort();
  requireSourcePaths(changedFiles);
  const allowed=h.assignment.expectedOutputs.files_to_touch;
  requireRelease(changedFiles.every(f=>allowed.includes(f)),'PREPR_OUT_OF_SCOPE');
  readPrePrIndexBlobs(root,[...tracked.values()].map(e=>e.oid)); // Missing unchanged blobs also block; never fetch.
  const additional=changedFiles.filter(f=>!knownChanges.has(f) && byPath.get(f)?.kind==='file');
  const extra=captureIntegrity(root,additional,new Set(additional),{gitBlobHashes:true});
  requireRelease(extra.errors.length===0,'PREPR_CONTENT_CHANGED');
  for(const entry of extra.entries){
    const {contentBase64,...identity}=entry;
    requireRelease(JSON.stringify(identity)===JSON.stringify(byPath.get(entry.path)),'PREPR_CONTENT_CHANGED');
    byPath.set(entry.path,entry);
  }
  capture.entries=capture.entries.map(e=>byPath.get(e.path)!);
  // Supply exact preimage bytes only for physically changed tracked files. Never
  // reconstruct a normalized "raw" patch or ask the reviewer to fetch mutable data.
  const preimages=readPrePrIndexBlobs(root,physicalChanges.map(f=>tracked.get(f)!.oid),true);
  const rawWorktreeChanges=physicalChanges.map(file=>({path:file,indexMode:tracked.get(file)!.mode,
    indexOid:tracked.get(file)!.oid,indexContentBase64:preimages.get(tracked.get(file)!.oid)!.toString('base64')}));
  // Valid internal links are recorded as links; reject changed links into unapproved targets.
  const changedRealPaths=changedFiles.map(f=> {
    const entry=capture.entries.find(e=>e.path===f);
    return entry?.kind==='symlink' ? fs.realpathSync(path.join(root,f)) : path.join(root,f);
  });
  requireRelease(scopeGate({root,changedRealPaths,allowedRealPaths:allowed.map(f=>path.join(root,f)),roadmaps:[]}).verdict==='PASS','PREPR_LINK_OUT_OF_SCOPE');
  // Literal pathspecs prevent a filename from expanding the vetted scope. Unchanged
  // bytes are represented by hashes; changed bytes and all three exact diffs are retained.
  const readDiff=(...revisions:string[])=>{
    if (!changedFiles.length) return '';
    try {return gitReadRaw(root,'--literal-pathspecs','diff','--no-ext-diff','--no-textconv','--no-renames',
      '--ignore-submodules=none','--submodule=short','--binary','--full-index',...revisions,'--',...changedFiles);}
    catch(e) {
      if (['ENOBUFS','ERR_CHILD_PROCESS_STDIO_MAXBUFFER'].includes((e as NodeJS.ErrnoException).code ?? '')) throw new Error('PREPR_DIFF_TOO_LARGE');
      throw e;
    }
  };
  const diff={committed:readDiff(mission.baseSha,headSha),staged:readDiff('--cached','--ita-visible-in-index'),unstaged:readDiff()};
  requireRelease(gitReadRaw(root,'ls-files','--stage','-z')===index &&
    gitReadRaw(root,'status','--porcelain=v1','-z','--untracked-files=all','--ignore-submodules=none')===status,'PREPR_CONTENT_CHANGED');
  return {root,repositoryUrl:h.policy.repositoryUrl,branch,headSha,baseSha:mission.baseSha,policySha256:h.policySha256,
    index,status,changedFiles,diff,files:capture.entries,rawWorktreeChanges};
}
function current(input:PrePrPolicy, name:string):Candidate {
  const h=host(input), c=h.store.readExecutionRecord(name) as Candidate;
  requireRelease(c?.kind==='guardian-prepr-candidate/1' && validTime(c.frozenAt) && c.content?.policySha256===h.policySha256 &&
    c.candidateId===sha256(JSON.stringify(c.content)),'PREPR_CANDIDATE_INVALID');
  requireRelease(sha256(JSON.stringify(snapshot(input,c.content)))===c.candidateId,'PREPR_CONTENT_CHANGED');
  return c;
}
/** Freezes read-only evidence, not an approval. All bytes/modes, index and diff layers
 * are signed in the existing store (unchanged bytes by digest). No checkout, index mutation or model invocation. */
export function freezePrePrCandidate(input:PrePrPolicy, clock=()=>new Date()):string {
  const policy=structuredClone(input), content=snapshot(policy);
  requireRelease(JSON.stringify(snapshot(policy))===JSON.stringify(content),'PREPR_CONTENT_CHANGED');
  const candidate:Candidate={kind:'guardian-prepr-candidate/1',candidateId:sha256(JSON.stringify(content)),frozenAt:stamp(clock),content};
  const name=`fixture-${randomUUID()}`;
  try {host(policy).store.writeExecutionRecord(name,candidate);}
  catch(e) {
    if (e instanceof Error && e.message==='EXECUTION_RECORD_TOO_LARGE') throw new Error('PREPR_CANDIDATE_TOO_LARGE');
    throw e;
  }
  return name;
}
/** Data-only packet; contains no store key, authorizations or execution capability.
 * A reviewer gets an independent copy. Changes to that copy cannot change the signed candidate. */
export function prePrReviewPacket(input:PrePrPolicy, name:string) {
  const candidate=current(input,name), h=host(input);
  return structuredClone({candidateId:candidate.candidateId,repositoryUrl:candidate.content.repositoryUrl,
    branch:candidate.content.branch,baseSha:candidate.content.baseSha,headSha:candidate.content.headSha,
    diff:candidate.content.diff,changedFiles:candidate.content.changedFiles,rawWorktreeChanges:candidate.content.rawWorktreeChanges,
    files:candidate.content.files.filter(f=>candidate.content.changedFiles.includes(f.path)),
    criteria:h.assignment.expectedOutputs,permissions:{modifyCode:false,modifyRequirements:false,authorize:false}});
}
/** Shared live authorization check: no worker-supplied completion or approval state.
 * IDs bind receipts to the grants selected by the existing mission contracts. */
function requireVerificationAuthorization(h:ReturnType<typeof host>,at:string):string[] {
  const evidence=(h.policy.missionEvidenceRecords ?? []).map(n=>h.store.readExecutionRecord(n));
  requireRelease(evidence.every(isEvidence),'PREPR_MISSION_EVIDENCE_INVALID');
  requireRelease((evidence as EvidenceContract[]).every(e=>e.source==='assignment' && e.status==='done' &&
    e.missionId===h.mission.missionId && e.planHash===planHash(h.mission) && e.verifiedBaseSha===h.mission.baseSha &&
    e.verifiedBranch===h.mission.branch && h.mission.assignments.some(a=>a.assignmentId===e.assignmentId) &&
    e.observedAt<=at),'PREPR_MISSION_EVIDENCE_INVALID');
  const permission=canPerform(h.mission,h.policy.assignmentId,'verify',approvalContext(h.store,new Date(at),evidence as EvidenceContract[]));
  requireRelease(permission.ok,permission.errors[0] ?? 'PREPR_NOT_AUTHORIZED');
  const selected=permission.checks.filter(c=>c.code==='AUTHORIZATION_SELECTED');
  for (const e of evidence as EvidenceContract[]) {
    const grant=selected.find(c=>c.assignmentId===e.assignmentId && c.action===e.action);
    requireRelease(grant && e.observedAt>=String(grant.facts.approvedAt) && e.observedAt<String(grant.facts.expiresAt),'PREPR_MISSION_EVIDENCE_INVALID');
  }
  return [...new Set(selected.map(c=>String(c.facts.authorizationId)))].sort();
}
/** Trusted host wrapper for a deterministic check; authorization precedes invocation.
 * The callback and check ID must come from host configuration, never a model/worker request.
 * Read-only preflight/candidate inspection stays outside this action boundary.
 * A crash or thrown callback leaves the immutable attempt without a result: fail closed. */
export async function recordPrePrCheck(input:PrePrPolicy, name:string, checkId:string,
  execute:()=>Promise<{exitCode:number|null;output:string}>,clock=()=>new Date()):Promise<string> {
  const policy=structuredClone(input), h=host(policy), c=current(policy,name);
  requireRelease(h.policy.requiredChecks.includes(checkId),'PREPR_UNKNOWN_CHECK');
  let startedAt!:string,authorizationIds!:string[],execution!:Promise<{exitCode:number|null;output:string}>;
  const id=randomUUID();
  // Serialize the synchronous permission/attempt/invocation boundary with approval writers.
  // Do not hold the store lock over the asynchronous check.
  h.store.exclusive(()=>{
    startedAt=stamp(clock);requireRelease(startedAt>=c.frozenAt,'PREPR_INVALID_CLOCK');
    authorizationIds=requireVerificationAuthorization(h,startedAt);
    h.store.writeExecutionRecord(`attempt-${id}`,{kind:'guardian-prepr-attempt/1',candidateId:c.candidateId,checkId,startedAt,authorizationIds});
    execution=execute();
  });
  const result=await execution,finishedAt=stamp(clock);
  requireRelease(finishedAt>=startedAt,'PREPR_INVALID_CLOCK');
  current(policy,name);
  requireRelease(JSON.stringify(requireVerificationAuthorization(h,finishedAt))===JSON.stringify(authorizationIds),'PREPR_CHECK_AUTHORIZATION_CHANGED');
  requireRelease((result.exitCode===null || Number.isSafeInteger(result.exitCode)) && typeof result.output==='string','PREPR_CHECK_INVALID');
  const recordName=`result-${id}`;
  const evidence:EvidenceContract={source:'assignment',jobId:recordName,action:'verify',status:result.exitCode===0?'done':'failed',
    observedAt:finishedAt,verifiedBaseSha:h.mission.baseSha,verifiedBranch:h.mission.branch,evidenceReference:recordName,
    missionId:h.mission.missionId,assignmentId:h.policy.assignmentId,planHash:planHash(h.mission)};
  h.store.writeExecutionRecord(recordName,{kind:'guardian-prepr-check/1',candidateId:c.candidateId,checkId,startedAt,finishedAt,
    exitCode:result.exitCode,outputSha256:sha256(result.output),evidence,authorizationIds} satisfies CheckRecord);
  return recordName;
}
/** The trusted adapter supplies the authenticated principal; hypotheses are untrusted data.
 * No model-supplied verdict or "resolved" bit is accepted. A blocking finding stays attached
 * to this candidate; changing code requires a fresh candidate, tests and independent review. */
export function recordPrePrReview(input:PrePrPolicy,name:string,principal:string,role:'developer'|'independent',
  hypotheses:DefectHypothesis[],clock=()=>new Date()):string {
  const h=host(input), c=current(input,name);
  requireRelease(role==='developer' ? principal===h.policy.authorId : role==='independent' &&
    principal!==h.policy.authorId && h.policy.independentReviewerIds.includes(principal),'PREPR_REVIEWER_NOT_AUTHORIZED');
  requireRelease(Array.isArray(hypotheses) && hypotheses.length<=100 && hypotheses.every(x=>x &&
    ['info','warn','error','human_review'].includes(x.finding?.severity) && safeId(x.finding.code) &&
    [x.finding.message,x.hypothesis,x.counterexample,x.reproduction].every(v=>typeof v==='string' && v.trim().length>0 && v.length<=16000)),
    'PREPR_REVIEW_INVALID');
  const reviewedAt=stamp(clock);requireRelease(reviewedAt>=c.frozenAt,'PREPR_INVALID_CLOCK');
  const id=`result-${randomUUID()}`, findings=hypotheses.map(x=>x.finding),verdict=verdictFor(findings);
  const review:GuardianReview={reviewId:id,workerJobId:c.candidateId,verdict,reviewedAt,policyVersion:GUARDIAN_POLICY_VERSION,
    findings,summary:`${role}: ${findings.length} findings; no publication authority`};
  h.store.writeExecutionRecord(id,{kind:'guardian-prepr-review/1',candidateId:c.candidateId,reviewerId:principal,role,review,hypotheses} satisfies ReviewRecord);
  return id;
}
/** Read-only evaluation of ALL signed candidate receipts, preventing cherry-picking a clean
 * review or hiding a failed/unfinished check. PASS is never commit/push/merge authorization. */
export function reviewPrePr(input:PrePrPolicy,name:string,clock=()=>new Date()):PrePrDecision {
  const findings:GuardianFinding[]=[];let candidateId:string|undefined,adversarialStatus:PrePrDecision['adversarialStatus']='NOT_REVIEWED';
  const reviewedAt=stamp(clock);
  try {
    const h=host(input), c=current(input,name);candidateId=c.candidateId;
    requireRelease(reviewedAt>=c.frozenAt,'PREPR_INVALID_CLOCK');
    const names=fs.readdirSync(h.store.directory).filter(n=>/^(attempt|result)-[a-f0-9-]{36}\.json$/.test(n));
    requireRelease(names.length<=2000,'PREPR_RECORD_LIMIT');
    const records=names.map(n=>({name:n.slice(0,-5),value:h.store.readExecutionRecord(n.slice(0,-5)) as any})).filter(r=>r.value?.candidateId===candidateId);
    for (const checkId of h.policy.requiredChecks) {
      const attempts=records.filter(r=>r.value.kind==='guardian-prepr-attempt/1' && r.value.checkId===checkId);
      const checks=records.filter(r=>r.value.kind==='guardian-prepr-check/1' && r.value.checkId===checkId);
      if (!attempts.length || !checks.length) findings.push(fail('PREPR_CHECK_MISSING'));
      for (const attempt of attempts) if (!checks.some(r=>r.name===attempt.name.replace('attempt-','result-'))) findings.push(fail('PREPR_CHECK_UNFINISHED'));
      for (const {name:recordName,value:r} of checks) {
        requireRelease(attempts.some(a=>a.name===recordName.replace('result-','attempt-') && a.value.startedAt===r.startedAt),'PREPR_CHECK_INVALID');
        requireRelease(isEvidence(r.evidence) && r.evidence.source==='assignment' && r.evidence.missionId===h.mission.missionId &&
          r.evidence.assignmentId===h.policy.assignmentId && r.evidence.planHash===planHash(h.mission) &&
          r.evidence.verifiedBaseSha===h.mission.baseSha && r.evidence.verifiedBranch===h.mission.branch &&
          r.evidence.observedAt===r.finishedAt && r.evidence.action==='verify' && r.evidence.evidenceReference===recordName &&
          validTime(r.startedAt) && validTime(r.finishedAt) && /^[a-f0-9]{64}$/.test(r.outputSha256) &&
          r.startedAt>=c.frozenAt && r.startedAt<=r.finishedAt && r.finishedAt<=reviewedAt,'PREPR_CHECK_INVALID');
        // Legacy/unbound receipts cannot acquire authorization from a later grant or test.
        requireRelease(Array.isArray(r.authorizationIds) && r.authorizationIds.length>0 &&
          attempts.some(a=>a.name===recordName.replace('result-','attempt-') && JSON.stringify(a.value.authorizationIds)===JSON.stringify(r.authorizationIds)) &&
          JSON.stringify(requireVerificationAuthorization(h,r.startedAt))===JSON.stringify(r.authorizationIds) &&
          JSON.stringify(requireVerificationAuthorization(h,r.finishedAt))===JSON.stringify(r.authorizationIds),'PREPR_CHECK_AUTHORIZATION_INVALID');
        if (r.exitCode!==0 || r.evidence.status!=='done') findings.push(fail('PREPR_CHECK_FAILED'));
      }
    }
    for (const {name:recordName,value:r} of records.filter(r=>r.value.kind==='guardian-prepr-review/1')) {
      requireRelease(r.review?.reviewId===recordName && validTime(r.review.reviewedAt) &&
        Array.isArray(r.review.findings) && r.review.findings.every(validFinding) && Array.isArray(r.hypotheses) &&
        JSON.stringify(r.hypotheses.map((x:DefectHypothesis)=>x.finding))===JSON.stringify(r.review.findings) && r.review.reviewedAt>=c.frozenAt && r.review.reviewedAt<=reviewedAt &&
        r.review.workerJobId===c.candidateId && r.review.policyVersion===GUARDIAN_POLICY_VERSION &&
        r.review.verdict===verdictFor(r.review.findings),'PREPR_REVIEW_INVALID');
      const independent=r.role==='independent' && r.reviewerId!==h.policy.authorId && h.policy.independentReviewerIds.includes(r.reviewerId);
      requireRelease(independent || r.role==='developer' && r.reviewerId===h.policy.authorId,'PREPR_REVIEWER_NOT_AUTHORIZED');
      if (independent) adversarialStatus='REVIEWED';
      findings.push(...r.review.findings);
    }
    requireVerificationAuthorization(h,reviewedAt);
  } catch(e) {findings.push(fail(errorCode(e)));}
  if (adversarialStatus==='NOT_REVIEWED') findings.push({code:'PREPR_NOT_REVIEWED',severity:'human_review',message:'Independent adversarial review is NOT_REVIEWED; human approval remains pending'});
  const verdict=verdictFor(findings);
  return {review:{reviewId:`PREPR-${randomUUID()}`,workerJobId:candidateId ?? 'UNKNOWN',verdict,reviewedAt,policyVersion:GUARDIAN_POLICY_VERSION,
    findings,summary:`${verdict}; ${adversarialStatus}; no publication authority`},candidateId,adversarialStatus,publicationAuthorized:false};
}
