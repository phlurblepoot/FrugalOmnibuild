import { it, expect, describe } from 'vitest';
import { computeRevisionModel, effectiveSheetId, carryForwardFrom, moveToSheet, wouldBeNewestIn } from './planSets';
import type { Project, ProjectPage } from '../types';

const page = (o: Partial<ProjectPage>): ProjectPage => ({
  id: 'p', name: '', pageNumber: '', description: '', imageId: '', thumbnailId: '',
  imageWidth: 0, imageHeight: 0, measurements: [], scaleConfig: null, ...o,
} as ProjectPage);

const proj = (pages: ProjectPage[], planSets: any[]): Project => ({
  id: 'pr', name: 'x', createdAt: 0, pages, takeoffs: [], planSets,
} as Project);

const sets = [
  { id: 's1', name: 'Set 1', createdAt: 1 },
  { id: 's2', name: 'Set 2', createdAt: 2 },
];

it('current revision is the newest page sharing a sheetId', () => {
  const a1 = page({ id: 'a1', sheetId: 'A', pageNumber: 'A-101', planSetId: 's1', measurements: [{ id: 'm', type: 'length', points: [], takeoffId: 't' } as any] });
  const a2 = page({ id: 'a2', sheetId: 'A', pageNumber: 'A-101', planSetId: 's2', measurements: [{ id: 'm2', type: 'length', points: [], takeoffId: 't' } as any] });
  const m = computeRevisionModel(proj([a1, a2], sets), '');
  expect([...m.currentPageIds]).toEqual(['a2']);            // newest only
  expect(m.status('a1')).toBe('superseded');
  expect(m.status('a2')).toBe('current');
  expect(m.revisionNumberByPageId.get('a1')).toBe(1);
  expect(m.revisionNumberByPageId.get('a2')).toBe(2);
});

it('as-of an older set shows that revision (read-only history)', () => {
  const a1 = page({ id: 'a1', sheetId: 'A', pageNumber: 'A-101', planSetId: 's1' });
  const a2 = page({ id: 'a2', sheetId: 'A', pageNumber: 'A-101', planSetId: 's2' });
  const m = computeRevisionModel(proj([a1, a2], sets), 's1');  // as of Set 1
  expect([...m.currentPageIds]).toEqual(['a1']);
});

it('falls back to pageNumber when sheetId is missing (legacy)', () => {
  const a1 = page({ id: 'a1', pageNumber: 'A-101', planSetId: 's1' });
  const a2 = page({ id: 'a2', pageNumber: 'A-101', planSetId: 's2' });
  const m = computeRevisionModel(proj([a1, a2], sets), '');
  expect([...m.currentPageIds]).toEqual(['a2']);
});

it('distinct sheetIds with the same pageNumber are separate sheets (not revisions)', () => {
  const a1 = page({ id: 'a1', sheetId: 'A', pageNumber: 'A-101', planSetId: 's1' });
  const b1 = page({ id: 'b1', sheetId: 'B', pageNumber: 'A-101', planSetId: 's1' });
  const m = computeRevisionModel(proj([a1, b1], sets), '');
  expect(new Set(m.currentPageIds)).toEqual(new Set(['a1', 'b1']));
});

it('carryForwardFrom copies measurements with NEW ids + clones scaleConfig', () => {
  let n = 0;
  const newId = () => `new-${++n}`;
  const current = page({
    id: 'cur',
    measurements: [
      { id: 'm1', type: 'length', points: [], takeoffId: 't' } as any,
      { id: 'm2', type: 'area', points: [], takeoffId: 't' } as any,
    ],
    scaleConfig: { knownDistance: 10, pixelDistance: 100 } as any,
  });
  const seed = carryForwardFrom(current, newId);
  expect(seed.measurements).toHaveLength(2);
  expect(seed.measurements.map(m => m.id)).toEqual(['new-1', 'new-2']);
  // ids are fresh, not the originals
  expect(seed.measurements.some(m => m.id === 'm1' || m.id === 'm2')).toBe(false);
  // scaleConfig is a clone (distinct object, same values)
  expect(seed.scaleConfig).toEqual(current.scaleConfig);
  expect(seed.scaleConfig).not.toBe(current.scaleConfig);
});

