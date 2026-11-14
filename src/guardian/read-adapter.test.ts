import { describe, expect, it, vi } from 'vitest';
import { createGuardianReadAdapter } from './read-adapter';
import { GuardianReadSources, OperationalRead } from './read-sources';
import { BoardSnapshot, READ_TOOL_CONTRACTS, READ_TOOLS, READ_LIMITS, ReadSourceError } from './read-contracts';

const time = '2026-11-14T12:00:00.000Z';
const now = () => new Date(time);
const privateId = 'private-user@example.test/token-secret';
function operational(): OperationalRead {
  return {available: {worker: true, jobs: true, guardian: true}, snapshot: {
    generatedAt: time, systemStatus: 'ok', agents: [],
    workers: [{workerId: privateId, status: 'online', platform: 'secret-platform', arch: 'private-arch',
      workspace: {root: '/Users/private/.env', available: true}, lastHeartbeat: time,
      tools: [{name: 'secret-tool', available: true, version: 'Bearer-secret'}]}],
    jobs: [{jobId: privateId, action: 'inspect_repo', status: 'done', repo: '/Users/private/repo',
      worktreePath: 'C:\\private\\worktree', tool: 'Bearer-secret', startedAt: time, finishedAt: time,
      durationMs: 0, guardianVerdict: 'PASS', requiresHumanReview: false}],
    guardianReviews: [{reviewId: 'private-review', workerJobId: privateId, verdict: 'PASS',
      policyVersion: 'private-policy', reviewedAt: time, findingsCount: 2}],
  }};
}
function mission(): BoardSnapshot {
  return {schemaVersion: 'sb-mission/1', generatedAt: time, source: 'aa-isolated-inspector', executionAuthorized: false,
    mission: {id: privateId, repositoryAlias: 'MISSION-TEST', planHash: 'a'.repeat(64), baseSha: 'b'.repeat(40),
      branch: 'mission-test', assignmentId: 'inspect-fixture', action: 'diagnose', requiredCapability: 'architecture-plan',
      proposedRole: 'architect', proposalStatus: 'proposed', permissions: {host: true, mission: true, assignment: true},
      candidates: [], authorizations: [{id: 'private-grant', decision: 'revoked', effectiveStatus: 'expired',
        approvedAt: time, expiresAt: time}], observations: [{authorizationId: 'private-grant', status: 'completed',
        startedAt: time, finishedAt: time, evidence: {reference: 'private-evidence', headSha: 'b'.repeat(40),
          branch: 'private-branch', readmeSha256: 'c'.repeat(64)}}]}};
}
function fixture(op = operational(), board: unknown = mission()) {
  const sources: GuardianReadSources = {operational: vi.fn(async () => op), mission: vi.fn(async () => board)};
  return {sources, adapter: createGuardianReadAdapter(sources, now)};
}

