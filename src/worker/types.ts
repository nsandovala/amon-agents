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
