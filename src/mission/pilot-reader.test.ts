import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({realpath: vi.fn(), open: vi.fn(), execFile: vi.fn()}));
vi.mock('fs/promises', () => ({realpath: mocks.realpath, open: mocks.open}));
vi.mock('child_process', () => ({execFile: mocks.execFile}));
import { inspectPilot, PILOT } from './pilot';

describe('fixed evidence reader boundary', () => {
  beforeEach(() => { vi.resetAllMocks(); });
  it('rejects symlink redirection before reading or spawning git', async () => {
    mocks.realpath.mockResolvedValue('/tmp/untrusted');
    const result = await inspectPilot();
    expect(result.mission.status).toBe('blocked');
    expect(mocks.open).not.toHaveBeenCalled();
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
  it('blocks a missing file without exposing underlying error details', async () => {
    mocks.realpath.mockRejectedValue(new Error('private details'));
    const result = await inspectPilot();
    expect(result.errors).toEqual(['PILOT_READ_FAILED']);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
  it('rejects oversized evidence and closes its descriptor', async () => {
    mocks.realpath.mockImplementation(async p => p);
    const close = vi.fn(); const readFile = vi.fn();
    mocks.open.mockResolvedValue({stat: async () => ({isFile: () => true, size: 1024*1024+1}), close, readFile});
    expect((await inspectPilot()).environmentVerified).toBe(false);
    expect(close).toHaveBeenCalledOnce(); expect(readFile).not.toHaveBeenCalled();
    expect(mocks.open.mock.calls[0][0]).toBe(PILOT.evidenceFile);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
  it('blocks malformed JSON and closes its descriptor', async () => {
    mocks.realpath.mockImplementation(async p => p);
    const close = vi.fn();
    mocks.open.mockResolvedValue({stat: async () => ({isFile: () => true, size: 12}), close, readFile: async () => '{broken'});
    expect((await inspectPilot()).mission.status).toBe('blocked');
    expect(close).toHaveBeenCalledOnce(); expect(mocks.execFile).not.toHaveBeenCalled();
  });
});
