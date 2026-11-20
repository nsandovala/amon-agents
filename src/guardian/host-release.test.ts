import { describe, expect, it } from 'vitest';
import { releaseGate } from '../standards/gates';
import { reviewNextBuildEvidence } from './next-build';
import { nextFixture } from './fixtures/next-release';

describe('mandatory authorized-host Next release gate', () => {
  it('classifies only the exact Next cold-cache notice, retaining all other warnings', () => {
    const {build,policy}=nextFixture();
    const notice='⚠ No build cache found. Please configure build caching for faster rebuilds. Read more: https://nextjs.org/docs/messages/no-cache';
    const requirements={...policy.nextBuild,...policy};
    const good=reviewNextBuildEvidence({...build,stdout:notice},requirements);
    expect(good.verdict).toBe('PASS');
    expect(good.findings).toContainEqual(expect.objectContaining({code:'NEXT_BUILD_CACHE_COLD',severity:'info'}));
    for (const suffix of [' with extra content','\n⚠ unknown warning'])
      expect(reviewNextBuildEvidence({...build,stdout:notice+suffix},requirements).verdict).toBe('BLOCKED');
  });
  it('blocks a declared Next release when both policy and build were omitted', () => {
    const {report,policy} = nextFixture();
    const {nextBuild: _e,...observations} = report;
    const {nextBuild: _p,...requirements} = policy;
    const host = {...requirements,releaseHost:{declaredStack:'next'}};
    expect(releaseGate(observations,host).verdict).toBe('BLOCKED');
  });
  it('does not accept worker-generated process success as a host collection', () => {
    const {report,policy} = nextFixture();
    const host = {...policy,releaseHost:{declaredStack:'next'}};
    expect(releaseGate(report,host).verdict).toBe('BLOCKED');
  });
  it('fails closed when the host declaration cannot be resolved', () => {
    const {report,policy} = nextFixture();
    const {nextBuild: _e,...observations} = report;
    const {nextBuild: _p,...requirements} = policy;
    const host = {...requirements,releaseHost:{declaredStack:'auto'}};
    expect(releaseGate(observations,host).verdict).toBe('BLOCKED');
  });
  it('retains the existing non-Next contract', () => {
    const {report,policy} = nextFixture();
    const {nextBuild: _e,...observations} = report;
    const {nextBuild: _p,...requirements} = policy;
    expect(releaseGate(observations,requirements).verdict).toBe('PASS');
  });
});
