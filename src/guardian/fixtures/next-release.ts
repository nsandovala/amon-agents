import { createHash } from 'crypto';
import advisory from './next-advisory.json';

// Synthetic process/lockfile observations. The advisory is a public API excerpt,
// retrieved 2026-11-18; this fixture is NOT a live build or a current security scan.
export const digest = (s: string) => createHash('sha256').update(s).digest('hex');
export function nextFixture(version = '15.1.2') {
  const root = '/qa/reference';
  const headSha = 'a'.repeat(40);
  const branch = 'worker/next-release';
  const runId = 'NEXT-001';
  const startedAt = '2026-11-18T00:00:00.000Z';
  const finishedAt = '2026-11-18T00:01:00.000Z';
  const now = '2026-11-18T00:02:00.000Z';
  const lockfileText = JSON.stringify({lockfileVersion:3,packages:{
    '':{dependencies:{next:'^15.0.0'}},'node_modules/next':{version}}});
  const body = JSON.stringify(advisory);
  const nextBuild = {
    lockfileText, nodeVersion:'v22.22.2', platform:'darwin', installNodeEnv:null,
    advisoryNotBefore:startedAt,
    advisories:[{id:advisory.ghsa_id,source:`https://api.github.com/advisories/${advisory.ghsa_id}`,
      retrievedAt:startedAt,sha256:digest(body),body}],
  };
  const build = {runId,root,headSha,branch,worktreeHeadShaAfter:headSha,treeClean:true,
    startedAt,finishedAt,command:'next build',completed:true,exitCode:0,signal:null,
    timedOut:false,logComplete:true,stdout:'Compiled successfully\n',stderr:'',
    nodeVersion:nextBuild.nodeVersion,platform:nextBuild.platform,installNodeEnv:null,
    buildNodeEnv:'production',lockfileSha256:digest(lockfileText),
    result:{outcome:'passed',buildId:'synthetic-build',createdAt:finishedAt,evidenceRef:'synthetic:BUILD_ID'}};
  const report = {schemaVersion:'1.0',runId,root,headSha,branch,observedAt:now,checks:[],nextBuild:build};
  const policy = {runId,root,headSha,branch,startedAt,now,required:[],guardianVerdict:'PASS' as const,nextBuild};
  return {report,policy,build};
}
