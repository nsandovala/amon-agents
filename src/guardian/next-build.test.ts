import { describe, expect, it } from 'vitest';
import { spawnSync } from 'child_process';
import { reviewNextBuildEvidence, NextBuildPolicy } from './next-build';
import { nextFixture, digest } from './fixtures/next-release';

function setup(version?: string) {
  const f = nextFixture(version);
  const policy: NextBuildPolicy = {...f.policy.nextBuild,...f.policy};
  return {...f,policy,review:(e: unknown = f.build) => reviewNextBuildEvidence(e,policy)};
}

describe('Next build observations (synthetic, no Next app execution)', () => {
  it('accepts complete bound evidence; security result is scoped to the supplied advisory', () => {
    const r = setup().review();
    expect(r.verdict).toBe('PASS');
    expect(r.resolvedVersion).toBe('15.1.2');
    expect(r.security[0].status).toBe('not_affected');
  });
  it('reproduces a real child-process nonzero exit after apparent compilation', () => {
    const {build,review} = setup();
    const child = spawnSync(process.execPath,['-e','console.log("Compiled successfully"); process.exitCode = 1;'],{encoding:'utf8'});
    expect(child.status).toBe(1);
    const r = review({...build,exitCode:child.status,stdout:child.stdout,stderr:child.stderr});
    expect(r.findings.map(f => f.code)).toContain('NEXT_BUILD_EXIT_FAILED');
  });
  it.each([
    ['exitCode',null,'NEXT_BUILD_EXIT_FAILED'],
    ['exitCode','0','NEXT_BUILD_EXIT_FAILED'],
    ['completed',false,'NEXT_BUILD_INCOMPLETE'],
    ['logComplete',false,'NEXT_BUILD_INCOMPLETE'],
    ['timedOut',true,'NEXT_BUILD_INCOMPLETE'],
    ['signal','SIGTERM','NEXT_BUILD_INCOMPLETE'],
    ['command','next dev','NEXT_BUILD_INCOMPLETE'],
    ['finishedAt',null,'NEXT_BUILD_INCOMPLETE'],
    ['finishedAt','2026-11-17T00:00:00.000Z','NEXT_BUILD_INCOMPLETE'],
    ['startedAt','2026-11-17T00:00:00.000Z','NEXT_BUILD_INCOMPLETE'],
    ['finishedAt','2099-01-01T00:00:00.000Z','NEXT_BUILD_INCOMPLETE'],
    ['runId','another','NEXT_BUILD_REVISION_MISMATCH'],
    ['headSha','b'.repeat(40),'NEXT_BUILD_REVISION_MISMATCH'],
    ['worktreeHeadShaAfter','b'.repeat(40),'NEXT_BUILD_REVISION_MISMATCH'],
    ['treeClean',false,'NEXT_BUILD_REVISION_MISMATCH'],
    ['root','/qa/foreign','NEXT_BUILD_REVISION_MISMATCH'],
    ['branch','main','NEXT_BUILD_REVISION_MISMATCH'],
    ['nodeVersion','v20.0.0','NEXT_BUILD_ENVIRONMENT_MISMATCH'],
    ['platform','linux','NEXT_BUILD_ENVIRONMENT_MISMATCH'],
    ['lockfileSha256','b'.repeat(64),'NEXT_BUILD_ENVIRONMENT_MISMATCH'],
    ['installNodeEnv','staging','NEXT_NODE_ENV_INVALID'],
    ['installNodeEnv','production','NEXT_NODE_ENV_INVALID'],
    ['buildNodeEnv','staging','NEXT_NODE_ENV_INVALID'],
    ['buildNodeEnv','test','NEXT_NODE_ENV_INVALID'],
    ['buildNodeEnv',null,'NEXT_NODE_ENV_INVALID'],
    ['result',null,'NEXT_BUILD_RESULT_UNVERIFIED'],
    ['stderr','Error occurred prerendering page /_global-error','NEXT_BUILD_LOG_FAILURE'],
    ['stderr','⚠ Your NODE_ENV has a non-standard value','NEXT_NODE_ENV_INVALID'],
    ['stdout','\u001b[33m⚠ We detected multiple lockfiles.\u001b[0m','NEXT_TRACING_WARNING'],
    ['stderr','Warning: Failed to collect build traces','NEXT_TRACING_WARNING'],
    ['stderr','Warning: an unrecognized diagnostic','NEXT_WARNING_UNCLASSIFIED'],
  ])('blocks %s=%j with %s', (field,value,code) => {
    const {build,review} = setup();
    expect(review({...build,[field]:value}).findings.map(f => f.code)).toContain(code);
  });
  it.each([null,[],{}, {completed:true}])('fails closed on malformed evidence %j', evidence => {
    expect(setup().review(evidence).verdict).toBe('BLOCKED');
  });
  it.each(['outcome','buildId','createdAt','evidenceRef'])('requires final artifact field %s', key => {
    const {build,review} = setup();
    const artifact: Record<string,unknown> = {...build.result};
    delete artifact[key];
    expect(review({...build,result:artifact}).findings.map(f => f.code)).toContain('NEXT_BUILD_RESULT_UNVERIFIED');
  });
  it('blocks stale final output and retains source logs without echoing their contents', () => {
    const {build,review} = setup();
    const bad = {...build,result:{...build.result,createdAt:'2026-11-17T00:00:00.000Z'},stderr:'⚠ secret=example'};
    const before = JSON.stringify(bad);
    const r = review(bad);
    expect(r.verdict).toBe('BLOCKED');
    expect(JSON.stringify(bad)).toBe(before);
    expect(JSON.stringify(r)).not.toContain('secret=example');
  });
  it('rejects evidence-provided acceptance overrides', () => {
    const {build,review} = setup();
    expect(review({...build,allowWarnings:true}).verdict).toBe('BLOCKED');
  });
});

