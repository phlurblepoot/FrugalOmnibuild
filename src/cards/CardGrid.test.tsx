// src/cards/CardGrid.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, fireEvent, waitFor, act } from '@testing-library/react';
import type { CardDef, CardLayout, CardLayoutEntry } from './types';

const getUserPreferences = vi.fn(async (): Promise<Record<string, string>> => ({}));
const saveUserPreferences = vi.fn(async (_p: Record<string, string>): Promise<void> => {});

vi.mock('../utils/store', async () => {
  const actual = await vi.importActual<typeof import('../utils/store')>('../utils/store');
  return { ...actual, getUserPreferences, saveUserPreferences };
});

const { CardGrid, reorderBefore, snapResizeWidth } = await import('./CardGrid');
const { CARD_REGISTRY, registerCards, DEFAULT_LAYOUTS } = await import('./registry');

// Three throwaway cards covering the width spectrum (brief: [1,2,3]/[1]/[1,2],
// one adminOnly). Component body renders id+width so span/clamp assertions
// have something concrete to read.
const CARD_A: CardDef = {
  id: 'card-a', title: 'Card A', icon: () => null, page: 'dashboard',
  widths: [1, 2, 3], defaultWidth: 1,
  Component: ({ width }) => <div data-testid="body-card-a">a:{width}</div>,
};
const CARD_B: CardDef = {
  id: 'card-b', title: 'Card B', icon: () => null, page: 'dashboard',
  widths: [1], defaultWidth: 1,
  Component: ({ width }) => <div data-testid="body-card-b">b:{width}</div>,
};
const CARD_C: CardDef = {
  id: 'card-c', title: 'Card C', icon: () => null, page: 'dashboard',
  widths: [1, 2], defaultWidth: 1, adminOnly: true,
  Component: ({ width }) => <div data-testid="body-card-c">c:{width}</div>,
};

const ORIGINAL_DASHBOARD_DEFAULT = DEFAULT_LAYOUTS.dashboard;

function seed(layout: CardLayout) {
  localStorage.setItem('cards-dashboard', JSON.stringify(layout));
}