it('carryForwardFrom keeps each measurement\'s multiplier on the new revision', () => {
  const current = page({
    id: 'cur',
    measurements: [
      { id: 'm1', type: 'area', points: [], takeoffId: 't', multiplier: 4 } as any,
      { id: 'm2', type: 'length', points: [], takeoffId: 't' } as any,
    ],
  });
  const seed = carryForwardFrom(current, () => 'new');
  expect(seed.measurements[0].multiplier).toBe(4);
  expect(seed.measurements[1].multiplier).toBeUndefined();
});

it('effectiveSheetId prefers sheetId, then page number, then id', () => {
  expect(effectiveSheetId(page({ id: 'x', sheetId: 'S', pageNumber: 'A-101' }))).toBe('S');
  expect(effectiveSheetId(page({ id: 'x', pageNumber: 'A-101' }))).toBe('pn:a-101');
  expect(effectiveSheetId(page({ id: 'x', pageNumber: '' }))).toBe('id:x');
});

describe('moveToSheet', () => {
  let n = 0;
  const newId = () => `new${++n}`;

  it('splits a wrongly matched page into its own sheet, keeping its takeoffs', () => {
    const a1 = page({ id: 'a1', sheetId: 'A', pageNumber: 'A-101', planSetId: 's1' });
    const a2 = page({ id: 'a2', sheetId: 'A', pageNumber: 'A-102', planSetId: 's2', measurements: [{ id: 'm' } as any] });
    const out = moveToSheet(proj([a1, a2], sets), 'a2', null, newId);
    const model = computeRevisionModel(out, '');
    expect(model.status('a1')).toBe('unique');
    expect(model.status('a2')).toBe('unique');
    expect(out.pages.find(p => p.id === 'a2')!.measurements).toHaveLength(1);
  });

  it('joins a page to another sheet and can copy that sheet\'s current takeoffs', () => {
    const b1 = page({ id: 'b1', sheetId: 'B', pageNumber: 'A-102', planSetId: 's1', measurements: [{ id: 'mb', type: 'length', points: [{ x: 1, y: 2 }] } as any] });
    const x2 = page({ id: 'x2', sheetId: 'X', pageNumber: 'A-102', planSetId: 's2', measurements: [{ id: 'wrong' } as any] });
    expect(wouldBeNewestIn(proj([b1, x2], sets), 'x2', 'B')).toBe(true);
    const out = moveToSheet(proj([b1, x2], sets), 'x2', 'B', newId, { replaceTakeoffs: true });
    const model = computeRevisionModel(out, '');
    expect(model.status('b1')).toBe('superseded');
    expect(model.status('x2')).toBe('current');
    const moved = out.pages.find(p => p.id === 'x2')!;
    expect(moved.measurements.map(m => m.points)).toEqual([[{ x: 1, y: 2 }]]);
    expect(moved.measurements[0].id).not.toBe('mb');
  });

  it('does not copy takeoffs onto a page that lands as older history', () => {
    const b2 = page({ id: 'b2', sheetId: 'B', planSetId: 's2', measurements: [{ id: 'mb', points: [] } as any] });
    const x1 = page({ id: 'x1', sheetId: 'X', planSetId: 's1', measurements: [{ id: 'keep' } as any] });
    const out = moveToSheet(proj([b2, x1], sets), 'x1', 'B', newId, { replaceTakeoffs: true });
    expect(out.pages.find(p => p.id === 'x1')!.measurements.map(m => m.id)).toEqual(['keep']);
    expect(computeRevisionModel(out, '').status('x1')).toBe('superseded');
  });

  it('stamps a real sheet id on a legacy sheet grouped by page number', () => {
    const l1 = page({ id: 'l1', pageNumber: 'S-1', planSetId: 's1' });
    const x2 = page({ id: 'x2', sheetId: 'X', pageNumber: 'S1', planSetId: 's2' });
    const out = moveToSheet(proj([l1, x2], sets), 'x2', 'pn:s-1', newId);
    const [o1, o2] = out.pages;
    expect(o1.sheetId).toBeTruthy();
    expect(o1.sheetId).toBe(o2.sheetId);
    expect(o1.sheetId!.startsWith('pn:')).toBe(false);
  });
});