describe('Guardian read contracts and safe outputs', () => {
  it('exports exactly the four agreed read-only tools with closed argument schemas', () => {
    expect(Object.keys(READ_TOOL_CONTRACTS)).toEqual([...READ_TOOLS]);
    for (const c of Object.values(READ_TOOL_CONTRACTS)) {
      expect(c.readOnly).toBe(true); expect(c.inputSchema.additionalProperties).toBe(false);
    }
  });
  it.each([
    ['get_runtime_status', {path: '/etc/passwd'}], ['get_mission_snapshot', {url: 'https://example.test'}],
    ['get_mission_snapshot', {missionId: '../../private'}], ['list_recent_jobs', {limit: 0}],
    ['list_recent_jobs', {limit: 101}], ['list_recent_jobs', {limit: 1.5}], ['list_recent_jobs', {limit: '2'}],
    ['list_recent_jobs', {limit: NaN}], ['list_recent_jobs', {status: 'success'}],
    ['list_recent_jobs', {action: 'deploy'}], ['list_recent_jobs', {since: '2026-02-30T00:00:00.000Z'}],
    ['list_recent_jobs', {since: '2026-11-14'}], ['get_guardian_summary', {jobRef: privateId}],
    ['get_guardian_summary', {verdict: 'APPROVED'}], ['get_runtime_status', []],
    ['get_runtime_status', null], ['get_runtime_status', {executionAuthorized: true}],
  ])('rejects invalid arguments before IO: %s %j', async (tool, args) => {
    const f = fixture();
    const result = await f.adapter.call(tool,args);
    expect(result).toMatchObject({ok: false, executionAuthorized: false, error: {code: 'INVALID_ARGUMENTS'}});
    expect(f.sources.operational).not.toHaveBeenCalled(); expect(f.sources.mission).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('rejects unknown tools and hostile object prototypes without reading', async () => {
    const f = fixture();
    expect(await f.adapter.call('execute_agent')).toMatchObject({error: {code: 'INVALID_TOOL'}});
    expect(await f.adapter.list_recent_jobs(Object.create({limit: 1}))).toMatchObject({error: {code: 'INVALID_ARGUMENTS'}});
    expect(f.sources.operational).not.toHaveBeenCalled();
  });
  it('never exposes raw fields, identifiers, secrets or changes source data', async () => {
    const op = operational(), board = mission();
    Object.assign(op.snapshot.jobs[0], {stdout: 'RAW LOG', stderr: 'secret error', env: {TOKEN: 'secret'}});
    Object.assign(board.mission, {key: 'secret', approvedBy: 'private-user', objective: 'execute everything'});
    const before = JSON.stringify({op,board}); const f = fixture(op,board);
    const responses = await Promise.all(READ_TOOLS.map(t => f.adapter.call(t)));
    for (const response of responses) expect(response).toMatchObject({ok: true, executionAuthorized: false});
    const json = JSON.stringify(responses);
    expect(json).not.toMatch(/private|secret|RAW LOG|stdout|stderr|approvedBy|planHash|baseSha|worktree|\/Users|C:\\|objective/);
    expect(JSON.stringify({op,board})).toBe(before);
    const jobs = await f.adapter.list_recent_jobs();
    if (!jobs.ok) throw Error('Expected jobs');
    expect(jobs.data.items[0].jobRef).toMatch(/^job-[a-f0-9]{32}$/);
    const reviews = await f.adapter.get_guardian_summary({jobRef: jobs.data.items[0].jobRef});
    expect(reviews).toMatchObject({ok: true, data: {total: 1}});
    expect(await f.adapter.get_guardian_summary({jobRef: 'job-'+'0'.repeat(32)})).toMatchObject({ok: true, data: {total: 0}});
    const other = await fixture(op,board).adapter.list_recent_jobs();
    if (!other.ok) throw Error('Expected jobs');
    expect(other.data.items[0].jobRef).not.toBe(jobs.data.items[0].jobRef);
  });
  it.each([
    ['online', time, 'online', 'fresh'],
    ['online', '2026-11-14T11:59:30.000Z', 'online', 'fresh'],
    ['online', '2026-11-14T11:59:29.999Z', 'stale', 'stale'],
    ['offline', '2026-11-14T11:00:00.000Z', 'offline', 'stale'],
    ['offline', time, 'offline', 'fresh'],
    ['online', 'invalid', 'unknown', 'unknown'],
    ['online', '2026-11-15T12:00:00.000Z', 'unknown', 'unknown'],
    ['private-state', time, 'unknown', 'fresh'],
  ])('distinguishes worker %s at %s', async (status, beat, expected, heartbeat) => {
    const op = operational(); Object.assign(op.snapshot.workers[0], {status, lastHeartbeat: beat});
    expect(await fixture(op).adapter.get_runtime_status()).toMatchObject({ok: true,
      data: {worker: {status: expected, heartbeat}}});
  });
  it('reports missing worker as unknown and missing collections as unavailable, never empty success', async () => {
    const op = operational(); op.snapshot.workers = []; op.available.worker = false;
    op.snapshot.jobs = []; op.available.jobs = false; op.snapshot.guardianReviews = []; op.available.guardian = false;
    const f = fixture(op);
    expect(await f.adapter.get_runtime_status()).toMatchObject({ok: true, data: {worker: {status: 'unknown'}, systemStatus: 'unknown'}});
    expect(await f.adapter.list_recent_jobs()).toMatchObject({ok: false, error: {code: 'SOURCE_UNAVAILABLE'}});
    expect(await f.adapter.get_guardian_summary()).toMatchObject({ok: false, error: {code: 'SOURCE_UNAVAILABLE'}});
  });
  it('filters before limiting, sorts by time, and reports truncation and matching totals', async () => {
    const op = operational(), template = op.snapshot.jobs[0];
    op.snapshot.jobs = Array.from({length: 25},(_,i) => ({...template,jobId: `private-${i}`,
      status: i % 2 ? 'failed' : 'done', finishedAt: new Date(Date.parse(time)+i*1000).toISOString()}));
    const f = fixture(op);
    expect(await f.adapter.list_recent_jobs()).toMatchObject({ok: true, data: {total: 25,truncated: true}});
    const filtered = await f.adapter.list_recent_jobs({status: 'done', action: 'inspect_repo', since: '2026-11-14T12:00:10.000Z', limit: 2});
    if (!filtered.ok) throw Error('Expected jobs');
    expect(filtered.data.total).toBe(8); expect(filtered.data.items).toHaveLength(2); expect(filtered.data.truncated).toBe(true);
    expect(filtered.data.items.map(j => j.finishedAt)).toEqual(['2026-11-14T12:00:24.000Z','2026-11-14T12:00:22.000Z']);
    expect(await f.adapter.list_recent_jobs({limit: 100, action: 'run_coding_tool'})).toMatchObject({ok: true,data: {items: [],total: 0,truncated: false}});
    op.snapshot.guardianReviews = Array.from({length: 3},(_,i) => ({...op.snapshot.guardianReviews[0], reviewId: `review-${i}`}));
    expect(await f.adapter.get_guardian_summary({verdict: 'PASS', since: time, limit: 1})).toMatchObject({ok: true,
      data: {counts: {PASS: 3,WARN: 0,BLOCKED: 0,HUMAN_REVIEW: 0},total: 3,truncated: true}});
  });
  it('enforces record caps and rejects corrupt projected fields', async () => {
    const op = operational(); op.snapshot.jobs = Array(READ_LIMITS.maxRecords+1).fill(op.snapshot.jobs[0]);
    expect(await fixture(op).adapter.list_recent_jobs()).toMatchObject({error: {code: 'SOURCE_LIMIT_EXCEEDED'}});
    const bad = operational(); bad.snapshot.guardianReviews[0].verdict = 'Bearer-secret' as never;
    expect(await fixture(bad).adapter.get_guardian_summary()).toMatchObject({error: {code: 'SOURCE_INVALID'}});
    const duplicate = operational(); duplicate.snapshot.jobs.push({...duplicate.snapshot.jobs[0]});
    expect(await fixture(duplicate).adapter.list_recent_jobs()).toMatchObject({error: {code: 'SOURCE_INVALID'}});
  });
  it.each(['failure','invalid','limit'])('returns only fixed safe errors: %s', async kind => {
    const f = fixture(); vi.mocked(f.sources.operational).mockRejectedValue(kind === 'failure' ?
      new Error('/Users/private TOKEN=secret stack trace') : new ReadSourceError(kind === 'invalid' ? 'SOURCE_INVALID' : 'SOURCE_LIMIT_EXCEEDED'));
    const r = await f.adapter.get_runtime_status();
    expect(r.ok).toBe(false); expect(JSON.stringify(r)).not.toMatch(/private|secret|stack/);
  });
  it('observes sb-mission/1 without refreshing expired grants or granting execution', async () => {
    const board = mission(); board.generatedAt = '2026-11-14T11:00:00.000Z';
    board.mission.authorizations[0].approvedAt = board.generatedAt;
    board.mission.observations[0].startedAt = board.generatedAt; board.mission.observations[0].finishedAt = board.generatedAt;
    const result = await fixture(operational(),board).adapter.get_mission_snapshot();
    expect(result).toMatchObject({ok: true,executionAuthorized: false,data: {sourceSchema: 'sb-mission/1',freshness: 'stale',
      executionAuthorized: false,mission: {authorizations: [{decision: 'revoked',effectiveStatus: 'expired'}],
        observations: [{status: 'completed',evidencePresent: true}]}}});
  });
  it.each(['authority','schema','future','broken-reference','oversized'])('fails closed for unsafe mission export: %s', async kind => {
    const board = mission();
    if (kind === 'authority') Object.assign(board,{executionAuthorized: true});
    if (kind === 'schema') Object.assign(board,{schemaVersion: 'sb-mission/2'});
    if (kind === 'future') board.generatedAt = '2027-01-01T00:00:00.000Z';
    if (kind === 'broken-reference') board.mission.observations[0].authorizationId = 'another';
    if (kind === 'oversized') board.mission.authorizations = Array(101).fill(board.mission.authorizations[0]);
    expect(await fixture(operational(),board).adapter.get_mission_snapshot()).toMatchObject({ok: false,executionAuthorized: false,
      error: {code: kind === 'oversized' ? 'SOURCE_LIMIT_EXCEEDED' : 'SOURCE_INVALID'}});
  });
});
