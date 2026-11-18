import { createHash } from 'crypto';
import { isAbsolute, resolve } from 'path';
import type { GuardianFinding, GuardianVerdict } from './types';

/** Trusted host inputs, never fields accepted from worker/model observations. */
export interface NextBuildRequirements {
  lockfileText: string;
  nodeVersion: string;
  platform: string;
  installNodeEnv: string | null;
  advisoryNotBefore: string;
  advisories: {id: string; source: string; retrievedAt: string; sha256: string; body: string}[];
}
export interface NextBuildPolicy extends NextBuildRequirements {
  runId: string; root: string; headSha: string; branch: string; startedAt: string; now: string;
}
export type SecurityStatus = 'affected' | 'insufficient_information' | 'not_affected';
export interface NextBuildReview {
  policyVersion: 'next-build-v1'; verdict: GuardianVerdict; findings: GuardianFinding[];
  resolvedVersion: string | null;
  security: {id: string; source: string; status: SecurityStatus}[];
}

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const text = (v: unknown): v is string => typeof v === 'string' && !!v.trim();
const exact = (v: Record<string, unknown>, keys: string[]) =>
  Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v,k));
const sha = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{40}$/i.test(v);
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const date = (v: unknown): v is string => typeof v === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?Z$/.test(v) && Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString().slice(0,10) === v.slice(0,10);
const within = (at: unknown, start: unknown, end: unknown) => date(at) && date(start) && date(end) &&
  Date.parse(start) <= Date.parse(at) && Date.parse(at) <= Date.parse(end);
const nodeEnv = (v: unknown) => v === null || ['production','development','test'].includes(v as string);
const stable = (v: unknown): v is string => typeof v === 'string' && /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(v) &&
  v.split('.').every(n => Number.isSafeInteger(Number(n)));

/** Deliberately limited to stable comparator sets used by GHSA. Unknown grammar
 * (including prereleases) is insufficient information, never a guessed range. */
function inRange(version: string, range: unknown): boolean | null {
  if (!stable(version) || !text(range)) return null;
  const groups = range.split('||').map(group => {
    const tokens = group.trim().replace(/,/g,' ').match(/(?:>=|<=|>|<|=)?\s*\d+\.\d+\.\d+/g);
    if (!tokens?.length || group.replace(/,/g,' ').replace(/(?:>=|<=|>|<|=)?\s*\d+\.\d+\.\d+/g,'').trim()) return null;
    const matches = tokens.map(token => {
      const parsed = /^(>=|<=|>|<|=)?\s*(.*)$/.exec(token.trim())!;
      if (!stable(parsed[2])) return null;
      const a = version.split('.').map(Number), b = parsed[2].split('.').map(Number);
      const i = a.findIndex((n,j) => n !== b[j]);
      const cmp = i < 0 ? 0 : Math.sign(a[i]-b[i]);
      switch (parsed[1] ?? '=') {
        case '>=': return cmp >= 0; case '<=': return cmp <= 0;
        case '>': return cmp > 0; case '<': return cmp < 0; default: return cmp === 0;
      }
    });
    return matches.includes(null) ? null : matches.every(Boolean);
  });
  return groups.includes(null) ? null : groups.some(Boolean);
}

function resolvedNext(lockfileText: unknown): string | null {
  if (!text(lockfileText)) return null;
  try {
    const lock: unknown = JSON.parse(lockfileText.replace(/^\uFEFF/,''));
    if (!record(lock) || ![2,3].includes(lock.lockfileVersion as number) || !record(lock.packages)) return null;
    // Do not silently choose between multiple installations or follow local links.
    const entries = Object.entries(lock.packages).filter(([path]) => /(^|\/)node_modules\/next$/.test(path));
    if (entries.length !== 1 || entries[0][0] !== 'node_modules/next') return null;
    const pkg = entries[0][1];
    return record(pkg) && pkg.link !== true && stable(pkg.version) ? pkg.version : null;
  } catch { return null; }
}

