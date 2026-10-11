import { GuardianVerdict } from "../guardian/types";

export type OperationalSystemStatus = "ok" | "degraded";
export type AgentOperationalState = "available" | "working" | "reviewing" | "waiting_human" | "blocked" | "offline";

export interface ToolProjection {
  name: string;
  available: boolean;
  version?: string;
}

export interface WorkerProjection {
  workerId: string;
  status: string;
  platform: string;
  arch: string;
  workspace: {
    root: string | null;
    available: boolean;
  };
  lastHeartbeat: string;
  tools: ToolProjection[];
}

export interface JobProjection {
  jobId: string;
  action: string;
  status: string;
  repo: string;
  worktreePath?: string;
  tool?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  guardianVerdict?: GuardianVerdict;
  requiresHumanReview: boolean;
}

export interface GuardianProjection {
  reviewId: string;
  workerJobId: string;
  verdict: GuardianVerdict;
  policyVersion: string;
  reviewedAt: string;
  findingsCount: number;
}

export interface AgentProjection {
  agentId: "jarvis" | "claudio" | "guardian";
  role: string;
  state: AgentOperationalState;
}

export interface OperationalSnapshot {
  generatedAt: string;
  systemStatus: OperationalSystemStatus;
  workers: WorkerProjection[];
  jobs: JobProjection[];
  guardianReviews: GuardianProjection[];
  agents: AgentProjection[];
}
