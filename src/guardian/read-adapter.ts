import { createHmac, randomBytes } from 'node:crypto';
import type { OperationalSnapshot } from '../ops/types';
import { roles } from '../mission/capabilities';
import { createLocalReadSources, GuardianReadSources, OperationalRead } from './read-sources';
import { BoardSnapshot, GuardianSummaryInput, JOB_ACTIONS, JOB_STATUSES, MissionObservation,
  READ_LIMITS, READ_TOOLS, ReadData, ReadErrorCode, ReadResult, ReadSourceError, ReadTool,
  RecentJob, RecentJobsInput, RuntimeStatus, VERDICTS } from './read-contracts';

const messages: Record<ReadErrorCode, string> = {
  INVALID_TOOL: 'Unknown read tool.', INVALID_ARGUMENTS: 'Invalid read arguments.',
  SOURCE_UNAVAILABLE: 'Observation source unavailable.', SOURCE_INVALID: 'Invalid observation source.',
  SOURCE_LIMIT_EXCEEDED: 'Observation source exceeds read limits.',
};
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' &&
  !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
const iso = (v: unknown): v is string => typeof v === 'string' &&
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
const identifier = (v: unknown): v is string => typeof v === 'string' && v.length > 0 && v.length <= 512;
const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
function requireSource(ok: unknown): asserts ok { if (!ok) throw new ReadSourceError('SOURCE_INVALID'); }
function bounded(v: unknown, max: number = READ_LIMITS.maxRecords): asserts v is unknown[] {
  requireSource(Array.isArray(v));
  if (v.length > max) throw new ReadSourceError('SOURCE_LIMIT_EXCEEDED');
}
function validInput(tool: ReadTool, input: unknown): boolean {
  if (!record(input)) return false;
  const allowed = tool === 'list_recent_jobs' ? ['limit', 'status', 'action', 'since'] :
    tool === 'get_guardian_summary' ? ['limit', 'verdict', 'jobRef', 'since'] : [];
  if (Object.keys(input).some(k => !allowed.includes(k))) return false;
  return Object.entries(input).every(([key, value]) => {
    switch (key) {
      case 'limit': return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= READ_LIMITS.maxLimit;
      case 'since': return iso(value);
      case 'status': return JOB_STATUSES.includes(value as never);
      case 'action': return JOB_ACTIONS.includes(value as never);
      case 'verdict': return VERDICTS.includes(value as never);
      case 'jobRef': return typeof value === 'string' && /^job-[a-f0-9]{32}$/.test(value);
      default: return false;
    }
  });
}
function validateOperational(read: OperationalRead): OperationalSnapshot {
  requireSource(record(read) && record(read.available) && record(read.snapshot));
  requireSource(['worker','jobs','guardian'].every(k => typeof read.available[k as keyof typeof read.available] === 'boolean'));
  const s = read.snapshot;
  requireSource(iso(s.generatedAt) && ['ok','degraded'].includes(s.systemStatus));
  bounded(s.workers, 1); bounded(s.jobs); bounded(s.guardianReviews);
  requireSource(read.available.worker === (s.workers.length === 1));
  requireSource((read.available.jobs || s.jobs.length === 0) && (read.available.guardian || s.guardianReviews.length === 0));
  s.workers.forEach(w => requireSource(record(w)));
  const ids = new Set<string>();
  for (const j of s.jobs) {
    requireSource(record(j) && identifier(j.jobId) && !ids.has(j.jobId) && JOB_ACTIONS.includes(j.action as never) &&
      JOB_STATUSES.includes(j.status as never) && typeof j.requiresHumanReview === 'boolean' &&
      (j.startedAt === undefined || iso(j.startedAt)) && (j.finishedAt === undefined || iso(j.finishedAt)) &&
      (j.durationMs === undefined || count(j.durationMs)) && (j.guardianVerdict === undefined || VERDICTS.includes(j.guardianVerdict)));
    ids.add(j.jobId);
  }
  ids.clear();
  for (const g of s.guardianReviews) {
    requireSource(record(g) && identifier(g.reviewId) && !ids.has(g.reviewId) && identifier(g.workerJobId) &&
      VERDICTS.includes(g.verdict) && iso(g.reviewedAt) && count(g.findingsCount));
    ids.add(g.reviewId);
  }
  return s;
}

