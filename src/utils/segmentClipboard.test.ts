// src/utils/segmentClipboard.test.ts
// Canvas copy/paste copies the selected segment(s), not the measurement, and
// a paste becomes a new measurement in the takeoff the user picks.
import { describe, it, expect, beforeEach } from 'vitest';
import { Measurement, MeasurementTakeoff } from '../types';
import {
  copySegments,
  canPasteInto,
  isSurfacePaste,
  buildPastedMeasurement,
  writeSegmentClipboard,
  readSegmentClipboard,
  segmentCountLabel,
  SEGMENT_CLIPBOARD_KEY,
  PASTE_OFFSET_PX,
} from './segmentClipboard';

const line: Measurement = {
  id: 'm1',
  type: 'length',
  name: 'Length 1',
  color: '#f00',
  takeoffId: 't-old',
  points: [{ x: 0, y: 0 }, { x: 100, y: 0 }],
  segments: [
    { points: [{ x: 0, y: 50 }, { x: 50, y: 50 }, { x: 100, y: 50 }], arcMidIndices: [1] },
    { points: [{ x: 0, y: 90 }, { x: 10, y: 90 }] },
  ],
  multiplier: 3,
  heights: [8],
  isTwoSided: true,
};

const lengthTakeoff: MeasurementTakeoff = { id: 't-len', name: 'Base', color: '#0a0', type: 'length', unit: 'yd' };
const areaTakeoff: MeasurementTakeoff = { id: 't-area', name: 'Drywall', color: '#00a', type: 'area' };
const countTakeoff: MeasurementTakeoff = { id: 't-cnt', name: 'Outlets', color: '#aa0', type: 'count' };

describe('copySegments', () => {
  it('copies one extra segment only', () => {
    const clip = copySegments(line, 0, 'p1')!;
    expect(clip.segments).toEqual([line.segments![0]]);
    expect(clip.type).toBe('length');
    expect(clip.sourcePageId).toBe('p1');
  });

  it('copies the primary segment for -1', () => {
    const clip = copySegments(line, -1, 'p1')!;
    expect(clip.segments).toEqual([{ points: line.points }]);
  });

  it('copies every segment when the whole measurement is selected', () => {
    const clip = copySegments(line, null, 'p1')!;
    expect(clip.segments).toHaveLength(3);
    expect(clip.segments[0].points).toEqual(line.points);
  });

  it('copies geometry, not the measurement (no id, name, takeoff or multiplier)', () => {
    const clip = copySegments(line, null, 'p1') as unknown as Record<string, unknown>;
    expect(clip.id).toBeUndefined();
    expect(clip.name).toBeUndefined();
    expect(clip.takeoffId).toBeUndefined();
    expect(clip.multiplier).toBeUndefined();
  });

  it('returns null for a stale segment index', () => {
    expect(copySegments(line, 9, 'p1')).toBeNull();
  });

  it('does not alias the source points', () => {
    const clip = copySegments(line, -1, 'p1')!;
    clip.segments[0].points[0].x = 999;
    expect(line.points[0].x).toBe(0);
  });
});

describe('canPasteInto', () => {
  it('matches takeoff type, and lets an area takeoff hold length (surface area)', () => {
    expect(canPasteInto({ type: 'length' }, lengthTakeoff)).toBe(true);
    expect(canPasteInto({ type: 'length' }, areaTakeoff)).toBe(true);
    expect(isSurfacePaste({ type: 'length' }, areaTakeoff)).toBe(true);
    expect(canPasteInto({ type: 'area' }, lengthTakeoff)).toBe(false);
    expect(canPasteInto({ type: 'length' }, countTakeoff)).toBe(false);
    expect(canPasteInto({ type: 'count' }, countTakeoff)).toBe(true);
  });
});

