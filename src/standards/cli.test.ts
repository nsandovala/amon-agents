import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join, resolve } from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { main } from './cli';

describe('CLI UTF-8 BOM input handling', () => {
  let directory: string;
  const now = '2026-11-12T10:00:00.000Z';
  const observations = {schemaVersion:'1.0',root:resolve('.'),observedAt:now,platform:'darwin',
    metadataComplete:true,datalessFiles:[],externalLinks:[],dependencyState:'local',
    freeBytes:1024,writable:true,errors:[]};
  const requirements = {root:resolve('.'),startedAt:now,now,minFreeBytes:1,requireDependencies:true};

  beforeEach(() => {
    directory = mkdtempSync(join(process.cwd(),'.aa-cli-bom-'));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    // Remove only the unique fixture directory created by this test.
    rmSync(directory,{recursive:true});
  });
  function check(observationText: string, requirementsText: string) {
    const observationFile = join(directory,'observations.json');
    const requirementsFile = join(directory,'requirements.json');
    writeFileSync(observationFile,observationText,'utf8');
    writeFileSync(requirementsFile,requirementsText,'utf8');
    const output = vi.spyOn(process.stdout,'write').mockImplementation(() => true);
    const exitCode = main(['preflight',observationFile,requirementsFile]);
    return {exitCode,report:JSON.parse(output.mock.calls.map(call => String(call[0])).join(''))};
  }

  it.each([
    ['neither file',false,false],
    ['observation file',true,false],
    ['requirements file',false,true],
    ['both files',true,true],
  ] as const)('accepts valid JSON with BOM in %s', (_label,observationBom,requirementsBom) => {
    const result = check((observationBom ? '\uFEFF' : '')+JSON.stringify(observations),
      (requirementsBom ? '\uFEFF' : '')+JSON.stringify(requirements));
    expect(result).toEqual({exitCode:0,report:{verdict:'PASS',reasons:[]}});
  });

  it.each(['observations','requirements'] as const)('fails closed for malformed %s after a BOM', file => {
    const malformed = '\uFEFF{"schemaVersion":';
    const result = check(file === 'observations' ? malformed : JSON.stringify(observations),
      file === 'requirements' ? malformed : JSON.stringify(requirements));
    expect(result.exitCode).toBe(1);
    expect(result.report.verdict).toBe('BLOCKED');
    expect(result.report.reasons).toEqual(['INVALID_INPUT_OR_UNREADABLE_FILE']);
  });
});