/** Observation only: inputs cannot select a filesystem/network source or grant authority. */
export function createGuardianReadAdapter(sources: GuardianReadSources = createLocalReadSources(), now = () => new Date()) {
  // Per-instance, non-exported key prevents dictionary recovery of private IDs and cross-session tracking.
  const key = randomBytes(32);
  const ref = (kind: string, id: string) => `${kind}-${createHmac('sha256', key).update(kind).update('\0').update(id).digest('hex').slice(0,32)}`;
  const fail = (code: ReadErrorCode): ReadResult<never> => ({schemaVersion: 'guardian-read/1', executionAuthorized: false,
    ok: false, error: {code, message: messages[code]}});

  function runtime(read: OperationalRead, at: Date): RuntimeStatus {
    const s = read.snapshot, w = s.workers[0];
    const heartbeatValid = w && iso(w.lastHeartbeat) && Date.parse(w.lastHeartbeat) <= +at;
    const ageMs = heartbeatValid ? +at - Date.parse(w.lastHeartbeat) : null;
    const heartbeat = ageMs === null ? 'unknown' : ageMs > READ_LIMITS.staleAfterMs ? 'stale' : 'fresh';
    const status = w?.status === 'offline' ? 'offline' : w?.status !== 'online' || heartbeat === 'unknown' ? 'unknown' :
      heartbeat === 'stale' ? 'stale' : 'online';
    return {worker: {status, heartbeat, lastHeartbeat: heartbeatValid ? w.lastHeartbeat : null, ageMs},
      systemStatus: !Object.values(read.available).every(Boolean) ? 'unknown' : s.systemStatus,
      available: {worker: read.available.worker, jobs: read.available.jobs, guardian: read.available.guardian}};
  }
  function jobs(s: OperationalSnapshot, input: RecentJobsInput): ReadData['list_recent_jobs'] {
    const items = s.jobs.map<RecentJob>(j => ({jobRef: ref('job',j.jobId), action: j.action as RecentJob['action'],
      status: j.status as RecentJob['status'], startedAt: j.startedAt ?? null, finishedAt: j.finishedAt ?? null,
      durationMs: j.durationMs ?? null, guardianVerdict: j.guardianVerdict ?? null, requiresHumanReview: j.requiresHumanReview}))
      .filter(j => (!input.status || j.status === input.status) && (!input.action || j.action === input.action) &&
        (!input.since || (j.finishedAt ?? j.startedAt ?? '') >= input.since))
      .sort((a,b) => (b.finishedAt ?? b.startedAt ?? '').localeCompare(a.finishedAt ?? a.startedAt ?? '') || a.jobRef.localeCompare(b.jobRef));
    const limit = input.limit ?? READ_LIMITS.defaultLimit;
    return {items: items.slice(0,limit), total: items.length, truncated: items.length > limit};
  }
  function guardian(s: OperationalSnapshot, input: GuardianSummaryInput): ReadData['get_guardian_summary'] {
    const items = s.guardianReviews.map(g => ({reviewRef: ref('review',g.reviewId), jobRef: ref('job',g.workerJobId),
      verdict: g.verdict, reviewedAt: g.reviewedAt, findingsCount: g.findingsCount}))
      .filter(g => (!input.verdict || g.verdict === input.verdict) && (!input.jobRef || g.jobRef === input.jobRef) &&
        (!input.since || g.reviewedAt >= input.since))
      .sort((a,b) => b.reviewedAt.localeCompare(a.reviewedAt) || a.reviewRef.localeCompare(b.reviewRef));
    const counts = {PASS: 0, WARN: 0, BLOCKED: 0, HUMAN_REVIEW: 0};
    items.forEach(g => counts[g.verdict]++);
    const limit = input.limit ?? READ_LIMITS.defaultLimit;
    return {items: items.slice(0,limit), total: items.length, truncated: items.length > limit, counts};
  }
  function mission(value: unknown, at: Date): MissionObservation {
    requireSource(record(value) && value.schemaVersion === 'sb-mission/1' && value.source === 'aa-isolated-inspector' &&
      value.executionAuthorized === false && iso(value.generatedAt) && Date.parse(value.generatedAt) <= +at && record(value.mission));
    // Read only the existing export. Never recompute authorization or inspect its private approval store.
    const m = value.mission;
    requireSource(identifier(m.id) && m.repositoryAlias === 'MISSION-TEST' && m.action === 'diagnose' &&
      ['proposed','blocked'].includes(m.proposalStatus as string) &&
      (m.proposedRole === null || roles.includes(m.proposedRole as never)) && record(m.permissions) &&
      ['host','mission','assignment'].every(k => typeof (m.permissions as Record<string,unknown>)[k] === 'boolean'));
    bounded(m.authorizations, 100); bounded(m.observations, 100);
    const grants = new Set<string>();
    for (const a of m.authorizations) {
      requireSource(record(a) && identifier(a.id) && !grants.has(a.id) &&
        ['pending','approved','denied','revoked'].includes(a.decision as string) &&
        ['pending','approved','denied','revoked','expired','invalid'].includes(a.effectiveStatus as string) &&
        (a.approvedAt === null || (iso(a.approvedAt) && a.approvedAt <= value.generatedAt)) && iso(a.expiresAt));
      grants.add(a.id);
    }
    const seen = new Set<string>();
    for (const o of m.observations) {
      requireSource(record(o) && identifier(o.authorizationId) && grants.has(o.authorizationId) && !seen.has(o.authorizationId) &&
        ['interrupted','blocked','completed'].includes(o.status as string) && iso(o.startedAt) && o.startedAt <= value.generatedAt &&
        (o.status === 'interrupted' ? o.finishedAt === null && o.evidence === null :
          iso(o.finishedAt) && o.finishedAt >= o.startedAt && o.finishedAt <= value.generatedAt &&
          (o.status === 'blocked' ? o.evidence === null : record(o.evidence))));
      seen.add(o.authorizationId);
    }
    const s = value as unknown as BoardSnapshot;
    return {sourceSchema: s.schemaVersion, source: s.source, generatedAt: s.generatedAt,
      freshness: +at - Date.parse(s.generatedAt) > READ_LIMITS.staleAfterMs ? 'stale' : 'fresh', executionAuthorized: false,
      mission: {missionRef: ref('mission',s.mission.id), repositoryAlias: s.mission.repositoryAlias,
        action: s.mission.action, proposalStatus: s.mission.proposalStatus, proposedRole: s.mission.proposedRole,
        permissions: {host: s.mission.permissions.host, mission: s.mission.permissions.mission, assignment: s.mission.permissions.assignment},
        authorizations: s.mission.authorizations.map(a => ({authorizationRef: ref('authorization',a.id),
          decision: a.decision, effectiveStatus: a.effectiveStatus, approvedAt: a.approvedAt, expiresAt: a.expiresAt})),
        observations: s.mission.observations.map(o => ({authorizationRef: ref('authorization',o.authorizationId),
          status: o.status, startedAt: o.startedAt, finishedAt: o.finishedAt, evidencePresent: o.evidence !== null}))}};
  }
  async function call<K extends ReadTool>(tool: K, input?: unknown): Promise<ReadResult<ReadData[K]>>;
  async function call(tool: unknown, input?: unknown): Promise<ReadResult<ReadData[ReadTool]>>;
  async function call(tool: unknown, input: unknown = {}): Promise<ReadResult<ReadData[ReadTool]>> {
    try {
      if (typeof tool !== 'string' || !READ_TOOLS.includes(tool as ReadTool)) return fail('INVALID_TOOL');
      if (!validInput(tool as ReadTool,input)) return fail('INVALID_ARGUMENTS');
      const at = now();
      requireSource(Number.isFinite(+at));
      let data: ReadData[ReadTool];
      if (tool === 'get_mission_snapshot') data = mission(await sources.mission(), at);
      else {
        const read = await sources.operational(at), s = validateOperational(read);
        requireSource(Date.parse(s.generatedAt) <= +at);
        if (tool === 'get_runtime_status') data = runtime(read,at);
        else if (tool === 'list_recent_jobs') {
          if (!read.available.jobs) throw new ReadSourceError('SOURCE_UNAVAILABLE');
          data = jobs(s,input as RecentJobsInput);
        } else {
          if (!read.available.guardian) throw new ReadSourceError('SOURCE_UNAVAILABLE');
          data = guardian(s,input as GuardianSummaryInput);
        }
      }
      return {schemaVersion: 'guardian-read/1', executionAuthorized: false, ok: true, observedAt: at.toISOString(), data};
    } catch (error) {
      return fail(error instanceof ReadSourceError && ['SOURCE_INVALID','SOURCE_LIMIT_EXCEEDED','SOURCE_UNAVAILABLE'].includes(error.code)
        ? error.code : 'SOURCE_UNAVAILABLE');
    }
  }
  return Object.freeze({call,
    get_runtime_status: (input?: unknown) => call('get_runtime_status',input),
    list_recent_jobs: (input?: unknown) => call('list_recent_jobs',input),
    get_guardian_summary: (input?: unknown) => call('get_guardian_summary',input),
    get_mission_snapshot: (input?: unknown) => call('get_mission_snapshot',input)});
}
