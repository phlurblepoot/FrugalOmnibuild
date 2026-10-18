import { describe, it, expect } from 'vitest';
import { findDuplicatePageNumbers, suffixPageNumber, composePageName, nextPlaceholderStart } from './sheetNaming';

it('flags duplicate non-blank page numbers within one set (case-insensitive)', () => {
  const rows = [
    { id: '1', planSetId: 's1', pageNumber: 'A-101' },
    { id: '2', planSetId: 's1', pageNumber: 'a-101' },  // dup of #1
    { id: '3', planSetId: 's1', pageNumber: 'A-102' },
    { id: '4', planSetId: 's2', pageNumber: 'A-101' },  // different set → ok
    { id: '5', planSetId: 's1', pageNumber: '' },        // blank → exempt
    { id: '6', planSetId: 's1', pageNumber: '' },        // blank → exempt
  ];
  const dups = findDuplicatePageNumbers(rows);
  expect(new Set(dups)).toEqual(new Set(['1', '2']));
});

it('suffixes to the next free " (n)" within the set', () => {
  const taken = new Set(['a-101', 'a-101 (2)']);
  expect(suffixPageNumber('A-101', taken)).toBe('A-101 (3)');
  expect(suffixPageNumber('A-102', taken)).toBe('A-102 (2)');
});

describe('nextPlaceholderStart', () => {
  it('starts at 1 for an empty set', () => {
    expect(nextPlaceholderStart([], 's1')).toBe(1);
  });
  it('starts one past the max numeric page number in the set', () => {
    const pages = [
      { id: '1', planSetId: 's1', pageNumber: '3' },
      { id: '2', planSetId: 's1', pageNumber: '4' },
      { id: '3', planSetId: 's1', pageNumber: '5' },
    ];
    expect(nextPlaceholderStart(pages, 's1')).toBe(6);
  });
  it('ignores non-numeric page numbers, starting at 1', () => {
    const pages = [
      { id: '1', planSetId: 's1', pageNumber: 'A-101' },
      { id: '2', planSetId: 's1', pageNumber: 'A-102' },
    ];
    expect(nextPlaceholderStart(pages, 's1')).toBe(1);
  });
  it('mixed numeric + non-numeric: starts one past the numeric max', () => {
    const pages = [
      { id: '1', planSetId: 's1', pageNumber: 'A-101' },
      { id: '2', planSetId: 's1', pageNumber: '2' },
      { id: '3', planSetId: 's1', pageNumber: '10' },
    ];
    expect(nextPlaceholderStart(pages, 's1')).toBe(11);
  });
  it('ignores pages outside the target plan set', () => {
    const pages = [
      { id: '1', planSetId: 's1', pageNumber: '99' },
      { id: '2', planSetId: 's2', pageNumber: '3' },
    ];
    expect(nextPlaceholderStart(pages, 's2')).toBe(4);
  });
  it('treats undefined planSetId consistently for both pages and target', () => {
    const pages = [
      { id: '1', planSetId: undefined, pageNumber: '7' },
    ];
    expect(nextPlaceholderStart(pages, undefined)).toBe(8);
  });
});

describe('composePageName', () => {
  it('joins number and description', () => {
    expect(composePageName('A-101', 'First Floor Plan')).toBe('A-101 - First Floor Plan');
  });
  it('number only / description only', () => {
    expect(composePageName('A-101', '')).toBe('A-101');
    expect(composePageName('', 'Roof Plan')).toBe('Roof Plan');
  });
  it('both blank → fallback', () => {
    expect(composePageName('', '', 'Page 3')).toBe('Page 3');
    expect(composePageName(undefined, null)).toBe('');
  });
});
