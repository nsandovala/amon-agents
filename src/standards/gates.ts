import { isAbsolute, relative, resolve } from 'path';
import { GuardianVerdict } from '../guardian/types';
import type { Provider } from '../llm/call-llm';

export interface Decision { verdict: GuardianVerdict; reasons: string[] }
const decision = (reasons: string[]): Decision => ({ verdict: reasons.length ? 'BLOCKED' : 'PASS', reasons });
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const texts = (v: unknown): v is string[] => Array.isArray(v) && v.every(text);
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k));
const date = (v: unknown): v is string => text(v) &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/.test(v) &&
  Number.isFinite(Date.parse(v)) && Number.isFinite(Date.parse(v.slice(0,10)+'T00:00:00Z')) &&
  new Date(v.slice(0,10)+'T00:00:00Z').toISOString().slice(0,10) === v.slice(0,10);
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{40}$/i.test(v);
const inside = (root: string, target: string) => {
  const rel = relative(root, target);
  return rel === '' || (rel !== '..' && !rel.startsWith('../') && !rel.startsWith('..\\') && !isAbsolute(rel));
};
export interface Preflight {
  schemaVersion: '1.0'; root: string; observedAt: string; platform: string;
  metadataComplete: boolean; datalessFiles: string[]; externalLinks: string[];
  dependencyState: 'missing'|'local'|'external'; freeBytes: number; writable: boolean; errors: string[];
}
export function isPreflight(v: unknown): v is Preflight {
  return object(v) && exact(v, ['schemaVersion','root','observedAt','platform','metadataComplete',
    'datalessFiles','externalLinks','dependencyState','freeBytes','writable','errors']) &&
    v.schemaVersion === '1.0' && text(v.root) && isAbsolute(v.root) && date(v.observedAt) && text(v.platform) &&
    typeof v.metadataComplete === 'boolean' && typeof v.writable === 'boolean' &&
    texts(v.datalessFiles) && texts(v.externalLinks) && texts(v.errors) &&
    ['missing','local','external'].includes(v.dependencyState as string) &&
    typeof v.freeBytes === 'number' && Number.isSafeInteger(v.freeBytes) && v.freeBytes >= 0;
}
/** Requirements come from the host/task, not from the observation or an LLM-issued grant. */
export function preflightGate(v: unknown, policy: {
  root: string; startedAt: string; now: string; minFreeBytes: number; requireDependencies: boolean;
}): Decision {
  if (!isPreflight(v)) return decision(['INVALID_PREFLIGHT']);
  const errors: string[] = [];
  if (typeof policy.requireDependencies !== 'boolean') errors.push('INVALID_REQUIREMENTS');
  if (!isAbsolute(policy.root) || resolve(v.root) !== resolve(policy.root)) errors.push('WRONG_ROOT');
  if (!fresh(v.observedAt, policy.startedAt, policy.now)) errors.push('STALE_OR_INVALID_TIME');
  if (!v.metadataComplete || v.errors.length) errors.push('INSPECTION_INCOMPLETE');
  if (v.datalessFiles.length) errors.push('DATALESS_FILES');
  if (v.externalLinks.length || v.dependencyState === 'external') errors.push('EXTERNAL_LINKS');
  if (policy.requireDependencies && v.dependencyState !== 'local') errors.push('DEPENDENCIES_MISSING');
  if (!v.writable) errors.push('NOT_WRITABLE');
  if (!Number.isSafeInteger(policy.minFreeBytes) || policy.minFreeBytes < 0 || v.freeBytes < policy.minFreeBytes)
    errors.push('INSUFFICIENT_OR_UNKNOWN_SPACE');
  return decision(errors);
}
const fresh = (at: string, start: string, now: string) => date(at) && date(start) && date(now) &&
  Date.parse(start) <= Date.parse(at) && Date.parse(at) <= Date.parse(now);

export const checkIds = ['http','browser','authentication','business','emulator'] as const;
export const layers = ['simulated','unit','http','browser','emulator'] as const;
export type CheckId = typeof checkIds[number];
export type Layer = typeof layers[number];
export interface RuntimeCheck {
  id: CheckId; layer: Layer; outcome: 'passed'|'failed'|'blocked'|'not_run';
  evidenceRef: string; detail: string;
}
export interface RuntimeReport {
  schemaVersion: '1.0'; runId: string; root: string; headSha: string; branch: string;
  observedAt: string; checks: RuntimeCheck[];
}
export function isRuntimeReport(v: unknown): v is RuntimeReport {
  return object(v) && exact(v,['schemaVersion','runId','root','headSha','branch','observedAt','checks']) &&
    v.schemaVersion === '1.0' && text(v.runId) && text(v.root) && isAbsolute(v.root) && sha(v.headSha) &&
    text(v.branch) && date(v.observedAt) && Array.isArray(v.checks) && v.checks.every(c =>
      object(c) && exact(c,['id','layer','outcome','evidenceRef','detail']) &&
      checkIds.includes(c.id as CheckId) && layers.includes(c.layer as Layer) &&
      ['passed','failed','blocked','not_run'].includes(c.outcome as string) && text(c.evidenceRef) && text(c.detail));
}
const realLayers: Record<CheckId, Layer[]> = {
  http:['http'], browser:['browser'], authentication:['browser'], business:['browser','emulator'], emulator:['emulator'],
};
export function releaseGate(v: unknown, policy: {
  runId: string; root: string; headSha: string; branch: string; startedAt: string; now: string;
  required: CheckId[]; guardianVerdict: GuardianVerdict;
}): Decision {
  if (!isRuntimeReport(v)) return decision(['INVALID_RUNTIME_REPORT']);
  const errors: string[] = [];
  if (!text(policy.runId) || !isAbsolute(policy.root) || !sha(policy.headSha) || !text(policy.branch) ||
      v.runId !== policy.runId || resolve(v.root) !== resolve(policy.root) ||
      v.headSha !== policy.headSha || v.branch !== policy.branch) errors.push('RUN_OR_REVISION_MISMATCH');
  if (!fresh(v.observedAt, policy.startedAt, policy.now)) errors.push('STALE_OR_INVALID_TIME');
  if (policy.guardianVerdict !== 'PASS') errors.push('GUARDIAN_NOT_PASS');
  if (!Array.isArray(policy.required) || policy.required.some(id => !checkIds.includes(id))) errors.push('INVALID_REQUIREMENTS');
  else for (const id of policy.required) {
    const found = v.checks.filter(c => c.id === id);
    if (found.length !== 1 || found[0].outcome !== 'passed' || !realLayers[id].includes(found[0].layer))
      errors.push(`REQUIRED_${id.toUpperCase()}_UNVERIFIED`);
  }
  if (new Set(v.checks.map(c => c.id)).size !== v.checks.length) errors.push('DUPLICATE_CHECK');
  if (v.checks.some(c => c.outcome === 'failed')) errors.push('OBSERVED_FAILURE');
  return decision(errors);
}