function mockMatchMedia(matching: string[] = []) {
  window.matchMedia = vi.fn((query: string) => ({
    matches: matching.includes(query),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

// cols=3 (mid breakpoint only) is the default for tests that don't care about
// clamping — every fixture width here is <=2 so nothing clamps at cols=3.
function mockCols3() {
  mockMatchMedia(['(min-width: 1024px)']);
}

beforeEach(() => {
  CARD_REGISTRY.splice(0, CARD_REGISTRY.length);
  registerCards([CARD_A, CARD_B, CARD_C]);
  // Test-owned default layout (distinct widths from any "customized" fixture
  // below) so the reset case can prove it actually restored something.
  DEFAULT_LAYOUTS.dashboard = {
    version: 1,
    cards: [{ id: 'card-a', width: 1 }, { id: 'card-b', width: 1 }, { id: 'card-c', width: 1 }],
  };
  localStorage.clear();
  getUserPreferences.mockClear().mockResolvedValue({});
  saveUserPreferences.mockClear().mockResolvedValue(undefined);
  mockCols3();
});

afterEach(() => {
  DEFAULT_LAYOUTS.dashboard = ORIGINAL_DASHBOARD_DEFAULT;
});

function mount(ctx = { isAdmin: true }) {
  return render(<CardGrid page="dashboard" ctx={ctx} />);
}

function wrapperIds() {
  return Array.from(screen.getByTestId('card-grid').querySelectorAll('[data-card-id]')).map(el =>
    el.getAttribute('data-card-id')
  );
}

describe('CardGrid', () => {
  it('(a) renders layout cards in order with span style', () => {
    seed({ version: 1, cards: [{ id: 'card-a', width: 2 }, { id: 'card-b', width: 1 }, { id: 'card-c', width: 2 }] });
    mount();

    expect(wrapperIds()).toEqual(['card-a', 'card-b', 'card-c']);
    const grid = screen.getByTestId('card-grid');
    const a = grid.querySelector('[data-card-id="card-a"]') as HTMLElement;
    const b = grid.querySelector('[data-card-id="card-b"]') as HTMLElement;
    expect(a.style.gridColumn).toBe('span 2');
    expect(b.style.gridColumn).toBe('span 1');
    expect(screen.getByTestId('body-card-a')).toHaveTextContent('a:2');
  });

  it('(b) span clamps: width-3 card at cols=2 renders span 2', () => {
    seed({ version: 1, cards: [{ id: 'card-a', width: 3 }] });
    mockMatchMedia(['(min-width: 640px)']); // cols=2
    mount();

    const wrapper = screen.getByTestId('card-grid').querySelector('[data-card-id="card-a"]') as HTMLElement;
    expect(wrapper.style.gridColumn).toBe('span 2');
    expect(screen.getByTestId('body-card-a')).toHaveTextContent('a:2');
  });

  it('(c) Customize reveals remove/width/tray controls', () => {
    seed({ version: 1, cards: [{ id: 'card-a', width: 1 }, { id: 'card-b', width: 1 }] });
    mount();

    expect(screen.queryByTestId('cards-tray')).toBeNull();
    expect(screen.queryByLabelText('Remove Card A')).toBeNull();

    fireEvent.click(screen.getByTestId('cards-customize'));

    expect(screen.getByTestId('cards-customize')).toHaveTextContent('✓ Done');
    expect(screen.getByTestId('cards-reset')).toBeInTheDocument();
    expect(screen.getByLabelText('Remove Card A')).toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Card A width' })).toBeInTheDocument();
    expect(screen.getByTestId('cards-tray')).toBeInTheDocument();
  });

  it('(d) width button updates layout and persists', async () => {
    localStorage.setItem('token', 'tok');
    seed({ version: 1, cards: [{ id: 'card-a', width: 1 }] });
    mount();

    fireEvent.click(screen.getByTestId('cards-customize'));
    const group = screen.getByRole('group', { name: 'Card A width' });
    fireEvent.click(within(group).getByRole('button', { name: '2' }));

    expect(screen.getByTestId('body-card-a')).toHaveTextContent('a:2');
    await waitFor(() => {
      expect(saveUserPreferences).toHaveBeenCalledWith({
        'cards-dashboard': JSON.stringify({ version: 1, cards: [{ id: 'card-a', width: 2 }] }),
      });
    });
  });

  it('(e) remove moves card to tray; tray click re-adds it', () => {
    seed({ version: 1, cards: [{ id: 'card-a', width: 1 }, { id: 'card-b', width: 1 }] });
    mount();
    fireEvent.click(screen.getByTestId('cards-customize'));

    fireEvent.click(screen.getByLabelText('Remove Card B'));
    expect(wrapperIds()).toEqual(['card-a']);
    expect(screen.getByRole('button', { name: '+ Card B' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: '+ Card B' }));
    expect(wrapperIds()).toEqual(['card-a', 'card-b']);
    expect(screen.queryByRole('button', { name: '+ Card B' })).toBeNull();
  });

  it('(f) adminOnly card is absent from the tray for a non-admin ctx', () => {
    seed({ version: 1, cards: [{ id: 'card-a', width: 1 }, { id: 'card-b', width: 1 }] });
    mount({ isAdmin: false });
    fireEvent.click(screen.getByTestId('cards-customize'));

    expect(screen.queryByRole('button', { name: '+ Card C' })).toBeNull();
  });

  it('(g) reset restores the default layout', () => {
    seed({ version: 1, cards: [{ id: 'card-a', width: 3 }, { id: 'card-c', width: 2 }] });
    mount();
    fireEvent.click(screen.getByTestId('cards-customize'));

    fireEvent.click(screen.getByTestId('cards-reset'));

    expect(wrapperIds()).toEqual(['card-a', 'card-b', 'card-c']);
    expect(screen.getByTestId('body-card-a')).toHaveTextContent('a:1');
  });

  it('(h) drag reorders before the drop target and persists', async () => {
    localStorage.setItem('token', 'tok');
    seed({ version: 1, cards: [{ id: 'card-a', width: 1 }, { id: 'card-b', width: 1 }, { id: 'card-c', width: 1 }] });
    mount();
    fireEvent.click(screen.getByTestId('cards-customize'));

    const grid = screen.getByTestId('card-grid');
    const a = grid.querySelector('[data-card-id="card-a"]') as HTMLElement;
    const c = grid.querySelector('[data-card-id="card-c"]') as HTMLElement;

    fireEvent.dragStart(a);
    fireEvent.dragOver(c);
    fireEvent.drop(c);

    expect(wrapperIds()).toEqual(['card-b', 'card-a', 'card-c']);
    await waitFor(() => {
      expect(saveUserPreferences).toHaveBeenCalledWith({
        'cards-dashboard': JSON.stringify({
          version: 1,
          cards: [{ id: 'card-b', width: 1 }, { id: 'card-a', width: 1 }, { id: 'card-c', width: 1 }],
        }),
      });
    });
  });

  it('drag is inert outside Customize mode (handlers gated, not just draggable)', async () => {
    localStorage.setItem('token', 'tok');
    seed({ version: 1, cards: [{ id: 'card-a', width: 1 }, { id: 'card-b', width: 1 }, { id: 'card-c', width: 1 }] });
    mount();
    // Not editing — no fireEvent.click(cards-customize).

    const grid = screen.getByTestId('card-grid');
    const a = grid.querySelector('[data-card-id="card-a"]') as HTMLElement;
    const c = grid.querySelector('[data-card-id="card-c"]') as HTMLElement;

    fireEvent.dragStart(a);
    fireEvent.dragOver(c);
    fireEvent.drop(c);

    expect(wrapperIds()).toEqual(['card-a', 'card-b', 'card-c']);
    // Give any errant async persistence a tick to have fired before asserting its absence.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(saveUserPreferences).not.toHaveBeenCalled();
  });

  it('shows a hint and a reachable tray when the layout is empty', () => {
    seed({ version: 1, cards: [] });
    mount();

    expect(screen.getByTestId('card-grid')).toHaveTextContent(/no cards yet/i);
    fireEvent.click(screen.getByTestId('cards-customize'));
    expect(screen.getByTestId('cards-tray')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '+ Card A' })).toBeInTheDocument();
  });

  it('(i) grid container uses dense auto-flow with fine-grained rows for masonry packing', () => {
    seed({ version: 1, cards: [{ id: 'card-a', width: 1 }] });
    mount();

    const grid = screen.getByTestId('card-grid');
    expect(grid.style.gridAutoFlow).toBe('dense');
    expect(grid.style.gridAutoRows).toBe('8px');
    // Row-gap must be 0 with fine-grained auto-rows (a non-zero row-gap would
    // sit between every 8px track a card spans, inflating its height); the
    // visual gap is instead baked into each wrapper's paddingBottom below.
    expect(grid.style.rowGap).toBe('0px');
    expect(grid.style.columnGap).toBe('12px');
  });

  it('(j) each card wrapper carries the visual gap as paddingBottom, not CSS row-gap', () => {
    seed({ version: 1, cards: [{ id: 'card-a', width: 1 }] });
    mount();

    const wrapper = screen.getByTestId('card-grid').querySelector('[data-card-id="card-a"]') as HTMLElement;
    expect(wrapper.style.paddingBottom).toBe('12px');
  });

  it('(k) measures content height and sets a plausible grid-row span', () => {
    // useMasonrySpan measures synchronously in a layout effect (runs before
    // paint, deps []) — so unlike a plain-effect hook, there's no chance to
    // fake the height after mount and force a re-run via rerender(). Stub
    // offsetHeight at the HTMLElement prototype instead, so it's already in
    // place for the very first (and only) measurement the mount triggers.
    const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get: () => 500,
    });
    try {
      seed({ version: 1, cards: [{ id: 'card-a', width: 1 }] });
      mount();

      const wrapper = screen.getByTestId('card-grid').querySelector('[data-card-id="card-a"]') as HTMLElement;
      // (500px content + 12px gap) / 8px rows = 64.
      expect(wrapper.style.gridRow).toBe('span 64');
    } finally {
      if (descriptor) Object.defineProperty(HTMLElement.prototype, 'offsetHeight', descriptor);
    }
  });
});

