export type WorkerAvailabilityStatus = "online" | "offline";

export interface WorkerResources {
  cpuCount: number;
  totalMemoryMb: number;
  freeMemoryMb: number;
}

export interface WorkerWorkspace {
  root: string | null;
  available: boolean;
}

export interface WorkerToolStatus {
  name: string;
  available: boolean;
  version?: string;
  path?: string;
}

export interface WorkerOllamaStatus {
  available: boolean;
  reachable: boolean;
  endpoint: string;
  activeModel: string;
  installedModels: string[];
  detail?: string;
}

export interface WorkerStatus {
  workerId: string;
  hostname: string;
  status: WorkerAvailabilityStatus;
  platform: NodeJS.Platform;
  arch: string;
  nodeVersion: string;
  cwd: string;
  resources: WorkerResources;
  workspace: WorkerWorkspace;
  tools: WorkerToolStatus[];
  ollama: WorkerOllamaStatus;
  startedAt: string;
  lastHeartbeatAt: string;
}

export type WorkerJobAction = "inspect_repo";
export type WorkerJobStatus = "queued" | "running" | "done" | "failed";

export interface WorkerJob {
  jobId: string;
  action: WorkerJobAction;
  repo: string;
  createdAt?: string;
}

export interface InspectRepoEvidence {
  repoPath: string;
  repoExists: boolean;
  isGitRepo: boolean;
  branch: string | null;
  headSha: string | null;
  gitStatusShort: string;
  gitStatusBranch: string;
  dirty: boolean;
  timestamp: string;
}

export interface WorkerJobTransition {
  status: WorkerJobStatus;
  at: string;
}

export interface WorkerJobState {
  jobId: string;
  action: string;
  repo: string;
  status: WorkerJobStatus;
  createdAt?: string;
  queuedAt?: string;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  exitCode?: number;
  error?: string;
  evidence?: InspectRepoEvidence;
  transitions: WorkerJobTransition[];
}
