import { describe, expect, it } from 'vitest';
import { checkIds, emulatorGate, isPreflight, isRuntimeReport, layers, preflightGate,
  providerGate, releaseGate, scopeGate, Preflight, RuntimeReport } from './gates';
import incidents from './fixtures/incidents.json';
import preflightSchema from '../../.agents/standards/contracts/preflight.schema.json';
import runtimeSchema from '../../.agents/standards/contracts/release-gate.schema.json';

const root = '/qa/amon-agents';
const start = '2026-11-12T10:00:00.000Z';
const now = '2026-11-12T10:01:00.000Z';
const preflight: Preflight = {schemaVersion:'1.0', root, observedAt:now, platform:'darwin',
  metadataComplete:true,datalessFiles:[],externalLinks:[],dependencyState:'local',freeBytes:10e9,writable:true,errors:[]};
const envPolicy = {root,startedAt:start,now,minFreeBytes:1e9,requireDependencies:true};
const report: RuntimeReport = {schemaVersion:'1.0',runId:'RUN-001',root,headSha:'a'.repeat(40),
  branch:'worker/aa-skills-001',observedAt:now,checks:checkIds.map(id => ({id,
    layer:id === 'http' ? 'http' : id === 'emulator' ? 'emulator' : 'browser',
    outcome:'passed',evidenceRef:`synthetic:${id}`,detail:'Synthetic validator fixture, not a live result'}))};
const policy = {runId:report.runId,root,headSha:report.headSha,branch:report.branch,startedAt:start,now,
  required:[...checkIds],guardianVerdict:'PASS' as const};

describe('Sentinel storage and runtime regressions (synthetic)', () => {
  it('accepts safe observations only within host context', () => {
    expect(preflightGate(preflight,envPolicy).verdict).toBe('PASS');
    expect(releaseGate(report,policy).verdict).toBe('PASS');
  });
  it.each([
    [{datalessFiles:incidents.sentinel.datalessFiles},'DATALESS_FILES'],
    [{externalLinks:incidents.sentinel.externalLinks},'EXTERNAL_LINKS'],
    [{metadataComplete:false},'INSPECTION_INCOMPLETE'],
    [{errors:['PermissionError']},'INSPECTION_INCOMPLETE'],
    [{dependencyState:'external'},'EXTERNAL_LINKS'],
    [{dependencyState:'missing'},'DEPENDENCIES_MISSING'],
    [{freeBytes:1},'INSUFFICIENT_OR_UNKNOWN_SPACE'],
    [{writable:false},'NOT_WRITABLE'],
    [{root:'/qa/another'},'WRONG_ROOT'],
    [{observedAt:'2026-11-11T12:00:00Z'},'STALE_OR_INVALID_TIME'],
  ])('blocks unsafe preflight %j', (change,reason) => {
    expect(preflightGate({...preflight,...change},envPolicy).reasons).toContain(reason);
  });
  it('allows dependency installation before dependencies exist, but not build acceptance', () => {
    expect(preflightGate({...preflight,dependencyState:'missing'}, {...envPolicy,requireDependencies:false}).verdict).toBe('PASS');
  });
  it.each(checkIds)('requires real evidence for %s independently', id => {
    for (const layer of ['simulated','unit'] as const) {
      const checks = report.checks.map(c => c.id === id ? {...c,layer} : c);
      expect(releaseGate({...report,checks},policy).verdict).toBe('BLOCKED');
    }
    for (const outcome of ['failed','blocked','not_run'] as const) {
      const checks = report.checks.map(c => c.id === id ? {...c,outcome} : c);
      expect(releaseGate({...report,checks},policy).verdict).toBe('BLOCKED');
    }
    expect(releaseGate({...report,checks:report.checks.filter(c => c.id !== id)},policy).verdict).toBe('BLOCKED');
  });
  it('does not infer HTTP/browser/auth from Ready, unit tests or another revision', () => {
    expect(releaseGate({...report,checks:[]},policy).verdict).toBe('BLOCKED');
    expect(releaseGate({...report,headSha:'b'.repeat(40)},policy).reasons).toContain('RUN_OR_REVISION_MISMATCH');
    expect(releaseGate({...report,runId:'another'},policy).verdict).toBe('BLOCKED');
    expect(releaseGate({...report,observedAt:'2099-01-01T00:00:00Z'},policy).verdict).toBe('BLOCKED');
    expect(releaseGate(report,{...policy,guardianVerdict:'HUMAN_REVIEW'}).verdict).toBe('BLOCKED');
  });
  it('rejects duplicate and self-relaxed requirements', () => {
    expect(releaseGate({...report,checks:[...report.checks,report.checks[0]]},policy).verdict).toBe('BLOCKED');
    expect(releaseGate({...report,required:[]},policy).verdict).toBe('BLOCKED');
  });
});

