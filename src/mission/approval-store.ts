import fs from 'node:fs';
import path from 'node:path';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { ApprovalEvent, replayApprovals } from './approval-history';
import { Action, actions, safeId } from './contracts';

export interface ApprovalPolicy { repositoryAliases: string[]; allowedActions: Action[] }
function validPolicy(p: any): p is ApprovalPolicy {
  return p && Object.keys(p).sort().join(',') === 'allowedActions,repositoryAliases' &&
    Array.isArray(p.repositoryAliases) && p.repositoryAliases.length > 0 && p.repositoryAliases.length <= 100 &&
    p.repositoryAliases.every(safeId) && new Set(p.repositoryAliases).size === p.repositoryAliases.length &&
    Array.isArray(p.allowedActions) && p.allowedActions.length > 0 && p.allowedActions.length <= actions.length &&
    p.allowedActions.every((a: Action) => actions.includes(a)) && new Set(p.allowedActions).size === p.allowedActions.length;
}

const LIMIT = 4 * 1024 * 1024;
function uid(): number {
  if (!process.geteuid) throw new Error('UNSUPPORTED_APPROVAL_HOST');
  return process.geteuid();
}
function privateEntry(file: string, directory: boolean): void {
  const s = fs.lstatSync(file);
  if (s.uid !== uid() || (s.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
      (directory ? !s.isDirectory() : !s.isFile() || s.nlink !== 1)) {
    throw new Error('UNSAFE_APPROVAL_STORE');
  }
}
function readPrivate(file: string): Buffer {
  privateEntry(file, false);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const s = fs.fstatSync(fd);
    if (!s.isFile() || s.uid !== uid() || s.nlink !== 1 || (s.mode & 0o777) !== 0o600 || s.size > LIMIT) {
      throw new Error('UNSAFE_APPROVAL_STORE');
    }
    return fs.readFileSync(fd);
  } finally { fs.closeSync(fd); }
}
function writeExclusive(file: string, data: string | Buffer): void {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Private POSIX host storage, never a path selected by a mission or LLM.
 * Integrity is relative to the owner's private key, not protection against that same OS user,
 * root, key theft or restoration of an entire old store. Authentication is a separate boundary.
 */
export class ApprovalStore {
  readonly directory: string;
  constructor(directory: string) {
    const resolved = path.resolve(directory);
    // Canonicalize the existing parent (e.g. macOS /tmp), but never follow a store symlink.
    this.directory = path.join(fs.realpathSync(path.dirname(resolved)), path.basename(resolved));
  }
  private file(name: string): string { return path.join(this.directory, name); }

  initialize(policy: ApprovalPolicy): void {
    if (!validPolicy(policy)) throw new Error('INVALID_APPROVAL_POLICY');
    // Never reinitialize or repair an existing, incomplete, or corrupt store automatically.
    fs.mkdirSync(this.directory, {mode: 0o700});
    privateEntry(this.directory, true);
    writeExclusive(this.file('key'), randomBytes(32));
    this.save([], policy);
  }

  private key(): Buffer {
    privateEntry(this.directory, true);
    const key = readPrivate(this.file('key'));
    if (key.length !== 32) throw new Error('INVALID_APPROVAL_KEY');
    return key;
  }

  private document(): {events: ApprovalEvent[]; policy: ApprovalPolicy} {
    const key = this.key();
    try {
      const envelope = JSON.parse(readPrivate(this.file('history.json')).toString('utf8'));
      if (!envelope || Object.keys(envelope).sort().join(',') !== 'mac,payload' ||
          typeof envelope.payload !== 'string' || typeof envelope.mac !== 'string' ||
          !/^[a-f0-9]{64}$/.test(envelope.mac)) throw new Error();
      const expected = createHmac('sha256', key).update(envelope.payload).digest();
      if (!timingSafeEqual(expected, Buffer.from(envelope.mac, 'hex'))) throw new Error();
      const data = JSON.parse(envelope.payload);
      if (Object.keys(data).sort().join(',') !== 'events,ownerUid,policy,version' || data.version !== 1 || data.ownerUid !== uid() || !validPolicy(data.policy)) throw new Error();
      replayApprovals(data.events);
      return {events: data.events, policy: data.policy};
    } catch { throw new Error('APPROVAL_STORE_INVALID'); }
  }

  history(): ApprovalEvent[] { return this.document().events; }
  policy(): ApprovalPolicy { return this.document().policy; }

  snapshots() { return replayApprovals(this.history()); }

  /** Trusted host only. The authentication adapter constructs the event after confirmation.
   * Exclusive lock + expected sequence prevent lost updates and stale confirmations.
   */
  append(event: ApprovalEvent): void {
    this.exclusive(() => {
      const {events, policy} = this.document();
      const next = [...events, structuredClone(event)];
      replayApprovals(next);
      this.save(next, policy);
    });
  }

  /** Also usable by a supervised host to serialize a short action against revocation.
   * Synchronous only: do not return a Promise or invoke untrusted callbacks.
   */
  exclusive<T>(operation: () => T): T {
    privateEntry(this.directory, true);
    const lock = this.file('lock');
    try { fs.mkdirSync(lock, {mode: 0o700}); } catch { throw new Error('APPROVAL_STORE_BUSY'); }
    try {
      const result = operation();
      if (result && typeof (result as any).then === 'function') throw new Error('ASYNC_APPROVAL_TRANSACTION');
      return result;
    } finally { fs.rmdirSync(lock); }
  }

  private save(events: ApprovalEvent[], policy: ApprovalPolicy): void {
    const payload = JSON.stringify({version: 1, ownerUid: uid(), policy, events});
    const mac = createHmac('sha256', this.key()).update(payload).digest('hex');
    const data = JSON.stringify({payload, mac}) + '\n';
    if (Buffer.byteLength(data) > LIMIT) throw new Error('APPROVAL_STORE_FULL');
    const temporary = this.file(`history-${randomUUID()}.tmp`);
    try {
      writeExclusive(temporary, data);
      fs.renameSync(temporary, this.file('history.json'));
      const fd = fs.openSync(this.directory, fs.constants.O_RDONLY);
      try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
}
