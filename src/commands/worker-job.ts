import { ParsedArgs } from "../cli/parse-args";
import { createWorkerJob, formatWorkerJobSummary, runWorkerJob, WorkerJobError } from "../worker/jobs";
import { error } from "../utils/logger";

function stringFlag(args: ParsedArgs, key: string): string | undefined {
  const value = args.flags[key];
  return typeof value === "string" ? value : undefined;
}

export async function workerJobCommand(args: ParsedArgs): Promise<number> {
  try {
    const job = createWorkerJob({
      jobId: stringFlag(args, "job"),
      action: stringFlag(args, "action"),
      repo: stringFlag(args, "repo"),
      branch: stringFlag(args, "branch"),
    });
    const state = await runWorkerJob(job);
    process.stdout.write(formatWorkerJobSummary(state));
    return state.status === "done" ? 0 : 1;
  } catch (err) {
    if (err instanceof WorkerJobError && err.state) {
      process.stdout.write(formatWorkerJobSummary(err.state));
      return 1;
    }
    error(`[amon worker-job] ${(err as Error).message}`);
    return 1;
  }
}
