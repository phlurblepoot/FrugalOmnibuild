// src/pages/project/proposal/proposalTextHistory.test.ts
import { describe, it, expect } from 'vitest';
import { PROPOSAL_TEXT_HISTORY_MAX, pushHistory, parseHistory } from './proposalTextHistory';

describe('pushHistory', () => {
  it('pushes a new entry to the front', () => {
    const result = pushHistory(['a', 'b'], 'c');
    expect(result).toEqual(['c', 'a', 'b']);
  });

  it('trims whitespace before pushing', () => {
    const result = pushHistory([], '  hello  ');
    expect(result).toEqual(['hello']);
  });

  it('skips an empty entry and returns the SAME reference', () => {
    const history = ['a', 'b'];
    const result = pushHistory(history, '   ');
    expect(result).toBe(history);
  });

  it('dedups by exact trimmed match, moving the dup to the front', () => {
    const result = pushHistory(['a', 'b', 'c'], 'b');
    expect(result).toEqual(['b', 'a', 'c']);
  });

  it('dedup matches after trimming the incoming entry', () => {
    const result = pushHistory(['a', 'b', 'c'], '  b  ');
    expect(result).toEqual(['b', 'a', 'c']);
  });

  it('is a no-op returning the SAME reference when entry is already at front', () => {
    const history = ['a', 'b', 'c'];
    const result = pushHistory(history, 'a');
    expect(result).toBe(history);
  });

  it('caps at PROPOSAL_TEXT_HISTORY_MAX, dropping the oldest', () => {
    const history = ['1', '2', '3', '4', '5'];
    expect(history.length).toBe(PROPOSAL_TEXT_HISTORY_MAX);
    const result = pushHistory(history, '6');
    expect(result).toEqual(['6', '1', '2', '3', '4']);
    expect(result.length).toBe(PROPOSAL_TEXT_HISTORY_MAX);
  });

  it('honours an explicit cap', () => {
    const history = ['1', '2', '3'];
    expect(pushHistory(history, '4', 2)).toEqual(['4', '1']);
  });

  it('returns a NEW array (not mutating the input) on a normal push', () => {
    const history = ['a', 'b'];
    const result = pushHistory(history, 'c');
    expect(result).not.toBe(history);
    expect(history).toEqual(['a', 'b']);
  });
});

describe('parseHistory', () => {
  it('parses a valid JSON string array', () => {
    expect(parseHistory('["a","b","c"]')).toEqual(['a', 'b', 'c']);
  });

  it('undefined input → []', () => {
    expect(parseHistory(undefined)).toEqual([]);
  });

  it('malformed JSON → []', () => {
    expect(parseHistory('not-json{{{')).toEqual([]);
  });

  it('valid JSON that is not an array → []', () => {
    expect(parseHistory('{"a":1}')).toEqual([]);
  });

  it('array containing non-string junk → junk filtered out', () => {
    expect(parseHistory('["a", 1, null, "b", {}, "c"]')).toEqual(['a', 'b', 'c']);
  });

  it('empty string → []', () => {
    expect(parseHistory('')).toEqual([]);
  });
});
