import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApprovalStore } from './approval-store';
import { ApprovalEvent } from './approval-history';
import { fixture } from './demo/fixtures';

const roots: string[] = [];
function setup() {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-store-test-'));
  roots.push(parent);
  const store = new ApprovalStore(path.join(parent, 'private'));
  store.initialize({repositoryAliases: ['LOCAL-FIXTURE'], allowedActions: ['diagnose', 'verify']});
  const authorization = fixture().c.authorizations[0];
  authorization.issuedAt = authorization.approvedAt!;
  const event: ApprovalEvent = {sequence: 1, recordedAt: authorization.approvedAt!,
    actorId: authorization.approvedBy, kind: 'approved', authorization};
  return {parent, store, event, file: (name: string) => path.join(store.directory, name)};
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) fs.rmSync(root, {recursive: true, force: true});
});

describe('private durable approval history', () => {
  it('survives reopening and another process without printing credentials', () => {
    const {store, event} = setup();
    store.append(event);
    const reopened = new ApprovalStore(store.directory);
    expect(reopened.snapshots()).toEqual([event.authorization]);
    const output = execFileSync(process.execPath, ['-r', 'ts-node/register', '-e',
      "const {ApprovalStore}=require('./src/mission/approval-store'); const s=new ApprovalStore(process.argv[1]); process.stdout.write(JSON.stringify(s.snapshots().map(a=>a.decision)));",
      store.directory], {cwd: process.cwd(), encoding: 'utf8'});
    expect(JSON.parse(output)).toEqual(['approved']);
  }, 15000);
  it('persists revocation and retains both audit events', () => {
    const {store, event} = setup();
    store.append(event);
    store.append({...event, sequence: 2, kind: 'revoked', recordedAt: '2026-11-11T12:00:00.000Z',
      authorization: {...event.authorization, decision: 'revoked'}});
    const reopened = new ApprovalStore(store.directory);
    expect(reopened.history()).toHaveLength(2);
    expect(reopened.snapshots()[0].decision).toBe('revoked');
  });
  it('fails closed after payload tampering', () => {
    const {store, event, file} = setup();
    store.append(event);
    const envelope = JSON.parse(fs.readFileSync(file('history.json'), 'utf8'));
    envelope.payload = envelope.payload.replace('approved', 'revoked');
    fs.writeFileSync(file('history.json'), JSON.stringify(envelope));
    expect(() => store.snapshots()).toThrow('APPROVAL_STORE_INVALID');
    expect(() => store.append({...event, sequence: 2})).toThrow();
  });
  it.each(['history.json', 'key'])('rejects missing %s without regenerating it', name => {
    const {store, file} = setup();
    fs.unlinkSync(file(name));
    expect(() => store.history()).toThrow();
    expect(() => store.initialize({repositoryAliases: ['LOCAL-FIXTURE'], allowedActions: ['diagnose', 'verify']})).toThrow();
    expect(fs.existsSync(file(name))).toBe(false);
  });
  it.each(['history.json', 'key'])('rejects permissive modes for %s', name => {
    const {store, file} = setup();
    fs.chmodSync(file(name), 0o644);
    expect(() => store.history()).toThrow();
  });
  it.each(['history.json', 'key'])('rejects symlink redirection of %s', name => {
    const {store, parent, file} = setup();
    const target = path.join(parent, name);
    fs.renameSync(file(name), target);
    fs.symlinkSync(target, file(name));
    expect(() => store.history()).toThrow();
  });
  it('rejects unsafe directory permissions and root symlinks', () => {
    const {store, parent} = setup();
    const alias = path.join(parent, 'alias');
    fs.symlinkSync(store.directory, alias);
    expect(() => new ApprovalStore(alias).history()).toThrow();
    fs.chmodSync(store.directory, 0o755);
    expect(() => store.history()).toThrow('UNSAFE_APPROVAL_STORE');
  });
  it('rejects a competing writer and preserves a stale lock for manual inspection', () => {
    const {store, event, file} = setup();
    store.exclusive(() => {
      expect(() => new ApprovalStore(store.directory).append(event)).toThrow('APPROVAL_STORE_BUSY');
    });
    fs.mkdirSync(file('lock'), {mode: 0o700});
    expect(() => store.append(event)).toThrow('APPROVAL_STORE_BUSY');
    expect(fs.existsSync(file('lock'))).toBe(true);
    expect(store.history()).toEqual([]);
  });
  it('rejects a confirmation based on an old sequence', () => {
    const {store, event} = setup();
    store.append(event);
    const stale = {...event, authorization: {...event.authorization, authorizationId: 'OTHER'}};
    expect(() => store.append(stale)).toThrow('INVALID_APPROVAL_HISTORY');
    expect(store.history()).toHaveLength(1);
  });
  it('preserves the old journal if atomic replacement fails and releases its lock', () => {
    const {store, event, file} = setup();
    const before = fs.readFileSync(file('history.json'));
    vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('SIMULATED_IO_FAILURE'); });
    expect(() => store.append(event)).toThrow('SIMULATED_IO_FAILURE');
    expect(fs.readFileSync(file('history.json'))).toEqual(before);
    expect(fs.readdirSync(store.directory).sort()).toEqual(['history.json', 'key']);
    store.append(event);
    expect(store.history()).toHaveLength(1);
  });
  it('rejects truncated journals and hard-linked credentials', () => {
    const {store, file, parent} = setup();
    fs.writeFileSync(file('history.json'), '{');
    expect(() => store.history()).toThrow('APPROVAL_STORE_INVALID');
    fs.linkSync(file('key'), path.join(parent, 'linked-key'));
    expect(() => store.history()).toThrow('UNSAFE_APPROVAL_STORE');
  });
});
