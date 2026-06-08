import { describe, it, expect } from 'vitest';
import { cleanJson, extractJson, stripComments } from './clean-json';

describe('extractJson', () => {
  it('returns clean JSON as-is', () => {
    const input = '{"goal":"test"}';
    expect(extractJson(input)).toBe('{"goal":"test"}');
  });

  it('extracts JSON wrapped in markdown code block', () => {
    const input = 'Some text\n```json\n{"goal":"test"}\n```\nMore text';
    expect(extractJson(input)).toBe('{"goal":"test"}');
  });

  it('extracts JSON from plain code block without language tag', () => {
    const input = '```\n{"goal":"test"}\n```';
    expect(extractJson(input)).toBe('{"goal":"test"}');
  });

  it('extracts JSON embedded in surrounding text', () => {
    const input = 'Sure! Here is the JSON:\n{"goal":"test"}\nHope that helps!';
    expect(extractJson(input)).toBe('{"goal":"test"}');
  });

  it('extracts a greedy JSON block from mixed text (matches longest brace span)', () => {
    // NOTE: current regex is greedy; this test documents the actual behavior.
    const input = '{"first":1} some text {"second":2}';
    expect(extractJson(input)).toBe('{"first":1} some text {"second":2}');
  });

  it('trims whitespace around extracted JSON', () => {
    const input = '  \n  {"goal":"test"}  \n  ';
    expect(extractJson(input)).toBe('{"goal":"test"}');
  });

  it('returns the trimmed input when no JSON is found', () => {
    const input = 'just plain text without braces';
    expect(extractJson(input)).toBe('just plain text without braces');
  });

  it('handles an empty string', () => {
    expect(extractJson('')).toBe('');
  });
});

describe('stripComments', () => {
  it('removes single-line comments', () => {
    const input = '{"goal":"test"} // this is a comment';
    expect(stripComments(input)).toBe('{"goal":"test"} ');
  });

  it('removes multi-line comments', () => {
    const input = '/* start */ {"goal":"test"} /* end */';
    expect(stripComments(input)).toBe(' {"goal":"test"} ');
  });

  it('removes both types of comments in the same text', () => {
    const input = '{"a":1} // line\n/* block */ {"b":2}';
    expect(stripComments(input)).toBe('{"a":1} \n {"b":2}');
  });

  it('leaves text without comments unchanged', () => {
    const input = '{"goal":"test"}';
    expect(stripComments(input)).toBe('{"goal":"test"}');
  });

  it('handles an empty string', () => {
    expect(stripComments('')).toBe('');
  });
});

describe('cleanJson', () => {
  it('parses clean valid JSON', () => {
    const result = cleanJson('{"goal":"test"}');
    expect(result).toEqual({ goal: 'test' });
  });

  it('parses JSON wrapped in markdown block', () => {
    const input = '```json\n{"goal":"test"}\n```';
    const result = cleanJson(input);
    expect(result).toEqual({ goal: 'test' });
  });

  it('parses JSON with surrounding text', () => {
    const input = 'Here you go: {"goal":"test"} Enjoy!';
    const result = cleanJson(input);
    expect(result).toEqual({ goal: 'test' });
  });

  it('parses JSON with single-line comments', () => {
    const input = '{"goal":"test"} // comment';
    const result = cleanJson(input);
    expect(result).toEqual({ goal: 'test' });
  });

  it('parses JSON with multi-line comments', () => {
    const input = '/* intro */ {"goal":"test"} /* outro */';
    const result = cleanJson(input);
    expect(result).toEqual({ goal: 'test' });
  });

  it('throws on empty input', () => {
    expect(() => cleanJson('')).toThrow('cleanJson: no se pudo parsear JSON');
  });

  it('throws on invalid JSON', () => {
    expect(() => cleanJson('not json')).toThrow('cleanJson: no se pudo parsear JSON');
  });

  it('parses arrays when present', () => {
    const input = '```json\n[1, 2, 3]\n```';
    const result = cleanJson<number[]>(input);
    expect(result).toEqual([1, 2, 3]);
  });

  it('throws when greedy match spans multiple JSON blocks with text between', () => {
    // NOTE: current regex is greedy, so it matches {"first":1} extra {"second":2}
    // which is not valid JSON. This test documents the current limitation.
    const input = '{"first":1} extra {"second":2}';
    expect(() => cleanJson(input)).toThrow('cleanJson: no se pudo parsear JSON');
  });
});