// ── Pure logic (Wave 3 Task 13) ───────────────────────────────────────────
describe('reorderBefore (pure)', () => {
  const cards: CardLayoutEntry[] = [{ id: 'a', width: 1 }, { id: 'b', width: 1 }, { id: 'c', width: 1 }];

  it('moves the dragged card to just before the target', () => {
    expect(reorderBefore('a', 'c', cards)).toEqual([
      { id: 'b', width: 1 }, { id: 'a', width: 1 }, { id: 'c', width: 1 },
    ]);
  });

  it('is a no-op (same array reference) when dragged and target are the same card', () => {
    expect(reorderBefore('a', 'a', cards)).toBe(cards);
  });

  it('appends at the end when the target id is not found (e.g. removed mid-drag)', () => {
    expect(reorderBefore('a', 'missing', cards)).toEqual([
      { id: 'b', width: 1 }, { id: 'c', width: 1 }, { id: 'a', width: 1 },
    ]);
  });

  it('returns the original array reference unchanged when the dragged id is not found', () => {
    expect(reorderBefore('missing', 'b', cards)).toBe(cards);
  });

  it('does not mutate the input array', () => {
    const copy = [...cards];
    reorderBefore('a', 'c', cards);
    expect(cards).toEqual(copy);
  });
});

describe('snapResizeWidth (pure)', () => {
  it('rounds the pointer offset to the nearest column and returns it directly when supported', () => {
    expect(snapResizeWidth(150, 0, 92, [1, 2, 3])).toBe(2); // 150/92 ≈ 1.63 -> round 2
  });

  it('clamps a raw column count below 1 up to the minimum', () => {
    expect(snapResizeWidth(-500, 0, 92, [1, 2, 3])).toBe(1);
  });

  it('snaps to the nearest supported width when the exact column count is unsupported (ties favor the smaller)', () => {
    // raw = round(180/92) = 2, but only [1, 3] are supported — both are 1 away.
    expect(snapResizeWidth(180, 0, 92, [1, 3])).toBe(1);
  });

  it('clamps a huge pointer offset to the maximum supported width', () => {
    expect(snapResizeWidth(10_000, 0, 92, [1, 2, 3])).toBe(3);
  });

  it('accounts for the card being offset from the grid origin (cardLeft)', () => {
    // Same raw math as the first case, just shifted: (250-100)/92 ≈ 1.63 -> 2.
    expect(snapResizeWidth(250, 100, 92, [1, 2, 3])).toBe(2);
  });
});