describe('buildPastedMeasurement', () => {
  it('offsets every segment on the same page and files it under the chosen takeoff', () => {
    const clip = copySegments(line, null, 'p1')!;
    const m = buildPastedMeasurement(clip, { id: 'new', name: 'Length 2', takeoff: lengthTakeoff, pageId: 'p1', planSetId: 'ps' });
    expect(m.id).toBe('new');
    expect(m.takeoffId).toBe('t-len');
    expect(m.color).toBe('#0a0');
    expect(m.planSetId).toBe('ps');
    expect(m.points[0]).toEqual({ x: PASTE_OFFSET_PX, y: PASTE_OFFSET_PX });
    expect(m.segments).toHaveLength(2);
    expect(m.segments![0].points[0]).toEqual({ x: PASTE_OFFSET_PX, y: 50 + PASTE_OFFSET_PX });
    expect(m.segments![0].arcMidIndices).toEqual([1]);
    expect(m.segments![1].points[1]).toEqual({ x: 10 + PASTE_OFFSET_PX, y: 90 + PASTE_OFFSET_PX });
    expect(m.multiplier).toBeUndefined();
    // Not surface area: heights stay behind.
    expect(m.heights).toBeUndefined();
  });

  it('a single copied segment becomes the primary shape, arcs intact', () => {
    const clip = copySegments(line, 0, 'p1')!;
    const m = buildPastedMeasurement(clip, { id: 'n', name: 'x', takeoff: lengthTakeoff, pageId: 'p1' });
    expect(m.points).toHaveLength(3);
    expect(m.arcMidIndices).toEqual([1]);
    expect(m.segments).toBeUndefined();
  });

  it('keeps the same position on another page or sheet', () => {
    const clip = copySegments(line, -1, 'p1')!;
    const m = buildPastedMeasurement(clip, { id: 'n', name: 'x', takeoff: lengthTakeoff, pageId: 'p2' });
    expect(m.points).toEqual(line.points);
  });

  it('carries heights into an area takeoff (surface area)', () => {
    const clip = copySegments(line, -1, 'p1')!;
    const m = buildPastedMeasurement(clip, { id: 'n', name: 'x', takeoff: areaTakeoff, pageId: 'p1' });
    expect(m.type).toBe('length');
    expect(m.heights).toEqual([8]);
    expect(m.isTwoSided).toBe(true);
  });

  it('finds the scale region the pasted shape lands in', () => {
    const clip = copySegments(line, -1, 'p1')!;
    const m = buildPastedMeasurement(clip, {
      id: 'n', name: 'x', takeoff: lengthTakeoff, pageId: 'p1',
      regionAt: p => (p.x === PASTE_OFFSET_PX ? 'r2' : undefined),
    });
    expect(m.regionId).toBe('r2');
  });

  it('keeps cutouts after the first shape, and makes a lone cutout a plain area', () => {
    const area: Measurement = {
      id: 'a', type: 'area', name: 'Area 1', color: '#000',
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }],
      segments: [{ points: [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 2, y: 2 }], subtract: true }],
    };
    const areaT: MeasurementTakeoff = { ...areaTakeoff };
    const whole = buildPastedMeasurement(copySegments(area, null, 'p1')!, { id: 'n', name: 'x', takeoff: areaT, pageId: 'p1' });
    expect(whole.segments![0].subtract).toBe(true);
    const lone = buildPastedMeasurement(copySegments(area, 0, 'p1')!, { id: 'n', name: 'x', takeoff: areaT, pageId: 'p1' });
    expect(lone.segments).toBeUndefined();
    expect((lone as unknown as Record<string, unknown>).subtract).toBeUndefined();
  });
});

describe('clipboard storage', () => {
  beforeEach(() => localStorage.clear());

  it('round-trips and rejects junk', () => {
    expect(readSegmentClipboard()).toBeNull();
    const clip = copySegments(line, 1, 'p1')!;
    writeSegmentClipboard(clip);
    expect(readSegmentClipboard()).toEqual(clip);
    localStorage.setItem(SEGMENT_CLIPBOARD_KEY, '{bad');
    expect(readSegmentClipboard()).toBeNull();
    localStorage.setItem(SEGMENT_CLIPBOARD_KEY, JSON.stringify({ segments: [] }));
    expect(readSegmentClipboard()).toBeNull();
  });

  it('words the count', () => {
    expect(segmentCountLabel({ type: 'length', segments: [{ points: [] }] })).toBe('1 segment');
    expect(segmentCountLabel({ type: 'area', segments: [{ points: [] }, { points: [] }] })).toBe('2 segments');
    expect(segmentCountLabel({ type: 'count', segments: [{ points: [] }] })).toBe('marker');
  });
});
