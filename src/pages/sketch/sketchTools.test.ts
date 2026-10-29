// src/pages/sketch/sketchTools.test.ts
import { describe, it, expect } from 'vitest';
import { lineClick, lineFinish, lineBack, lineTyped, rectClick, rectTyped, circleClick, circleTyped, draftPreview, type Draft } from './sketchTools';

let n = 0;
const id = () => `s${++n}`;
const P = (x: number, y: number) => ({ x, y });

const clicks = (pts: { x: number; y: number }[], arcAt: number[] = []) => {
  let draft: Draft | null = null;
  let commit;
  pts.forEach((p, i) => {
    const step = lineClick(draft, p, 'front', arcAt.includes(i), id);
    draft = step.draft;
    commit = step.commit ?? commit;
  });
  return { draft, commit };
};

describe('Line tool', () => {
  it('clicking back on the start closes the shape', () => {
    const { draft, commit } = clicks([P(0, 0), P(10, 0), P(10, 5), P(0, 0)]);
    expect(draft).toBeNull();
    expect(commit).toMatchObject({ type: 'path', plane: 'front', closed: true, start: P(0, 0) });
    expect((commit as any).segments).toHaveLength(3);
  });

  it('in arc mode, one click sets the bulge and the next the end', () => {
    // Line to (10,0), then an arc through (12,5) ending at (10,10), then a line home.
    const { commit } = clicks([P(0, 0), P(10, 0), P(12, 5), P(10, 10), P(0, 10), P(0, 0)], [2, 3]);
    expect((commit as any).segments.map((s: any) => s.kind)).toEqual(['line', 'arc', 'line', 'line']);
    expect((commit as any).segments[1]).toEqual({ kind: 'arc', to: P(10, 10), through: P(12, 5) });
  });

  it('Enter keeps an open path; Backspace steps back', () => {
    const { draft } = clicks([P(0, 0), P(10, 0), P(10, 5)]);
    expect(lineBack(draft)).toMatchObject({ segments: [{ kind: 'line', to: P(10, 0) }] });
    expect(lineFinish(draft, id).commit).toMatchObject({ closed: false });
    expect(lineFinish(null, id).commit).toBeUndefined();
  });

  it('a typed length runs at the typed angle', () => {
    let { draft } = clicks([P(0, 0)]);
    draft = lineTyped(draft, 88.9, 90, id).draft;
    expect(draft).toMatchObject({ segments: [{ kind: 'line', to: P(0, 88.9) }] });
  });

  it('the preview runs to the pointer, as an arc while one is pending', () => {
    const { draft } = clicks([P(0, 0), P(10, 0), P(12, 5)], [2]);
    const pv = draftPreview(draft, P(10, 10));
    expect(pv).toMatchObject({ type: 'path', segments: [{ kind: 'line' }, { kind: 'arc', through: P(12, 5), to: P(10, 10) }] });
  });
});

describe('Rectangle and circle tools', () => {
  it('two corners make a closed rectangle; a typed size goes toward the pointer', () => {
    const first = rectClick(null, P(0, 0), 'ground', id);
    expect(rectClick(first.draft, P(5, 0), 'ground', id).commit).toBeUndefined(); // no height yet
    expect(rectClick(first.draft, P(5, 3), 'ground', id).commit).toMatchObject({ closed: true });
    const typed = rectTyped(first.draft, 24, 6, P(-1, -1), id).commit as any;
    expect(typed.segments[1].to).toEqual(P(-24, -6));
  });

  it('a circle takes its radius from the second click or the typed value', () => {
    const first = circleClick(null, P(1, 1), 'side', id);
    expect(circleClick(first.draft, P(4, 5), 'side', id).commit).toMatchObject({ type: 'circle', radius: 5 });
    expect(circleTyped(first.draft, 12.7, id).commit).toMatchObject({ radius: 12.7, center: P(1, 1) });
    expect(circleTyped(first.draft, 0, id).commit).toBeUndefined();
  });
});