function advisoryStatus(entry: unknown, version: string | null, policy: NextBuildPolicy): SecurityStatus {
  if (!record(entry) || !text(entry.id) || !/^GHSA-[a-z0-9]{4}-[a-z0-9]{4}-[a-z0-9]{4}$/.test(entry.id) ||
      entry.source !== `https://api.github.com/advisories/${entry.id}` || !text(entry.body) ||
      entry.sha256 !== hash(entry.body) || !within(entry.retrievedAt,policy.advisoryNotBefore,policy.now) || !version)
    return 'insufficient_information';
  try {
    const doc: unknown = JSON.parse(entry.body);
    if (!record(doc) || doc.ghsa_id !== entry.id || doc.html_url !== `https://github.com/advisories/${entry.id}` ||
        doc.withdrawn_at !== null || !within(doc.updated_at,doc.published_at,entry.retrievedAt) ||
        !Array.isArray(doc.vulnerabilities) || !doc.vulnerabilities.length) return 'insufficient_information';
    const ranges = doc.vulnerabilities.filter(v => record(v) && record(v.package) &&
      v.package.ecosystem === 'npm' && v.package.name === 'next');
    if (!ranges.length || doc.vulnerabilities.some(v => !record(v) || !record(v.package))) return 'insufficient_information';
    const matches = ranges.map(v => inRange(version,v.vulnerable_version_range));
    if (matches.includes(true)) return 'affected';
    return matches.includes(null) ? 'insufficient_information' : 'not_affected';
  } catch { return 'insufficient_information'; }
}

/** No process execution, network, approvals or criterion overrides. Like the
 * existing Guardian, checks observations; the host must collect/authenticate them. */
