import { describe, expect, it } from 'vitest';
import { releaseGate } from './gates';
import { nextFixture } from '../guardian/fixtures/next-release';
import { main } from './cli';
import { mkdtempSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { vi } from 'vitest';
import schema from '../../.agents/standards/contracts/release-gate.schema.json';

describe('Next release regressions (synthetic Convergence / Sentinel references)', () => {
  it('rejects apparently compiled output when the process exits with failure', () => {
    const {report,policy} = nextFixture();
    report.nextBuild.exitCode = 1;
    expect(releaseGate(report,policy).reasons).toContain('NEXT_BUILD_EXIT_FAILED');
  });
  it('requires the build even when Guardian worker evidence passed', () => {
    const {report,policy} = nextFixture();
    const {nextBuild:_,...withoutBuild} = report;
    expect(releaseGate(withoutBuild,policy).reasons).toContain('NEXT_BUILD_MISSING');
  });
  it('blocks a resolved version affected by the verified advisory', () => {
    const {report,policy} = nextFixture('15.1.1');
    expect(releaseGate(report,policy).reasons).toContain('NEXT_VERSION_AFFECTED');
  });
  it('rejects NODE_ENV=development for a production build', () => {
    const {report,policy} = nextFixture();
    report.nextBuild.buildNodeEnv = 'development';
    expect(releaseGate(report,policy).reasons).toContain('NEXT_NODE_ENV_INVALID');
  });
  it('does not discard an unclassified warning', () => {
    const {report,policy} = nextFixture();
    report.nextBuild.stderr = '⚠ An unfamiliar build warning';
    expect(releaseGate(report,policy).reasons).toContain('NEXT_WARNING_UNCLASSIFIED');
  });
  it('accepts the complete build only alongside the host runtime requirements', () => {
    const {report,policy} = nextFixture();
    expect(releaseGate(report,policy).verdict).toBe('PASS');
    const required = ['http','browser','authentication'] as const;
    expect(releaseGate(report,{...policy,required:[...required]}).reasons).toEqual([
      'REQUIRED_HTTP_UNVERIFIED','REQUIRED_BROWSER_UNVERIFIED','REQUIRED_AUTHENTICATION_UNVERIFIED']);
    expect(releaseGate(report,{...policy,guardianVerdict:'BLOCKED'}).reasons).toContain('GUARDIAN_NOT_PASS');
  });
  it('keeps the additive observation contract aligned with the accepted evidence', () => {
    const {build} = nextFixture();
    expect(Object.keys(build).sort()).toEqual([...schema.properties.nextBuild.required].sort());
    expect(Object.keys(build.result).sort()).toEqual([...schema.properties.nextBuild.properties.result.required].sort());
    expect(schema.required).not.toContain('nextBuild');
    expect(schema.properties.nextBuild.additionalProperties).toBe(false);
  });
  it('rejects self-relaxation, absent host policy and invalid Next requirements', () => {
    const {report,policy} = nextFixture();
    const {nextBuild:_,...legacy} = policy;
    expect(releaseGate(report,legacy).reasons).toContain('NEXT_REQUIREMENTS_MISSING');
    expect(releaseGate({...report,required:[]},policy).verdict).toBe('BLOCKED');
    expect(releaseGate({...report,nextBuild:{...report.nextBuild,advisories:[]}},policy).verdict).toBe('BLOCKED');
    expect(releaseGate(report,{...policy,nextBuild:undefined}).verdict).toBe('BLOCKED');
  });
  it('keeps CLI failure nonzero and returns the Guardian diagnostics', () => {
    const {report,policy} = nextFixture();
    report.nextBuild.exitCode = 1;
    const dir = mkdtempSync(join(tmpdir(),'next-release-cli-'));
    const output = vi.spyOn(process.stdout,'write').mockReturnValue(true);
    try {
      writeFileSync(join(dir,'observed.json'),JSON.stringify(report));
      writeFileSync(join(dir,'trusted.json'),JSON.stringify(policy));
      expect(main(['release',join(dir,'observed.json'),join(dir,'trusted.json')])).toBe(1);
      const result = JSON.parse(String(output.mock.calls[0][0]));
      expect(result.nextBuild.policyVersion).toBe('next-build-v1');
      expect(result.reasons).toContain('NEXT_BUILD_EXIT_FAILED');
    } finally { output.mockRestore(); rmSync(dir,{recursive:true,force:true}); }
  });
});