describe('AMON Shop lifecycle cases (synthetic, no Firebase/Windows execution)', () => {
  const emulatorPolicy = {projectId:'demo-amon-ci',root:'/qa/shop',startedAt:start,now,phase:'preflight' as const,ownedPids:[]};
  it('blocks a foreign/residual Firestore PID without stopping it', () => {
    const before = JSON.stringify(incidents.shop.report);
    expect(emulatorGate(incidents.shop.report,emulatorPolicy).reasons).toContain('UNOWNED_OR_AMBIGUOUS_LISTENER');
    expect(emulatorGate(incidents.shop.report,{...emulatorPolicy,phase:'postflight'}).reasons).toContain('RESIDUAL_PROCESS');
    expect(JSON.stringify(incidents.shop.report)).toBe(before);
  });
  it('fails closed when listener enumeration fails or one port is omitted', () => {
    const clean = {...incidents.shop.report,status:'clean',listeners:[]};
    expect(emulatorGate(clean,emulatorPolicy).verdict).toBe('PASS');
    expect(emulatorGate({...clean,status:'error',inspectionErrors:['enumeration failure']},emulatorPolicy).verdict).toBe('BLOCKED');
    expect(emulatorGate({...clean,inspectedPorts:[8080]},emulatorPolicy).verdict).toBe('BLOCKED');
    expect(emulatorGate({...clean,expectedProjectId:'production'},emulatorPolicy).verdict).toBe('BLOCKED');
    expect(emulatorGate({...clean,timestampUtc:'2026-10-29T00:00:00Z'},emulatorPolicy).verdict).toBe('BLOCKED');
    expect(emulatorGate({...clean,projectRoot:'/another'},emulatorPolicy).verdict).toBe('BLOCKED');
  });
  it('only accepts intentional identified ownership before the run, never as clean shutdown', () => {
    const owned = {...incidents.shop.report,listeners:[{...incidents.shop.report.listeners[0],ProjectRootMatch:true,ExpectedProjectIdMatch:true}]};
    expect(emulatorGate(owned,{...emulatorPolicy,ownedPids:[33920]}).verdict).toBe('PASS');
    expect(emulatorGate(owned,{...emulatorPolicy,ownedPids:[33920],phase:'postflight'}).verdict).toBe('BLOCKED');
  });
  it.each(incidents.shop.unexpected)('preserves observed failure %s', detail => {
    const checks = report.checks.map(c => c.id === 'emulator' ? {...c,outcome:'failed' as const,detail} : c);
    expect(releaseGate({...report,checks},policy).reasons).toContain('OBSERVED_FAILURE');
  });
});

describe('scope and provider boundaries', () => {
  const scope = {root,changedRealPaths:[`${root}/src/a.ts`],allowedRealPaths:[`${root}/src`],
    roadmaps:[{path:'docs/ROADMAP.md',before:'a'.repeat(64),after:'a'.repeat(64)}]};
  it('blocks external, sibling-prefix, traversal and changed roadmaps', () => {
    expect(scopeGate(scope).verdict).toBe('PASS');
    for (const path of ['/other/a',`${root}/src-escape/a`,`${root}/src/../../escape`])
      expect(scopeGate({...scope,changedRealPaths:[path]}).verdict).toBe('BLOCKED');
    expect(scopeGate({...scope,roadmaps:[{...scope.roadmaps[0],after:'b'.repeat(64)}]}).verdict).toBe('BLOCKED');
  });
  const local = {currentProvider:'ollama',currentEndpoint:'http://127.0.0.1:11434',
    requestedProvider:'ollama',requestedEndpoint:'http://127.0.0.1:11434',billable:false};
  it('requires exact authorization for switching, endpoint changes or billable use', () => {
    expect(providerGate(local).verdict).toBe('PASS');
    expect(providerGate({...local,billable:null}).verdict).toBe('BLOCKED');
    expect(providerGate({...local,billable:true}).verdict).toBe('BLOCKED');
    const requested = {...local,requestedProvider:'openai',requestedEndpoint:'https://api.openai.com',billable:true};
    expect(providerGate(requested).verdict).toBe('BLOCKED');
    expect(providerGate(requested,{provider:'openai',endpoint:'https://wrong.example',authorizationRef:'human:001'}).verdict).toBe('BLOCKED');
    expect(providerGate(requested,{provider:'openai',endpoint:requested.requestedEndpoint,authorizationRef:'human:001'}).verdict).toBe('PASS');
    expect(providerGate({...local,requestedEndpoint:'https://remote.example'}).verdict).toBe('BLOCKED');
  });
});

describe('new schemas and explicit structural validators', () => {
  it('uses the same fields/enums as the JSON Schemas', () => {
    expect(Object.keys(preflight).sort()).toEqual([...preflightSchema.required].sort());
    expect(Object.keys(report).sort()).toEqual([...runtimeSchema.required].sort());
    expect(runtimeSchema.properties.checks.items.properties.id.enum).toEqual([...checkIds]);
    expect(runtimeSchema.properties.checks.items.properties.layer.enum).toEqual([...layers]);
    for (const [fixture,validate,schema] of [[preflight,isPreflight,preflightSchema],[report,isRuntimeReport,runtimeSchema]] as const) {
      expect(validate(fixture)).toBe(true);
      expect(validate({...fixture,unexpected:true})).toBe(false);
      for (const key of schema.required) {
        const partial: Record<string,unknown> = {...fixture}; delete partial[key];
        expect(validate(partial)).toBe(false);
      }
      for (const bad of [null,[],1,'invalid']) expect(validate(bad)).toBe(false);
    }
    expect(isPreflight({...preflight,freeBytes:NaN})).toBe(false);
    expect(isRuntimeReport({...report,checks:[{...report.checks[0],layer:'mock'}]})).toBe(false);
    expect(isRuntimeReport({...report,observedAt:'2026-02-30T10:00:00Z'})).toBe(false);
    expect(isRuntimeReport({...report,observedAt:'2026-11-12T10:00:00'})).toBe(false);
  });
});
