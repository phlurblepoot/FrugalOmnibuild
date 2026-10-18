// src/pages/documents/DocumentsPage.test.ts
// Pure-logic coverage for the URL <-> filter round-trip. DocumentsPage itself
// derives every filter from `csvParam`/`searchParams.get` and writes them
// back via `applyFilterPatch` — these two must stay inverses of each other,
// or a deep link (or the filter bar) silently drifts. Task 5 edits this same
// page next, so this is cheap insurance against a filter-shape regression.
import { describe, it, expect } from 'vitest';
import { applyFilterPatch, csvParam } from './DocumentsPage';

describe('csvParam', () => {
  it('parses a comma-list param into an array', () => {
    const sp = new URLSearchParams('projectIds=p1,p2,p3');
    expect(csvParam(sp, 'projectIds')).toEqual(['p1', 'p2', 'p3']);
  });

  it('returns an empty array for a missing param', () => {
    expect(csvParam(new URLSearchParams(), 'projectIds')).toEqual([]);
  });

  it('trims whitespace and drops empty entries (e.g. a trailing comma)', () => {
    const sp = new URLSearchParams();
    sp.set('kinds', ' invoice, rfi ,,punch-report');
    expect(csvParam(sp, 'kinds')).toEqual(['invoice', 'rfi', 'punch-report']);
  });
});

describe('applyFilterPatch', () => {
  it('writes a non-empty array as a comma-joined value', () => {
    const p = applyFilterPatch(new URLSearchParams(), { projectIds: ['p1', 'p2'] });
    expect(p.get('projectIds')).toBe('p1,p2');
  });

  it('deletes the key when the array patch is empty (never writes an empty value)', () => {
    const start = new URLSearchParams('projectIds=p1,p2');
    const p = applyFilterPatch(start, { projectIds: [] });
    expect(p.has('projectIds')).toBe(false);
  });

  it('sets archived=1 for true and deletes the key for false', () => {
    const on = applyFilterPatch(new URLSearchParams(), { archived: true });
    expect(on.get('archived')).toBe('1');

    const off = applyFilterPatch(new URLSearchParams('archived=1'), { archived: false });
    expect(off.has('archived')).toBe(false);
  });

  it('sets q for a non-empty string and deletes it for an empty string', () => {
    const withQ = applyFilterPatch(new URLSearchParams(), { q: 'invoice' });
    expect(withQ.get('q')).toBe('invoice');

    const cleared = applyFilterPatch(new URLSearchParams('q=invoice'), { q: '' });
    expect(cleared.has('q')).toBe(false);
  });

  it('leaves keys absent from the patch untouched', () => {
    const start = new URLSearchParams('projectIds=p1&kinds=invoice');
    const p = applyFilterPatch(start, { q: 'x' });
    expect(p.get('projectIds')).toBe('p1');
    expect(p.get('kinds')).toBe('invoice');
    expect(p.get('q')).toBe('x');
  });

  it('round-trips every filter kind through applyFilterPatch -> csvParam/get unchanged', () => {
    const patch = { projectIds: ['p1', 'p2'], customerIds: ['c1'], kinds: ['invoice', 'rfi'], q: 'foo', archived: true };
    const p = applyFilterPatch(new URLSearchParams(), patch);
    expect(csvParam(p, 'projectIds')).toEqual(patch.projectIds);
    expect(csvParam(p, 'customerIds')).toEqual(patch.customerIds);
    expect(csvParam(p, 'kinds')).toEqual(patch.kinds);
    expect(p.get('q')).toBe(patch.q);
    expect(p.get('archived')).toBe('1');
  });

  it('round-trips back to the all-cleared state', () => {
    const cleared = applyFilterPatch(new URLSearchParams(), { projectIds: [], customerIds: [], kinds: [], q: '', archived: false });
    expect(csvParam(cleared, 'projectIds')).toEqual([]);
    expect(csvParam(cleared, 'customerIds')).toEqual([]);
    expect(csvParam(cleared, 'kinds')).toEqual([]);
    expect(cleared.get('q')).toBeNull();
    expect(cleared.get('archived')).toBeNull();
  });
});