describe('resolved lockfile version and verified advisory boundaries', () => {
  it.each([
    ['13.5.7','affected'],['13.5.8','not_affected'],
    ['14.2.20','affected'],['14.2.21','not_affected'],
    ['15.0.0','affected'],['15.1.1','affected'],['15.1.2','not_affected'],
    ['15.1.2-canary.1','insufficient_information'],
  ])('%s is %s for GHSA-7m27-7ghc-44w9 only', (version,status) => {
    const r = setup(version).review();
    expect(r.security[0].status).toBe(status);
    expect(r.verdict).toBe(status === 'not_affected' ? 'PASS' : 'BLOCKED');
  });
  it.each([
    'not JSON', '{}', JSON.stringify({lockfileVersion:1,dependencies:{next:{version:'15.1.2'}}}),
    JSON.stringify({lockfileVersion:3,packages:{'':{dependencies:{next:'^15.1.2'}}}}),
    JSON.stringify({lockfileVersion:3,packages:{'node_modules/next':{version:'^15.1.2'}}}),
    JSON.stringify({lockfileVersion:3,packages:{'node_modules/next':{version:'15.1.2',link:true}}}),
    JSON.stringify({lockfileVersion:3,packages:{'node_modules/next':{version:'15.1.2'},'apps/a/node_modules/next':{version:'14.2.20'}}}),
  ])('never guesses a version from an unsupported/ambiguous lockfile', lockfileText => {
    const {policy,build} = setup();
    const r = reviewNextBuildEvidence({...build,lockfileSha256:digest(lockfileText)},{...policy,lockfileText});
    expect(r.findings.map(f => f.code)).toContain('NEXT_LOCKFILE_UNRESOLVED');
    expect(r.security[0].status).toBe('insufficient_information');
  });
  it.each([
    {body:'{}'}, {sha256:'0'.repeat(64)}, {source:'https://example.com/advisory'},
    {retrievedAt:'2026-11-17T00:00:00.000Z'}, {retrievedAt:'2099-01-01T00:00:00.000Z'},
  ])('blocks unverifiable or stale advisory metadata %j', change => {
    const {build,policy} = setup();
    policy.advisories[0] = {...policy.advisories[0],...change};
    expect(reviewNextBuildEvidence(build,policy).security[0].status).toBe('insufficient_information');
  });
  it.each([
    {withdrawn_at:'2026-01-01T00:00:00Z'}, {ghsa_id:'GHSA-xxxx-xxxx-xxxx'},
    {updated_at:'2099-01-01T00:00:00Z'}, {vulnerabilities:[]},
    {vulnerabilities:[{package:{ecosystem:'npm',name:'next'},vulnerable_version_range:'^15.0.0'}]},
    {vulnerabilities:[{package:{ecosystem:'npm',name:'next'},vulnerable_version_range:'>= 15.0.0 || nonsense'}]},
  ])('does not invent unsupported or withdrawn advisory conclusions', change => {
    const {build,policy} = setup();
    const entry = policy.advisories[0];
    entry.body = JSON.stringify({...JSON.parse(entry.body),...change});
    entry.sha256 = digest(entry.body);
    expect(reviewNextBuildEvidence(build,policy).security[0].status).toBe('insufficient_information');
  });
  it.each([[],null,undefined])('requires an explicit nonempty advisory scope %j', advisories => {
    const {build,policy} = setup();
    expect(reviewNextBuildEvidence(build,{...policy,advisories} as NextBuildPolicy).verdict).toBe('BLOCKED');
  });
  it('rejects duplicate advisories and malformed host requirements', () => {
    const {build,policy} = setup();
    policy.advisories.push(policy.advisories[0]);
    expect(reviewNextBuildEvidence(build,policy).verdict).toBe('BLOCKED');
    for (const p of [null,{}, {...policy,installNodeEnv:'staging'}])
      expect(reviewNextBuildEvidence(build,p as NextBuildPolicy).verdict).toBe('BLOCKED');
  });
});
