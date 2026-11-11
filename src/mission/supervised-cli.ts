#!/usr/bin/env node
import fs from 'node:fs';
import { ApprovalStore } from './approval-store';
import { readMissionFile } from './approval-cli';
import { createSupervisedFixture, runSupervisedInspection } from './supervised';

export function supervisedCli(args: string[]): void {
  const [command, directory, ...rest] = args;
  if (!directory || !['setup','run','result'].includes(command)) throw new Error('SUPERVISED_USAGE');
  const store = new ApprovalStore(directory);
  if (command === 'setup' && rest.length === 0) {
    if (!fs.existsSync(store.directory)) store.initialize({repositoryAliases: ['MISSION-TEST'], allowedActions: ['diagnose']});
    const fixture = createSupervisedFixture(store);
    process.stdout.write(JSON.stringify({fixtureId: fixture.fixtureId, missionFile: fixture.missionFile,
      approvalRequired: true, action: 'diagnose', assignmentId: 'inspect-fixture'}, null, 2) + '\n');
  } else if (command === 'run' && rest.length === 2) {
    const result = runSupervisedInspection(store, rest[0], readMissionFile(rest[1]));
    process.stdout.write(JSON.stringify(result,null,2) + '\n');
    if (result.status !== 'completed') process.exitCode = 1;
  } else if (command === 'result' && rest.length === 1) {
    process.stdout.write(JSON.stringify(store.readExecutionRecord(`result-${rest[0]}`),null,2) + '\n');
  } else throw new Error('SUPERVISED_USAGE');
}

if (require.main === module) try { supervisedCli(process.argv.slice(2)); } catch (error) {
  const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'SUPERVISED_COMMAND_FAILED';
  process.stderr.write(code + '\n'); process.exitCode = 1;
}