// ── Touch reorder (Wave 3 Task 13) ────────────────────────────────────────
// jsdom emulation limits: there is no real hit-testing, so document.
// elementFromPoint (unimplemented in jsdom) is stubbed per-test to report
// whichever wrapper the scenario wants the pointer "over"; pointer geometry
// (clientX/clientY) is carried by the event but never actually reflects
// on-screen layout, so these tests exercise the state machine (armed timing,
// tolerance-cancel, drop-before-target) rather than pixel-accurate hit
// tracking — the e2e touch-reorder spec covers the real thing.
describe('CardGrid touch reorder', () => {
  const originalMaxTouchPoints = navigator.maxTouchPoints;
  const originalElementFromPoint = document.elementFromPoint;

  function mockTouchDevice() {
    Object.defineProperty(navigator, 'maxTouchPoints', { value: 5, configurable: true });
  }

  afterEach(() => {
    Object.defineProperty(navigator, 'maxTouchPoints', { value: originalMaxTouchPoints, configurable: true });
    document.elementFromPoint = originalElementFromPoint;
    vi.useRealTimers();
  });

  it('long-press arms move mode (lift class after ~500ms, not before), and drop-before-target persists', async () => {
    localStorage.setItem('token', 'tok');
    mockTouchDevice();
    seed({ version: 1, cards: [{ id: 'card-a', width: 1 }, { id: 'card-b', width: 1 }, { id: 'card-c', width: 1 }] });
    mount();
    fireEvent.click(screen.getByTestId('cards-customize'));

    const grid = screen.getByTestId('card-grid');
    const a = grid.querySelector('[data-card-id="card-a"]') as HTMLElement;
    const c = grid.querySelector('[data-card-id="card-c"]') as HTMLElement;
    document.elementFromPoint = vi.fn(() => c);

    // Fix wave I1: touch-action:none is on the card WRAPPER itself, present
    // from the moment edit mode is entered — not gated behind `armed` — so
    // it's already in force at touchstart, before the native scroll arbiter
    // can claim the gesture. Setting it only once armed (the old grid-level
    // behavior) was too late on a real device.
    expect(a.style.touchAction).toBe('none');

    vi.useFakeTimers();
    fireEvent.pointerDown(a, { clientX: 10, clientY: 10, pointerType: 'touch' });
    // Not armed yet at t=0 — no lift class, but touch-action was already
    // locked in before this pointerdown ever fired.
    expect(a.className).not.toContain('scale-105');
    expect(a.style.touchAction).toBe('none');

    act(() => { vi.advanceTimersByTime(500); });
    expect(a.className).toContain('scale-105');
    expect(a.className).toContain('shadow-2xl');
    expect(a.style.touchAction).toBe('none');
    vi.useRealTimers();

    fireEvent.pointerMove(window, { clientX: 12, clientY: 12 });
    fireEvent.pointerUp(window);

    expect(wrapperIds()).toEqual(['card-b', 'card-a', 'card-c']);
    expect(a.className).not.toContain('scale-105');
    // Still editing (only "Done" ends it) — touch-action stays locked.
    expect(a.style.touchAction).toBe('none');

    fireEvent.click(screen.getByTestId('cards-customize')); // Done
    expect(a.style.touchAction).not.toBe('none');
    await waitFor(() => {
      expect(saveUserPreferences).toHaveBeenCalledWith({
        'cards-dashboard': JSON.stringify({
          version: 1,
          cards: [{ id: 'card-b', width: 1 }, { id: 'card-a', width: 1 }, { id: 'card-c', width: 1 }],
        }),
      });
    });
  });

  it('pointercancel aborts the gesture instead of committing (drag-cancel semantics: act on nothing), and fully resets for the next gesture', async () => {
    localStorage.setItem('token', 'tok');
    mockTouchDevice();
    seed({ version: 1, cards: [{ id: 'card-a', width: 1 }, { id: 'card-b', width: 1 }, { id: 'card-c', width: 1 }] });
    mount();
    fireEvent.click(screen.getByTestId('cards-customize'));

    const grid = screen.getByTestId('card-grid');
    const a = grid.querySelector('[data-card-id="card-a"]') as HTMLElement;
    const c = grid.querySelector('[data-card-id="card-c"]') as HTMLElement;
    document.elementFromPoint = vi.fn(() => c);

    vi.useFakeTimers();
    fireEvent.pointerDown(a, { clientX: 10, clientY: 10, pointerType: 'touch' });
    act(() => { vi.advanceTimersByTime(500); });
    expect(a.className).toContain('scale-105');
    vi.useRealTimers();

    // Hovering over card-c (a drop here would normally reorder before it),
    // then the system revokes the gesture — e.g. a second touch starting a
    // pinch, or an OS interruption.
    fireEvent.pointerMove(window, { clientX: 12, clientY: 12 });
    fireEvent.pointerCancel(window);

    // Cleanup happened (disarmed, lift class gone) — touch-action stays
    // locked the whole time editing is on (see fix wave I1: it no longer
    // tracks `armed`, only `editing && touchDevice`), so it's still 'none'
    // here rather than being released by the cancel.
    expect(a.className).not.toContain('scale-105');
    expect(a.style.touchAction).toBe('none');
    // ...but nothing was committed: order unchanged, nothing persisted.
    expect(wrapperIds()).toEqual(['card-a', 'card-b', 'card-c']);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(saveUserPreferences).not.toHaveBeenCalled();

    // Armed state was fully cleaned up (refs/timers/listeners) — a fresh
    // long-press right after still works normally.
    vi.useFakeTimers();
    fireEvent.pointerDown(a, { clientX: 10, clientY: 10, pointerType: 'touch' });
    act(() => { vi.advanceTimersByTime(500); });
    expect(a.className).toContain('scale-105');
    vi.useRealTimers();

    fireEvent.pointerMove(window, { clientX: 12, clientY: 12 });
    fireEvent.pointerUp(window);
    expect(wrapperIds()).toEqual(['card-b', 'card-a', 'card-c']);
  });

  it('dropping on the origin card (self-hit) is a no-op', () => {
    mockTouchDevice();
    seed({ version: 1, cards: [{ id: 'card-a', width: 1 }, { id: 'card-b', width: 1 }, { id: 'card-c', width: 1 }] });
    mount();
    fireEvent.click(screen.getByTestId('cards-customize'));

    const grid = screen.getByTestId('card-grid');
    const a = grid.querySelector('[data-card-id="card-a"]') as HTMLElement;
    document.elementFromPoint = vi.fn(() => a);

    vi.useFakeTimers();
    fireEvent.pointerDown(a, { clientX: 10, clientY: 10, pointerType: 'touch' });
    act(() => { vi.advanceTimersByTime(500); });
    vi.useRealTimers();

    fireEvent.pointerMove(window, { clientX: 11, clientY: 11 }); // still hovering itself
    fireEvent.pointerUp(window);

    expect(a.className).not.toContain('scale-105');
    expect(wrapperIds()).toEqual(['card-a', 'card-b', 'card-c']);
  });

  it('a move past tolerance before the long-press fires cancels the gesture as a scroll, not a reorder', () => {
    mockTouchDevice();
    seed({ version: 1, cards: [{ id: 'card-a', width: 1 }, { id: 'card-b', width: 1 }, { id: 'card-c', width: 1 }] });
    mount();
    fireEvent.click(screen.getByTestId('cards-customize'));

    const grid = screen.getByTestId('card-grid');
    const a = grid.querySelector('[data-card-id="card-a"]') as HTMLElement;

    vi.useFakeTimers();
    fireEvent.pointerDown(a, { clientX: 10, clientY: 10, pointerType: 'touch' });
    fireEvent.pointerMove(window, { clientX: 50, clientY: 10 }); // past the 10px tolerance
    act(() => { vi.advanceTimersByTime(500); });

    expect(a.className).not.toContain('scale-105');
    expect(wrapperIds()).toEqual(['card-a', 'card-b', 'card-c']);
  });

  it('is inert for a mouse pointer even on a touch-capable device', () => {
    mockTouchDevice();
    seed({ version: 1, cards: [{ id: 'card-a', width: 1 }, { id: 'card-b', width: 1 }] });
    mount();
    fireEvent.click(screen.getByTestId('cards-customize'));

    const grid = screen.getByTestId('card-grid');
    const a = grid.querySelector('[data-card-id="card-a"]') as HTMLElement;

    vi.useFakeTimers();
    fireEvent.pointerDown(a, { clientX: 10, clientY: 10, pointerType: 'mouse' });
    act(() => { vi.advanceTimersByTime(500); });

    expect(a.className).not.toContain('scale-105');
  });

  it('is inert outside Customize mode', () => {
    mockTouchDevice();
    seed({ version: 1, cards: [{ id: 'card-a', width: 1 }, { id: 'card-b', width: 1 }] });
    mount();
    // Not editing.

    const grid = screen.getByTestId('card-grid');
    const a = grid.querySelector('[data-card-id="card-a"]') as HTMLElement;

    vi.useFakeTimers();
    fireEvent.pointerDown(a, { clientX: 10, clientY: 10, pointerType: 'touch' });
    act(() => { vi.advanceTimersByTime(500); });

    expect(a.className).not.toContain('scale-105');
  });

  // NOTE on jsdom emulation limits: `isTouchDevice()`'s `'ontouchstart' in
  // window` check is always true under jsdom (it defines the IDL handler
  // property unconditionally, unlike a real non-touch browser), so a
  // "resolves false" case can't be exercised here — the mouse-pointerType
  // test above already covers the meaningful non-touch-input path, and real
  // device detection is exercised by the e2e touch-reorder spec.
});