export function reviewNextBuildEvidence(evidence: unknown, policy: NextBuildPolicy): NextBuildReview {
  const findings: GuardianFinding[] = [];
  const security: NextBuildReview['security'] = [];
  let resolvedVersion: string | null = null;
  const add = (code: string, message: string, severity: GuardianFinding['severity'] = 'error') =>
    findings.push({code,severity,message});
  const result = (): NextBuildReview => ({policyVersion:'next-build-v1',
    verdict:findings.some(f => f.severity !== 'info') ? 'BLOCKED' : 'PASS',findings,resolvedVersion,security});
  if (!record(policy) || !text(policy.runId) || !text(policy.root) || !isAbsolute(policy.root) || !sha(policy.headSha) ||
      !text(policy.branch) || !within(policy.startedAt,policy.startedAt,policy.now) ||
      !text(policy.nodeVersion) || !/^v\d+\.\d+\.\d+$/.test(policy.nodeVersion) || !text(policy.platform) ||
      !nodeEnv(policy.installNodeEnv) || !within(policy.advisoryNotBefore,policy.advisoryNotBefore,policy.now)) {
    add('NEXT_REQUIREMENTS_INVALID','Next build requirements must come from a valid trusted host context');
    return result();
  }
  resolvedVersion = resolvedNext(policy.lockfileText);
  if (!resolvedVersion) add('NEXT_LOCKFILE_UNRESOLVED','Cannot resolve one stable Next version from npm lockfile v2/v3');
  if (!Array.isArray(policy.advisories) || !policy.advisories.length) {
    add('NEXT_SECURITY_INSUFFICIENT','No verified advisory scope supplied by the host');
  } else {
    const ids = new Set<string>();
    for (const entry of policy.advisories) {
      const id = record(entry) && text(entry.id) ? entry.id : 'unknown';
      const source = record(entry) && text(entry.source) ? entry.source : '';
      const status = ids.has(id) ? 'insufficient_information' : advisoryStatus(entry,resolvedVersion,policy);
      ids.add(id);
      security.push({id,source,status});
      if (status === 'affected') add('NEXT_VERSION_AFFECTED',`${id}: resolved package version matches the published affected range`);
      else if (status === 'insufficient_information') add('NEXT_SECURITY_INSUFFICIENT',`${id}: insufficient verifiable advisory information`);
    }
  }
  if (evidence === undefined) {
    add('NEXT_BUILD_MISSING','A completed Next build is required independently of worker PASS');
    return result();
  }
  const keys = ['runId','root','headSha','branch','worktreeHeadShaAfter','treeClean','startedAt','finishedAt',
    'command','completed','exitCode','signal','timedOut','logComplete','stdout','stderr','nodeVersion','platform',
    'installNodeEnv','buildNodeEnv','lockfileSha256','result'];
  if (!record(evidence) || !exact(evidence,keys) || !text(evidence.root) || !isAbsolute(evidence.root) ||
      !text(evidence.branch) || !sha(evidence.headSha) || !sha(evidence.worktreeHeadShaAfter) ||
      typeof evidence.stdout !== 'string' || typeof evidence.stderr !== 'string') {
    add('NEXT_BUILD_INVALID','Malformed build observations or unsupported acceptance overrides');
    return result();
  }
  if (evidence.runId !== policy.runId || resolve(evidence.root) !== resolve(policy.root) ||
      evidence.branch !== policy.branch || evidence.headSha !== policy.headSha ||
      evidence.worktreeHeadShaAfter !== policy.headSha || evidence.treeClean !== true)
    add('NEXT_BUILD_REVISION_MISMATCH','Build must match the approved run, clean source revision and worktree');
  if (evidence.command !== 'next build' || evidence.completed !== true || evidence.logComplete !== true ||
      evidence.timedOut !== false || evidence.signal !== null ||
      !within(evidence.startedAt,policy.startedAt,evidence.finishedAt) || !within(evidence.finishedAt,evidence.startedAt,policy.now))
    add('NEXT_BUILD_INCOMPLETE','Full next build process termination and complete logs are required');
  if (evidence.exitCode !== 0) add('NEXT_BUILD_EXIT_FAILED','Build exit code must be exactly zero');
  if (!nodeEnv(evidence.installNodeEnv) || evidence.installNodeEnv !== policy.installNodeEnv || evidence.buildNodeEnv !== 'production')
    add('NEXT_NODE_ENV_INVALID','Record the approved installation NODE_ENV and effective production build NODE_ENV');
  if (evidence.nodeVersion !== policy.nodeVersion || evidence.platform !== policy.platform ||
      !text(policy.lockfileText) || evidence.lockfileSha256 !== hash(policy.lockfileText))
    add('NEXT_BUILD_ENVIRONMENT_MISMATCH','Runtime/platform/lockfile differ from host requirements');
  const artifact = evidence.result;
  if (!record(artifact) || !exact(artifact,['outcome','buildId','createdAt','evidenceRef']) || artifact.outcome !== 'passed' ||
      !text(artifact.buildId) || !text(artifact.evidenceRef) || !within(artifact.createdAt,evidence.startedAt,evidence.finishedAt))
    add('NEXT_BUILD_RESULT_UNVERIFIED','A successful final result and fresh BUILD_ID artifact reference are required');
  const log = `${evidence.stdout}\n${evidence.stderr}`.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'');
  // Every diagnostic remains in the source logs. Findings carry line references,
  // not raw log text, so tokens/paths accidentally logged are not echoed by the gate.
  log.split(/\r?\n/).forEach((line,index) => {
    if (/non.standard.*NODE_ENV|NODE_ENV.*non.standard/i.test(line))
      add('NEXT_NODE_ENV_INVALID',`Non-standard NODE_ENV diagnostic at combined log line ${index+1}`);
    if (/⚠|\bwarn(?:ing)?\b/i.test(line)) {
      const tracing = /trac(?:e|ing)|outputFileTracingRoot|multiple lockfiles|inferred your workspace root/i.test(line);
      add(tracing ? 'NEXT_TRACING_WARNING' : 'NEXT_WARNING_UNCLASSIFIED',
        `${tracing ? 'Tracing' : 'Unclassified'} warning at combined log line ${index+1}; retained and blocking`);
    }
    if (/\bError:|build (?:failed|error)|Error occurred prerendering|Failed to compile/i.test(line))
      add('NEXT_BUILD_LOG_FAILURE',`Failure diagnostic at combined log line ${index+1}`);
  });
  return result();
}
