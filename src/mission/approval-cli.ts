#!/usr/bin/env node
import fs from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { Action, actions, parseMission } from './contracts';
import { ApprovalStore } from './approval-store';
import { approveLocal, localApproverId, revokeLocal } from './approval-host';

/** Local interactive boundary. No --yes flag, environment grant or piped approval. */
async function confirmation(preview: string, challenge: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new Error('INTERACTIVE_APPROVAL_REQUIRED');
  const terminal = createInterface({input: process.stdin, output: process.stdout});
  try {
    process.stdout.write(`${preview}\nPara confirmar, escribe exactamente:\n${challenge}\n`);
    return await terminal.question('Confirmación (otra respuesta cancela): ');
  } finally { terminal.close(); }
}

export function readMissionFile(file: string) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) throw new Error('INVALID_MISSION_FILE');
    return parseMission(JSON.parse(fs.readFileSync(fd, 'utf8')));
  } finally { fs.closeSync(fd); }
}

export async function approvalCli(args: string[]): Promise<void> {
  if (args.length === 1 && args[0] === 'identity') { process.stdout.write(localApproverId() + '\n'); return; }
  const [command, directory, ...rest] = args;
  if (!directory || !['init','approve','revoke','history'].includes(command)) throw new Error('APPROVAL_USAGE');
  const store = new ApprovalStore(directory);
  if (command === 'init' && rest.length === 2) {
    store.initialize({repositoryAliases: rest[0].split(','), allowedActions: rest[1].split(',') as Action[]});
    process.stdout.write('Registro privado creado. No se concedieron aprobaciones.\n');
  } else if (command === 'approve' && rest.length === 4 && actions.includes(rest[2] as Action)) {
    const event = await approveLocal(store, readMissionFile(rest[0]), rest[1], rest[2] as Action, rest[3], confirmation);
    process.stdout.write(JSON.stringify({authorizationId: event.authorization.authorizationId, decision: event.kind}) + '\n');
  } else if (command === 'revoke' && rest.length === 1) {
    const event = await revokeLocal(store, rest[0], confirmation);
    process.stdout.write(JSON.stringify({authorizationId: event.authorization.authorizationId, decision: event.kind}) + '\n');
  } else if (command === 'history' && rest.length === 0) {
    process.stdout.write(JSON.stringify(store.history(), null, 2) + '\n');
  } else throw new Error('APPROVAL_USAGE');
}

if (require.main === module) approvalCli(process.argv.slice(2)).catch(error => {
  const code = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'APPROVAL_COMMAND_FAILED';
  process.stderr.write(code + '\n');
  process.exitCode = 1;
});
