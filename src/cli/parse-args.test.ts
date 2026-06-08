import { describe, it, expect } from 'vitest';
import { parseArgs, ParsedArgs } from './parse-args';

describe('parseArgs', () => {
  it('returns empty result for empty argv', () => {
    const result = parseArgs([]);
    expect(result).toEqual<ParsedArgs>({ positional: [], flags: {} });
  });

  it('parses positional arguments only', () => {
    const result = parseArgs(['run', 'fix', 'the', 'login']);
    expect(result.positional).toEqual(['run', 'fix', 'the', 'login']);
    expect(result.flags).toEqual({});
  });

  it('parses a flag with a value', () => {
    const result = parseArgs(['--task', 'TASK-001']);
    expect(result.flags).toEqual({ task: 'TASK-001' });
    expect(result.positional).toEqual([]);
  });

  it('parses a boolean flag when next arg is another flag', () => {
    const result = parseArgs(['--verbose', '--task', 'TASK-001']);
    expect(result.flags).toEqual({ verbose: true, task: 'TASK-001' });
    expect(result.positional).toEqual([]);
  });

  it('parses a boolean flag when it is the last argument', () => {
    const result = parseArgs(['--dry-run']);
    expect(result.flags).toEqual({ 'dry-run': true });
    expect(result.positional).toEqual([]);
  });

  it('parses mixed positional and flags', () => {
    const result = parseArgs(['run', '--task', 'TASK-001', 'fix login']);
    expect(result.positional).toEqual(['run', 'fix login']);
    expect(result.flags).toEqual({ task: 'TASK-001' });
  });

  it('parses multiple flags with values', () => {
    const result = parseArgs([
      '--task',
      'TASK-001',
      '--type',
      'feature_small',
      '--repo',
      'sentinel-board',
    ]);
    expect(result.flags).toEqual({
      task: 'TASK-001',
      type: 'feature_small',
      repo: 'sentinel-board',
    });
    expect(result.positional).toEqual([]);
  });

  it('handles flags interleaved with positional args', () => {
    const result = parseArgs([
      'run',
      '--task',
      'TASK-001',
      'descripcion',
      'libre',
      '--type',
      'bugfix',
    ]);
    expect(result.positional).toEqual(['run', 'descripcion', 'libre']);
    expect(result.flags).toEqual({ task: 'TASK-001', type: 'bugfix' });
  });

  it('handles a flag with an empty string value', () => {
    const result = parseArgs(['--task', '']);
    expect(result.flags).toEqual({ task: '' });
  });

  it('treats a lone dash as positional', () => {
    const result = parseArgs(['-']);
    expect(result.positional).toEqual(['-']);
    expect(result.flags).toEqual({});
  });

  it('treats single dash prefix as positional (not a flag)', () => {
    const result = parseArgs(['-v']);
    expect(result.positional).toEqual(['-v']);
    expect(result.flags).toEqual({});
  });
});