export function scopeGate(input: {
  root: string; changedRealPaths: string[]; allowedRealPaths: string[];
  roadmaps: {path: string; before: string; after: string}[];
}): Decision {
  // Callers must resolve actual filesystem symlinks and enumerate approved roadmaps.
  const errors: string[] = [];
  if (!isAbsolute(input.root) || input.allowedRealPaths.some(p => !isAbsolute(p) || !inside(input.root,p)))
    errors.push('INVALID_SCOPE');
  if (input.changedRealPaths.some(p => !isAbsolute(p) || !inside(input.root,p) ||
      !input.allowedRealPaths.some(a => inside(a,p)))) errors.push('OUT_OF_SCOPE');
  if (input.roadmaps.some(r => !/^[a-f0-9]{64}$/.test(r.before) || r.before !== r.after)) errors.push('ROADMAP_CHANGED_OR_UNKNOWN');
  return decision(errors);
}
export function providerGate(input: {
  currentProvider: string; currentEndpoint: string; requestedProvider: string; requestedEndpoint: string;
  billable: boolean|null;
}, trustedGrant?: {provider: string; endpoint: string; authorizationRef: string}): Decision {
  const errors: string[] = [];
  const known: Record<Provider, true> = {ollama:true, lmstudio:true, openai:true, gemini:true, openrouter:true, mock:true};
  if (!Object.hasOwn(known, input.requestedProvider) || !text(input.currentProvider) ||
      !text(input.currentEndpoint) || !text(input.requestedEndpoint)) errors.push('UNKNOWN_PROVIDER_OR_ENDPOINT');
  if (typeof input.billable !== 'boolean') errors.push('UNKNOWN_COST');
  const change = input.currentProvider !== input.requestedProvider || input.currentEndpoint !== input.requestedEndpoint;
  if ((change || input.billable !== false) && (!trustedGrant ||
      trustedGrant.provider !== input.requestedProvider || trustedGrant.endpoint !== input.requestedEndpoint ||
      !text(trustedGrant.authorizationRef))) errors.push('PROVIDER_AUTHORIZATION_REQUIRED');
  return decision(errors);
}

/** Consume the existing PR #87 report shape. No process control, no new emulator contract. */
export function emulatorGate(v: unknown, policy: {
  projectId: string; root: string; startedAt: string; now: string;
  phase: 'preflight'|'postflight'; ownedPids: number[];
}): Decision {
  if (!object(v) || v.schema !== 'amon-emulator-verification/preflight-v1' ||
      !Array.isArray(v.listeners) || !Array.isArray(v.inspectionErrors) ||
      !Array.isArray(v.inspectedPorts) || !text(policy.projectId) ||
      !['preflight','postflight'].includes(policy.phase)) return decision(['INVALID_EMULATOR_REPORT']);
  const errors: string[] = [];
  if (!text(v.projectRoot) || !isAbsolute(policy.root) || resolve(v.projectRoot) !== resolve(policy.root))
    errors.push('WRONG_EMULATOR_ROOT');
  if (!date(v.timestampUtc) || !fresh(v.timestampUtc,policy.startedAt,policy.now)) errors.push('STALE_OR_INVALID_TIME');
  if (v.expectedProjectId !== policy.projectId) errors.push('WRONG_EMULATOR_PROJECT');
  if (v.inspectionErrors.length || !['clean','occupied'].includes(v.status as string) ||
      (v.status === 'clean') !== (v.listeners.length === 0) ||
      [4000,4400,5001,8080,9099,9150].some(p => !(v.inspectedPorts as unknown[]).includes(p)))
    errors.push('EMULATOR_INSPECTION_INCOMPLETE');
  for (const row of v.listeners) {
    if (policy.phase === 'postflight') { errors.push('RESIDUAL_PROCESS'); break; }
    if (!object(row) || row.IdentityInspectionStatus !== 'ok' || !text(row.CommandLine) ||
        row.ProjectRootMatch !== true || row.ExpectedProjectIdMatch !== true ||
        typeof row.OwningProcess !== 'number' || !Number.isSafeInteger(row.OwningProcess) || row.OwningProcess < 1 ||
        !policy.ownedPids.includes(row.OwningProcess)) errors.push('UNOWNED_OR_AMBIGUOUS_LISTENER');
  }
  return decision(errors);
}
