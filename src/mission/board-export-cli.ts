#!/usr/bin/env node
import { ApprovalStore } from './approval-store';
import { exportBoardSnapshot } from './board-export';

export function boardExportCli(args: string[]): void {
  if (args.length !== 3 || args.some(a => !a)) throw Error('BOARD_EXPORT_USAGE');
  exportBoardSnapshot(new ApprovalStore(args[0]), args[1], args[2]);
  process.stdout.write('BOARD_SNAPSHOT_EXPORTED\n');
}
if (require.main === module) try { boardExportCli(process.argv.slice(2)); }
catch { process.stderr.write('BOARD_EXPORT_FAILED\n'); process.exitCode = 1; }
