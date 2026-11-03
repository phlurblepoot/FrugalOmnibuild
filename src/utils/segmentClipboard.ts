import { Measurement, MeasurementSegment, MeasurementTakeoff, MeasurementType, Point } from '../types';
import { measurementSegmentAt } from './segmentValue';

// Copy / paste on the takeoff canvas copies the selected segment(s) — the
// drawn geometry — not the measurement. Pasting always makes a new
// measurement, in a takeoff the user picks (the active one or a new one).

export const SEGMENT_CLIPBOARD_KEY = 'copiedSegments';

/** How far a paste on the copy's own page shifts, so it doesn't sit on top. */
export const PASTE_OFFSET_PX = 20;

export interface CopiedSegments {
  /** The measurement type the segments were drawn as. */
  type: MeasurementType;
  /** First segment becomes the pasted measurement's primary shape. */
  segments: MeasurementSegment[];
  /** Surface area: the source's wall heights and sidedness, reused when the
   *  paste lands in an area takeoff. */
  heights?: number[];
  isTwoSided?: boolean;
  sourcePageId: string;
}

// The geometry a selection covers. segIdx: null = the whole measurement
// (every segment), -1 = the primary segment, 0+ = m.segments[i].
export const copySegments = (m: Measurement, segIdx: number | null, pageId: string): CopiedSegments | null => {
  let segments: MeasurementSegment[];
  if (segIdx === null) {
    segments = [{ points: m.points, arcMidIndices: m.arcMidIndices }, ...(m.segments ?? [])];
  } else {
    const seg = measurementSegmentAt(m, segIdx);
    if (!seg) return null;
    segments = [seg];
  }
  segments = segments
    .filter(s => s.points.length > 0)
    .map(s => ({
      points: s.points.map(p => ({ x: p.x, y: p.y })),
      ...(s.arcMidIndices?.length ? { arcMidIndices: [...s.arcMidIndices] } : {}),
      ...(s.subtract ? { subtract: true } : {}),
    }));
  if (segments.length === 0) return null;
  return {
    type: m.type,
    segments,
    ...(m.heights?.length ? { heights: [...m.heights] } : {}),
    ...(m.isTwoSided ? { isTwoSided: true } : {}),
    sourcePageId: pageId,
  };
};

// A takeoff can hold segments of its own type; an area takeoff also holds
// length segments as surface area (walls).
export const canPasteInto = (clip: Pick<CopiedSegments, 'type'>, takeoff: Pick<MeasurementTakeoff, 'type'>): boolean =>
  takeoff.type === clip.type || (takeoff.type === 'area' && clip.type === 'length');

export const isSurfacePaste = (clip: Pick<CopiedSegments, 'type'>, takeoff: Pick<MeasurementTakeoff, 'type'>): boolean =>
  takeoff.type === 'area' && clip.type === 'length';

const shift = (pts: Point[], d: number): Point[] => pts.map(p => ({ x: p.x + d, y: p.y + d }));

// The new measurement a paste makes. Every segment shifts by the same offset
// (the old measurement paste forgot the extra segments). A lone cutout pasted
// on its own becomes a plain shape: a measurement can't start with a hole.
export const buildPastedMeasurement = (clip: CopiedSegments, opts: {
  id: string;
  name: string;
  takeoff: MeasurementTakeoff;
  pageId: string;
  planSetId?: string;
  /** Which scale region (if any) a point falls in. */
  regionAt?: (p: Point) => string | undefined;
}): Measurement => {
  const offset = opts.pageId === clip.sourcePageId ? PASTE_OFFSET_PX : 0;
  const [first, ...rest] = clip.segments;
  const points = shift(first.points, offset);
  const surface = isSurfacePaste(clip, opts.takeoff);
  const m: Measurement = {
    id: opts.id,
    type: clip.type,
    name: opts.name,
    points,
    color: opts.takeoff.color,
    takeoffId: opts.takeoff.id,
    planSetId: opts.planSetId,
    regionId: opts.regionAt?.(points[0]),
  };
  if (first.arcMidIndices?.length) m.arcMidIndices = [...first.arcMidIndices];
  if (rest.length) {
    m.segments = rest.map(s => ({
      points: shift(s.points, offset),
      ...(s.arcMidIndices?.length ? { arcMidIndices: [...s.arcMidIndices] } : {}),
      ...(s.subtract && clip.type === 'area' ? { subtract: true } : {}),
    }));
  }
  if (surface && clip.heights?.length) m.heights = [...clip.heights];
  if (surface && clip.isTwoSided) m.isTwoSided = true;
  return m;
};

