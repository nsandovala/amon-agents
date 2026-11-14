import type { GuardianVerdict } from './types';
import type { WorkerJobAction, WorkerJobStatus } from '../worker/types';
import type { boardSnapshot } from '../mission/board-export';

/** Derive observation fields from the existing exporter, not a second mission model. */
export type BoardSnapshot = ReturnType<typeof boardSnapshot>;
type BoardMission = BoardSnapshot['mission'];
export const READ_LIMITS = Object.freeze({defaultLimit: 20, maxLimit: 100, maxRecords: 1000,
  fileBytes: 262144, totalBytes: 4194304, staleAfterMs: 30000});
export const JOB_STATUSES = ['queued', 'running', 'done', 'failed'] as const satisfies readonly WorkerJobStatus[];
export const JOB_ACTIONS = ['inspect_repo', 'prepare_worktree', 'run_coding_tool'] as const satisfies readonly WorkerJobAction[];
export const VERDICTS = ['PASS', 'WARN', 'BLOCKED', 'HUMAN_REVIEW'] as const satisfies readonly GuardianVerdict[];
export const READ_TOOLS = ['get_runtime_status', 'list_recent_jobs', 'get_guardian_summary', 'get_mission_snapshot'] as const;
export type ReadTool = typeof READ_TOOLS[number];
export type ReadErrorCode = 'INVALID_TOOL' | 'INVALID_ARGUMENTS' | 'SOURCE_UNAVAILABLE' | 'SOURCE_INVALID' | 'SOURCE_LIMIT_EXCEEDED';
export class ReadSourceError extends Error {
  constructor(public readonly code: Exclude<ReadErrorCode, 'INVALID_TOOL' | 'INVALID_ARGUMENTS'>) { super(code); }
}
export interface RecentJobsInput { limit?: number; status?: WorkerJobStatus; action?: WorkerJobAction; since?: string }
export interface GuardianSummaryInput { limit?: number; verdict?: GuardianVerdict; jobRef?: string; since?: string }
export interface RuntimeStatus {
  worker: {status: 'online' | 'offline' | 'stale' | 'unknown'; heartbeat: 'fresh' | 'stale' | 'unknown';
    lastHeartbeat: string | null; ageMs: number | null};
  systemStatus: 'ok' | 'degraded' | 'unknown';
  available: {worker: boolean; jobs: boolean; guardian: boolean};
}
export interface RecentJob {
  jobRef: string; action: WorkerJobAction; status: WorkerJobStatus;
  startedAt: string | null; finishedAt: string | null; durationMs: number | null;
  guardianVerdict: GuardianVerdict | null; requiresHumanReview: boolean;
}
export interface GuardianObservation {
  reviewRef: string; jobRef: string; verdict: GuardianVerdict;
  reviewedAt: string; findingsCount: number;
}
export interface MissionObservation {
  sourceSchema: BoardSnapshot['schemaVersion']; source: BoardSnapshot['source'];
  generatedAt: string; freshness: 'fresh' | 'stale'; executionAuthorized: false;
  mission: Pick<BoardMission, 'repositoryAlias' | 'action' | 'proposalStatus' | 'proposedRole' | 'permissions'> & {
    missionRef: string;
    authorizations: (Omit<BoardMission['authorizations'][number], 'id'> & {authorizationRef: string})[];
    observations: (Pick<BoardMission['observations'][number], 'status' | 'startedAt' | 'finishedAt'> & {
      authorizationRef: string; evidencePresent: boolean;
    })[];
  };
}
export interface ReadData {
  get_runtime_status: RuntimeStatus;
  list_recent_jobs: {items: RecentJob[]; total: number; truncated: boolean};
  get_guardian_summary: {items: GuardianObservation[]; counts: Record<GuardianVerdict, number>; total: number; truncated: boolean};
  get_mission_snapshot: MissionObservation;
}
export type ReadResult<T> = {schemaVersion: 'guardian-read/1'; executionAuthorized: false} & (
  {ok: true; observedAt: string; data: T} | {ok: false; error: {code: ReadErrorCode; message: string}});

const limit = {type: 'integer', minimum: 1, maximum: READ_LIMITS.maxLimit, default: READ_LIMITS.defaultLimit} as const;
const since = {type: 'string', format: 'date-time', pattern: '^\\d{4}-\\d\\d-\\d\\dT\\d\\d:\\d\\d:\\d\\d\\.\\d{3}Z$',
  description: 'Canonical UTC ISO timestamp, inclusive.'} as const;
const objectSchema = (properties: Record<string, unknown>) => ({type: 'object', additionalProperties: false, properties} as const);
/** Transport-neutral contracts. No MCP server, endpoint, executor or authority is registered. */
export const READ_TOOL_CONTRACTS = Object.freeze({
  get_runtime_status: {readOnly: true, inputSchema: objectSchema({})},
  list_recent_jobs: {readOnly: true, inputSchema: objectSchema({limit, status: {enum: JOB_STATUSES}, action: {enum: JOB_ACTIONS}, since})},
  get_guardian_summary: {readOnly: true, inputSchema: objectSchema({limit, verdict: {enum: VERDICTS},
    jobRef: {type: 'string', pattern: '^job-[a-f0-9]{32}$'}, since})},
  get_mission_snapshot: {readOnly: true, inputSchema: objectSchema({})},
});
