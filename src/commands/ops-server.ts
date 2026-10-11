import { ParsedArgs } from "../cli/parse-args";
import { DEFAULT_OPS_HOST, DEFAULT_OPS_PORT, startOpsServer } from "../ops/server";
import { error } from "../utils/logger";

function stringFlag(args: ParsedArgs, key: string): string | undefined {
  const value = args.flags[key];
  return typeof value === "string" ? value : undefined;
}

function portFlag(args: ParsedArgs): number {
  const raw = stringFlag(args, "port");
  if (!raw) return DEFAULT_OPS_PORT;
  if (!/^\d+$/.test(raw)) return DEFAULT_OPS_PORT;
  const parsed = Number.parseInt(raw, 10);
  return parsed > 0 && parsed <= 65535 ? parsed : DEFAULT_OPS_PORT;
}

export async function opsServerCommand(args: ParsedArgs): Promise<number> {
  try {
    const host = stringFlag(args, "host") ?? DEFAULT_OPS_HOST;
    const started = await startOpsServer({ host, port: portFlag(args) });
    process.stdout.write(`AMON Ops snapshot server listening on http://${started.host}:${started.port}/api/ops/snapshot\n`);

    return new Promise<number>((resolve) => {
      let shuttingDown = false;
      const shutdown = async (): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        process.off("SIGINT", shutdown);
        process.off("SIGTERM", shutdown);
        await started.close();
        resolve(0);
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
  } catch (err) {
    error(`[amon ops-server] ${(err as Error).message}`);
    return 1;
  }
}
