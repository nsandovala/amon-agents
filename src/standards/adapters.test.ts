import { createHash } from 'crypto';
import { readdirSync, readFileSync, realpathSync, statSync, lstatSync } from 'fs';
import { join, resolve } from 'path';
import yaml from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { emulatorGate } from './gates';

const canonical = resolve('.agents/skills');
const names = ['amon-preflight','amon-runtime-qa','amon-roadmap-guard','amon-handoff',
  'amon-provider-policy','amon-emulator-verification'].sort();
function digest(root: string): string {
  const hash = createHash('sha256');
  const walk = (dir: string) => {
    for (const name of readdirSync(join(root,dir)).sort()) {
      const path = join(dir,name);
      if (name === '__pycache__') continue;
      if (statSync(join(root,path)).isDirectory()) walk(path);
      else hash.update(path).update('\0').update(readFileSync(join(root,path)));
    }
  };
  walk(''); return hash.digest('hex');
}
describe('canonical policy distribution (filesystem integration, not client inference)', () => {
  it('delivers identical packages and policy references through all three adapters', () => {
    expect(readdirSync(canonical).sort()).toEqual(names);
    const expected = digest(canonical);
    for (const path of ['.agents/skills','.claude/skills','.opencode/skills']) {
      if (path !== '.agents/skills') expect(lstatSync(path).isSymbolicLink(), `${path} must be a real link, including on Windows`).toBe(true);
      expect(realpathSync(path)).toBe(canonical);
      expect(digest(path)).toBe(expected);
      for (const name of names) {
        const content = readFileSync(join(path,name,'SKILL.md'),'utf8');
        expect(content).toContain('`.agents/standards/policy.md`');
        const frontmatter = yaml.load(content.split('---')[1]) as Record<string,unknown>;
        expect(frontmatter.name).toBe(name);
        expect(typeof frontmatter.description).toBe('string');
        expect(String(frontmatter.description).length).toBeLessThan(1025);
      }
    }
  });
  it('preserves upstream emulator protocol and all scripts byte-for-byte', () => {
    const root = join(canonical,'amon-emulator-verification');
    const manifest = JSON.parse(readFileSync(join(root,'references/upstream.json'),'utf8'));
    expect(manifest.headSha).toBe('fc50c178989959d29021c9051d6b46f653818cd0');
    expect(manifest.upstreamVersion).toBe('1.1.1');
    expect(manifest.source).toBe(`https://github.com/nsandovala/tbb-amon-delivery-dev/tree/${manifest.headSha}/.agents/skills/amon-emulator-verification`);
    expect(manifest.ref).toBe('main');
    expect(manifest).not.toHaveProperty('localCorrection');
    for (const [file,sha] of Object.entries(manifest.upstreamSha256)) {
      if (file === 'README.md') continue;
      const installed = readFileSync(join(root,file));
      const original = file === 'SKILL.md' ? installed.subarray(0,manifest.upstreamSkillBytes) : installed;
      expect(createHash('sha256').update(original).digest('hex')).toBe(sha);
      expect(createHash('sha1').update(`blob ${original.length}\0`).update(original).digest('hex')).toBe(manifest.upstreamGitBlobs[file]);
    }
    const installedFiles: string[] = [];
    const list = (dir: string) => {
      for (const name of readdirSync(join(root,dir))) {
        if (name === '__pycache__') continue;
        const path = join(dir,name);
        if (statSync(join(root,path)).isDirectory()) list(path);
        else installedFiles.push(path.split('\\').join('/'));
      }
    };
    list('');
    expect(installedFiles.sort()).toEqual([...Object.keys(manifest.upstreamSha256).filter(p => p !== 'README.md'), ...manifest.localOnlyFiles].sort());
    const cleanup = readFileSync(join(root,'scripts/cleanup-authorized.ps1'),'utf8');
    expect(cleanup).toContain('if (-not $ConfirmAuthorized)');
    expect(cleanup).toContain('Stop-Process -Id $TargetPid');
    const skill = readFileSync(join(root,'SKILL.md'),'utf8');
    expect(skill).toContain('never part of the default verification command');
    expect(skill).toContain('not commands to run in AMON Agents');
  });
});

describe('1.1.1 report boundary (synthetic compatibility, no Windows/emulator execution)', () => {
  it('blocks direct postflight-v2 input and accepts only a separate fresh v1 clean inventory', () => {
    const now = '2026-11-12T10:01:00.000Z';
    const policy = {root:resolve('.'),projectId:'demo-amon-ci',startedAt:now,now,phase:'postflight' as const,ownedPids:[]};
    const inventory = {schema:'amon-emulator-verification/preflight-v1',timestampUtc:now,
      projectRoot:policy.root,expectedProjectId:policy.projectId,inspectedPorts:[4000,4400,5001,8080,9099,9150],
      status:'clean',listeners:[],inspectionErrors:[]};
    for (const status of ['clean','residual','ambiguous','error']) {
      const report = {...inventory,schema:'amon-emulator-verification/postflight-v2',status,
        inspectedPorts:inventory.inspectedPorts.map(String),graceSeconds:90,pollSeconds:10,observations:[]};
      expect(emulatorGate(report,policy)).toEqual({verdict:'BLOCKED',reasons:['INVALID_EMULATOR_REPORT']});
    }
    expect(emulatorGate(inventory,policy).verdict).toBe('PASS');
    expect(emulatorGate({...inventory,listeners:[{OwningProcess:123}]},policy).verdict).toBe('BLOCKED');
  });
});
