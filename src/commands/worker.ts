import { ParsedArgs } from "../cli/parse-args";
import {
  buildWorkerStatus,
  formatWorkerSummary,
  parseHeartbeatMs,
  WorkerHeartbeat,
} from "../worker/host";

export interface WorkerCommandOptions {
  runId?: string;
}

export async function workerCommand(_args: ParsedArgs, options: WorkerCommandOptions = {}): Promise<number> {
  void options;
  const status = await buildWorkerStatus();
  const heartbeat = new WorkerHeartbeat(status, {
    intervalMs: parseHeartbeatMs(),
  });

  process.stdout.write(formatWorkerSummary(status));
  process.stdout.write("  Heartbeat: foreground process, press Ctrl+C to stop.\n\n");

  await heartbeat.start();

  return new Promise<number>((resolve) => {
    let shuttingDown = false;

    const shutdown = async (): Promise<void> => {
      if (shuttingDown) return;
      shuttingDown = true;
      process.off("SIGINT", shutdown);
      process.off("SIGTERM", shutdown);
      await heartbeat.stop();
      process.stdout.write("\n  [amon worker] stopped cleanly\n");
      resolve(0);
    };

    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });
}