// ── Desktop edge resize (Wave 3 Task 13) ──────────────────────────────────
describe('CardGrid edge resize', () => {
  const originalGBCR = Element.prototype.getBoundingClientRect;

  afterEach(() => {
    Element.prototype.getBoundingClientRect = originalGBCR;
  });

  // Stubs getBoundingClientRect for the grid container and any card wrapper
  // named in `cardLefts`, keyed by data-card-id — jsdom never lays anything
  // out for real, so the resize handler's geometry reads need a fake.
  function stubGeometry(cardLefts: Record<string, number>, gridWidth: number) {
    Element.prototype.getBoundingClientRect = function (this: Element) {
      const blank = { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) };
      if (this.getAttribute?.('data-testid') === 'card-grid') {
        return { ...blank, left: 0, right: gridWidth, width: gridWidth } as DOMRect;
      }
      const cardId = this.getAttribute?.('data-card-id');
      if (cardId && cardId in cardLefts) {
        const left = cardLefts[cardId];
        return { ...blank, left, right: left, x: left } as DOMRect;
      }
      return blank as DOMRect;
    };
  }

  it('drag preview snaps to the nearest supported width and persists on release, without persisting mid-drag', async () => {
    localStorage.setItem('token', 'tok');
    // cols=3 (mockCols3 default from beforeEach); card-a supports [1, 2, 3].
    seed({ version: 1, cards: [{ id: 'card-a', width: 1 }] });
    mount();
    fireEvent.click(screen.getByTestId('cards-customize'));
    stubGeometry({ 'card-a': 0 }, 300); // colWidth = (300 - 2*12) / 3 = 92

    const handle = screen.getByTestId('card-resize-card-a');
    fireEvent.pointerDown(handle, { clientX: 0 });
    fireEvent.pointerMove(window, { clientX: 150 }); // round(150/92) = 2
    expect(screen.getByTestId('body-card-a')).toHaveTextContent('a:2');
    expect(saveUserPreferences).not.toHaveBeenCalled();

    fireEvent.pointerUp(window);
    await waitFor(() => {
      expect(saveUserPreferences).toHaveBeenCalledWith({
        'cards-dashboard': JSON.stringify({ version: 1, cards: [{ id: 'card-a', width: 2 }] }),
      });
    });

    // Further movement after release is not a resize.
    fireEvent.pointerMove(window, { clientX: 1000 });
    expect(screen.getByTestId('body-card-a')).toHaveTextContent('a:2');
  });

  it('keyboard arrows step through supported widths, clamped at both ends', () => {
    seed({ version: 1, cards: [{ id: 'card-a', width: 1 }] });
    mount();
    fireEvent.click(screen.getByTestId('cards-customize'));

    const handle = screen.getByTestId('card-resize-card-a');
    expect(handle).toHaveAttribute('aria-valuenow', '1');
    expect(handle).toHaveAttribute('aria-valuemin', '1');
    expect(handle).toHaveAttribute('aria-valuemax', '3');

    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(screen.getByTestId('body-card-a')).toHaveTextContent('a:2');
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    expect(screen.getByTestId('body-card-a')).toHaveTextContent('a:3');
    fireEvent.keyDown(handle, { key: 'ArrowRight' }); // clamped at max
    expect(screen.getByTestId('body-card-a')).toHaveTextContent('a:3');

    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    expect(screen.getByTestId('body-card-a')).toHaveTextContent('a:2');
    fireEvent.keyDown(handle, { key: 'ArrowLeft' });
    fireEvent.keyDown(handle, { key: 'ArrowLeft' }); // clamped at min
    expect(screen.getByTestId('body-card-a')).toHaveTextContent('a:1');
  });

  it('renders no resize handle for a card with only one supported width', () => {
    seed({ version: 1, cards: [{ id: 'card-b', width: 1 }] }); // card-b: widths=[1]
    mount();
    fireEvent.click(screen.getByTestId('cards-customize'));
    expect(screen.queryByTestId('card-resize-card-b')).toBeNull();
  });

  it('resize handle is absent outside Customize mode', () => {
    seed({ version: 1, cards: [{ id: 'card-a', width: 1 }] });
    mount();
    expect(screen.queryByTestId('card-resize-card-a')).toBeNull();
  });
});
