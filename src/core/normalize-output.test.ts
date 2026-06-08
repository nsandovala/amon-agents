import { describe, it, expect } from 'vitest';
import { normalizeOutput } from './normalize-output';
import { StandardOutput } from './types';

describe('normalizeOutput', () => {
  it('passes through valid string and array fields', () => {
    const input = {
      goal: 'Create login',
      scope: 'Auth module only',
      files_to_touch: ['src/auth.ts'],
      plan: ['Step 1'],
      risks: ['Leak'],
      validations: ['Check'],
      done_when: ['Merged'],
    };
    const result = normalizeOutput(input);
    expect(result).toEqual<StandardOutput>({
      goal: 'Create login',
      scope: 'Auth module only',
      files_to_touch: ['src/auth.ts'],
      plan: ['Step 1'],
      risks: ['Leak'],
      validations: ['Check'],
      done_when: ['Merged'],
    });
  });

  it('normalizes object fields to JSON strings when expected as string', () => {
    const input = {
      goal: { nested: 'value' },
      scope: 'scope',
      files_to_touch: [],
      plan: [],
      risks: [],
      validations: [],
      done_when: [],
    };
    const result = normalizeOutput(input);
    expect(result.goal).toBe('{"nested":"value"}');
  });

  it('normalizes non-string primitives to strings when expected as string', () => {
    const input = {
      goal: 123,
      scope: true,
      files_to_touch: [],
      plan: [],
      risks: [],
      validations: [],
      done_when: [],
    };
    const result = normalizeOutput(input);
    expect(result.goal).toBe('123');
    expect(result.scope).toBe('true');
  });

  it('normalizes a string to an array with one element when array expected', () => {
    const input = {
      goal: 'g',
      scope: 's',
      files_to_touch: 'src/auth.ts',
      plan: ['p'],
      risks: ['r'],
      validations: ['v'],
      done_when: ['d'],
    };
    const result = normalizeOutput(input);
    expect(result.files_to_touch).toEqual(['src/auth.ts']);
  });

  it('normalizes an object to an array of its values when array expected', () => {
    const input = {
      goal: 'g',
      scope: 's',
      files_to_touch: { a: 'src/a.ts', b: 'src/b.ts' },
      plan: ['p'],
      risks: ['r'],
      validations: ['v'],
      done_when: ['d'],
    };
    const result = normalizeOutput(input);
    expect(result.files_to_touch).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('normalizes non-string items inside arrays to strings', () => {
    const input = {
      goal: 'g',
      scope: 's',
      files_to_touch: [1, true, { path: 'x' }],
      plan: [],
      risks: [],
      validations: [],
      done_when: [],
    };
    const result = normalizeOutput(input);
    expect(result.files_to_touch).toEqual(['1', 'true', '{"path":"x"}']);
  });

  it('uses empty defaults when fields are missing', () => {
    const input = {};
    const result = normalizeOutput(input);
    expect(result.goal).toBe('');
    expect(result.scope).toBe('');
    expect(result.files_to_touch).toEqual([]);
    expect(result.plan).toEqual([]);
    expect(result.risks).toEqual([]);
    expect(result.validations).toEqual([]);
    expect(result.done_when).toEqual([]);
  });

  it('preserves extra fields beyond StandardOutput', () => {
    const input = {
      goal: 'g',
      scope: 's',
      files_to_touch: [],
      plan: [],
      risks: [],
      validations: [],
      done_when: [],
      verdict: 'APPROVED',
      score: 85,
    };
    const result = normalizeOutput(input) as Record<string, unknown>;
    expect(result.verdict).toBe('APPROVED');
    expect(result.score).toBe(85);
  });

  it('throws when input is not an object', () => {
    expect(() => normalizeOutput(null)).toThrow('normalizeOutput: expected object, got object');
    expect(() => normalizeOutput('string')).toThrow('normalizeOutput: expected object, got string');
    expect(() => normalizeOutput(42)).toThrow('normalizeOutput: expected object, got number');
  });
});