export const writeSegmentClipboard = (clip: CopiedSegments): void => {
  try { localStorage.setItem(SEGMENT_CLIPBOARD_KEY, JSON.stringify(clip)); } catch { /* private mode */ }
};

export const readSegmentClipboard = (): CopiedSegments | null => {
  try {
    const raw = localStorage.getItem(SEGMENT_CLIPBOARD_KEY);
    if (!raw) return null;
    const clip = JSON.parse(raw) as CopiedSegments;
    if (!clip || !Array.isArray(clip.segments) || clip.segments.length === 0 || !clip.segments[0].points?.length) return null;
    return clip;
  } catch {
    return null;
  }
};

export const segmentCountLabel = (clip: Pick<CopiedSegments, 'type' | 'segments'>): string => {
  if (clip.type === 'count') return 'marker';
  return clip.segments.length === 1 ? '1 segment' : `${clip.segments.length} segments`;
};

// ── Several segments at once (Shift+click) or several measurements (Ctrl+click)

/** One Shift-selected segment: -1 = the primary shape, 0+ = m.segments[i]. */
export interface SegmentRef { measurementId: string; segIdx: number }

export const segmentRefKey = (r: SegmentRef): string => `${r.measurementId}:${r.segIdx}`;

/** Shift+click toggles a segment in the selection. Segments of a different
 *  measurement type (length / area / count) can't join, so the selection
 *  is left as it was. */
export const toggleSegmentRef = (
  refs: SegmentRef[],
  ref: SegmentRef,
  typeOf: (measurementId: string) => MeasurementType | undefined,
): { refs: SegmentRef[]; rejected: boolean } => {
  const key = segmentRefKey(ref);
  if (refs.some(r => segmentRefKey(r) === key)) {
    return { refs: refs.filter(r => segmentRefKey(r) !== key), rejected: false };
  }
  const existingType = refs.length ? typeOf(refs[0].measurementId) : undefined;
  if (existingType && existingType !== typeOf(ref.measurementId)) return { refs, rejected: true };
  return { refs: [...refs, ref], rejected: false };
};

/** Every segment of a measurement, as refs (primary first). */
export const allSegmentRefs = (m: Pick<Measurement, 'id' | 'segments'>): SegmentRef[] =>
  [{ measurementId: m.id, segIdx: -1 }, ...(m.segments ?? []).map((_, i) => ({ measurementId: m.id, segIdx: i }))];

/** The clipboard for several selected segments, possibly from different
 *  measurements and takeoffs. Wall heights only come along when every
 *  segment is from one measurement (they belong to that measurement). */
export const copySegmentRefs = (
  refs: SegmentRef[],
  measurements: Measurement[],
  pageId: string,
): CopiedSegments | null => {
  const byId = new Map(measurements.map(m => [m.id, m]));
  const parts: CopiedSegments[] = [];
  for (const r of refs) {
    const m = byId.get(r.measurementId);
    if (!m) continue;
    const part = copySegments(m, r.segIdx, pageId);
    if (part) parts.push(part);
  }
  if (parts.length === 0) return null;
  const type = parts[0].type;
  if (parts.some(p => p.type !== type)) return null;
  const sources = new Set(refs.filter(r => byId.has(r.measurementId)).map(r => r.measurementId));
  const single = sources.size === 1 ? parts[0] : undefined;
  return {
    type,
    segments: parts.flatMap(p => p.segments),
    ...(single?.heights ? { heights: single.heights } : {}),
    ...(single?.isTwoSided ? { isTwoSided: true } : {}),
    sourcePageId: pageId,
  };
};
