import { WorkerJobState } from "../worker/types";

export type GuardianVerdict = "PASS" | "WARN" | "BLOCKED" | "HUMAN_REVIEW";
export type GuardianFindingSeverity = "info" | "warn" | "error" | "human_review";

export interface GuardianReviewInput {
  reviewId: string;
  workerJobId: string;
}

export interface GuardianFinding {
  code: string;
  severity: GuardianFindingSeverity;
  message: string;
  field?: string;
  expected?: unknown;
  actual?: unknown;
}

export interface GuardianReview {
  reviewId: string;
  workerJobId: string;
  verdict: GuardianVerdict;
  reviewedAt: string;
  policyVersion: "guardian-evidence-v0.1";
  findings: GuardianFinding[];
  summary: string;
}

export interface GuardianReviewContext {
  workerJob: WorkerJobState;
  worktreeRoot: string;
}
