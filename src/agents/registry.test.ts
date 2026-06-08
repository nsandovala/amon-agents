import { describe, it, expect } from 'vitest';
import { AGENT_REGISTRY, getAgentExecutor } from './registry';

describe('AGENT_REGISTRY', () => {
  it('has architect implemented', () => {
    expect(typeof AGENT_REGISTRY.architect).toBe('function');
  });

  it('has security implemented', () => {
    expect(typeof AGENT_REGISTRY.security).toBe('function');
  });

  it('has qa implemented', () => {
    expect(typeof AGENT_REGISTRY.qa).toBe('function');
  });

  it('has ops implemented', () => {
    expect(typeof AGENT_REGISTRY.ops).toBe('function');
  });

  it('does not have dev implemented', () => {
    expect(AGENT_REGISTRY.dev).toBeUndefined();
  });

  it('does not have designer implemented', () => {
    expect(AGENT_REGISTRY.designer).toBeUndefined();
  });
});

describe('getAgentExecutor', () => {
  it('returns a function for architect', () => {
    const executor = getAgentExecutor('architect');
    expect(typeof executor).toBe('function');
  });

  it('returns a function for security', () => {
    const executor = getAgentExecutor('security');
    expect(typeof executor).toBe('function');
  });

  it('returns a function for qa', () => {
    const executor = getAgentExecutor('qa');
    expect(typeof executor).toBe('function');
  });

  it('returns a function for ops', () => {
    const executor = getAgentExecutor('ops');
    expect(typeof executor).toBe('function');
  });

  it('throws a clear error for dev', () => {
    expect(() => getAgentExecutor('dev')).toThrow(
      "Agente 'dev' definido en routing pero no implementado en AGENT_REGISTRY"
    );
  });

  it('throws a clear error for designer', () => {
    expect(() => getAgentExecutor('designer')).toThrow(
      "Agente 'designer' definido en routing pero no implementado en AGENT_REGISTRY"
    );
  });
});
