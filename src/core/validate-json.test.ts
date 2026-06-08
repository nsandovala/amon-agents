import { describe, it, expect } from 'vitest';
import { validateOutput, ValidationResult } from './validate-json';
import { OutputContractYaml } from './types';

const fixtureContract: OutputContractYaml = {
  version: 1,
  default_output: {
    required_fields: ['goal', 'scope', 'files_to_touch', 'plan'],
  },
  field_rules: {
    goal: { description: 'Goal field', type: 'string' },
    scope: { description: 'Scope field', type: 'string' },
    files_to_touch: { description: 'Files field', type: 'list[string]' },
    plan: { description: 'Plan field', type: 'list[string]' },
  },
  agent_specific_notes: {
    architect: { must_emphasize: [] },
    designer: { must_emphasize: [] },
    dev: { must_emphasize: [] },
    qa: { must_emphasize: [] },
    security: { must_emphasize: [] },
    ops: { must_emphasize: [] },
  },
  rules: [],
};

describe('validateOutput (with injected contract)', () => {
  it('returns valid for object with all required fields and correct types', () => {
    const data = {
      goal: 'Create login',
      scope: 'Auth',
      files_to_touch: ['src/auth.ts'],
      plan: ['Step 1'],
    };
    const result = validateOutput(data, fixtureContract);
    expect(result).toEqual<ValidationResult>({ valid: true, errors: [] });
  });

  it('returns invalid for null input', () => {
    const result = validateOutput(null, fixtureContract);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('El output no es un objeto válido.');
  });

  it('returns invalid for non-object input (string)', () => {
    const result = validateOutput('not an object', fixtureContract);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('El output no es un objeto válido.');
  });

  it('reports missing required field', () => {
    const data = {
      goal: 'Create login',
      scope: 'Auth',
      files_to_touch: ['src/auth.ts'],
      // plan is missing
    };
    const result = validateOutput(data, fixtureContract);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Falta campo requerido: "plan"');
  });

  it('reports wrong type for string field', () => {
    const data = {
      goal: 123,
      scope: 'Auth',
      files_to_touch: ['src/auth.ts'],
      plan: ['Step 1'],
    };
    const result = validateOutput(data, fixtureContract);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Campo "goal" debe ser string, recibió number');
  });

  it('reports wrong type for list field (received string)', () => {
    const data = {
      goal: 'Create login',
      scope: 'Auth',
      files_to_touch: 'src/auth.ts',
      plan: ['Step 1'],
    };
    const result = validateOutput(data, fixtureContract);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Campo "files_to_touch" debe ser array, recibió string');
  });

  it('reports non-string items inside list[string]', () => {
    const data = {
      goal: 'Create login',
      scope: 'Auth',
      files_to_touch: ['src/auth.ts', 42, true],
      plan: ['Step 1'],
    };
    const result = validateOutput(data, fixtureContract);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Campo "files_to_touch[1]" debe ser string');
    expect(result.errors).toContain('Campo "files_to_touch[2]" debe ser string');
  });

  it('ignores extra fields with no rule', () => {
    const data = {
      goal: 'Create login',
      scope: 'Auth',
      files_to_touch: ['src/auth.ts'],
      plan: ['Step 1'],
      extra_field: 'whatever',
    };
    const result = validateOutput(data, fixtureContract);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('ignores required fields that have no rule (field_rules absent)', () => {
    const contractWithMissingRule: OutputContractYaml = {
      ...fixtureContract,
      default_output: {
        required_fields: ['goal', 'scope', 'files_to_touch', 'plan', 'unruled'],
      },
    };
    const data = {
      goal: 'Create login',
      scope: 'Auth',
      files_to_touch: ['src/auth.ts'],
      plan: ['Step 1'],
      unruled: 'anything',
    };
    const result = validateOutput(data, contractWithMissingRule);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accumulates multiple errors', () => {
    const data = {
      // goal missing
      scope: 456,
      files_to_touch: 'not-an-array',
      plan: ['Step 1', 99],
    };
    const result = validateOutput(data, fixtureContract);
    expect(result.valid).toBe(false);
    expect(result.errors).toContain('Falta campo requerido: "goal"');
    expect(result.errors).toContain('Campo "scope" debe ser string, recibió number');
    expect(result.errors).toContain('Campo "files_to_touch" debe ser array, recibió string');
    expect(result.errors).toContain('Campo "plan[1]" debe ser string');
  });
});
