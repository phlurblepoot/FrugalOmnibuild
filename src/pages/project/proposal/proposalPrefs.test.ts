import { describe, it, expect } from 'vitest';
import { LINE_LIBRARY_MAX, optionDefaultsFromPrefs, parseLineLibrary, pushLineLibrary, PREF_KEYS } from './proposalPrefs';

describe('parseLineLibrary', () => {
  it('degrades to [] for missing, malformed, and non-array values', () => {
    expect(parseLineLibrary(undefined)).toEqual([]);
    expect(parseLineLibrary('')).toEqual([]);
    expect(parseLineLibrary('{nope')).toEqual([]);
    expect(parseLineLibrary('{"description":"x"}')).toEqual([]);
  });

  it('keeps only well-formed entries and trims descriptions', () => {
    const raw = JSON.stringify([
      { description: '  Scaffolding  ', amountCents: 350000 },
      { description: 'No amount' },
      { description: '', amountCents: 1 },
      { description: 'NaN amount', amountCents: Number.NaN },
      'not an object',
      null,
    ]);
    expect(parseLineLibrary(raw)).toEqual([{ description: 'Scaffolding', amountCents: 350000 }]);
  });
});

describe('pushLineLibrary', () => {
  it('adds newest first', () => {
    const lib = pushLineLibrary([{ description: 'Scaffolding', amountCents: 350000 }], { description: 'Permit', amountCents: 25000 });
    expect(lib).toEqual([
      { description: 'Permit', amountCents: 25000 },
      { description: 'Scaffolding', amountCents: 350000 },
    ]);
  });

  it('dedups by description case-insensitively, keeping the newest amount', () => {
    const lib = pushLineLibrary(
      [{ description: 'Permit', amountCents: 25000 }, { description: 'scaffolding', amountCents: 350000 }],
      { description: 'SCAFFOLDING', amountCents: 400000 },
    );
    expect(lib).toEqual([
      { description: 'SCAFFOLDING', amountCents: 400000 },
      { description: 'Permit', amountCents: 25000 },
    ]);
  });

  it('caps the library at LINE_LIBRARY_MAX', () => {
    let lib: ReturnType<typeof pushLineLibrary> = [];
    for (let i = 0; i < LINE_LIBRARY_MAX + 5; i++) lib = pushLineLibrary(lib, { description: `Line ${i}`, amountCents: i * 100 });
    expect(lib).toHaveLength(LINE_LIBRARY_MAX);
    expect(lib[0].description).toBe(`Line ${LINE_LIBRARY_MAX + 4}`);
  });

  it('returns the same reference when there is nothing new to record', () => {
    const lib = [{ description: 'Permit', amountCents: 25000 }];
    expect(pushLineLibrary(lib, { description: '   ', amountCents: 100 })).toBe(lib);
    expect(pushLineLibrary(lib, { description: 'permit', amountCents: 25000 })).toBe(lib);
  });
});

describe('optionDefaultsFromPrefs', () => {
  it('returns nothing for a user with no saved proposal prefs', () => {
    expect(optionDefaultsFromPrefs({})).toEqual({});
  });

  it('maps stored strings onto proposal option defaults', () => {
    expect(optionDefaultsFromPrefs({
      [PREF_KEYS.font]: 'times',
      [PREF_KEYS.quality]: 'email',
      [PREF_KEYS.costDetail]: 'true',
      [PREF_KEYS.signature]: 'false',
      [PREF_KEYS.grandTotal]: 'true',
    })).toEqual({
      fontFamily: 'times',
      highlightQuality: 'email',
      includeCostDetail: true,
      includeSignature: false,
      showGrandTotal: true,
    });
  });

  it('seeds cover notes and terms from the newest history entry', () => {
    expect(optionDefaultsFromPrefs({
      [PREF_KEYS.notes]: JSON.stringify(['Newest notes', 'older notes']),
      [PREF_KEYS.terms]: JSON.stringify(['Net 30', 'Net 15']),
    })).toEqual({ coverNotes: 'Newest notes', terms: 'Net 30' });
  });

  it('leaves cover notes and terms out for empty, absent or malformed histories', () => {
    expect(optionDefaultsFromPrefs({
      [PREF_KEYS.notes]: '[]',
      [PREF_KEYS.terms]: 'not json',
    })).toEqual({});
    expect(optionDefaultsFromPrefs({ [PREF_KEYS.notes]: JSON.stringify(['']) })).toEqual({});
  });

  it('ignores junk values rather than passing them to the server', () => {
    expect(optionDefaultsFromPrefs({
      [PREF_KEYS.font]: 'comic-sans',
      [PREF_KEYS.quality]: 'gigantic',
      [PREF_KEYS.costDetail]: 'yes',
    })).toEqual({ highlightQuality: 'best' });
  });
});
