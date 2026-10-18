// src/cards/useCardLayout.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { CardDef } from './types';

const getUserPreferences = vi.fn(async (): Promise<Record<string, string>> => ({}));
const saveUserPreferences = vi.fn(async (_p: Record<string, string>): Promise<void> => {});

vi.mock('../utils/store', async () => {
  const actual = await vi.importActual<typeof import('../utils/store')>('../utils/store');
  return { ...actual, getUserPreferences, saveUserPreferences };
});

const { useCardLayout } = await import('./useCardLayout');
const { CARD_REGISTRY, registerCards, resolveLayout } = await import('./registry');

// Two throwaway cards, reusing real DEFAULT_LAYOUTS.dashboard ids so the
// default-layout path (which reads DEFAULT_LAYOUTS) has something to resolve
// against. 'dash-money' is adminOnly to exercise the admin-gating case.
const CARD_ATTENTION: CardDef = {
  id: 'dash-attention', title: 'Attention', icon: () => null, page: 'dashboard',
  widths: [1, 2], defaultWidth: 2, Component: () => null,
};
const CARD_MONEY: CardDef = {
  id: 'dash-money', title: 'Money', icon: () => null, page: 'dashboard',
  widths: [1, 2, 3], defaultWidth: 2, adminOnly: true, Component: () => null,
};

beforeEach(() => {
  // CARD_REGISTRY is module state shared across the whole test run — reset it
  // before every test so cards registered by one test can't leak into another.
  CARD_REGISTRY.splice(0, CARD_REGISTRY.length);
  registerCards([CARD_ATTENTION, CARD_MONEY]);
  localStorage.clear();
  getUserPreferences.mockClear().mockResolvedValue({});
  saveUserPreferences.mockClear().mockResolvedValue(undefined);
});

describe('resolveLayout', () => {
  it('drops an id not in the registry', () => {
    const stored = { version: 1 as const, cards: [{ id: 'dash-attention', width: 1 as const }, { id: 'nonexistent', width: 2 as const }] };
    const result = resolveLayout(stored, 'dashboard', { isAdmin: true });
    expect(result.cards).toEqual([{ id: 'dash-attention', width: 1 }]);
  });

  it("clamps width 3 to a card's max supported width", () => {
    const stored = { version: 1 as const, cards: [{ id: 'dash-attention', width: 3 as const }] };
    const result = resolveLayout(stored, 'dashboard', { isAdmin: true });
    // dash-attention only supports [1, 2] — 3 clamps down to 2 (nearest lower).
    expect(result.cards).toEqual([{ id: 'dash-attention', width: 2 }]);
  });

  it('drops admin-only card ids when ctx.isAdmin is false', () => {
    const result = resolveLayout(null, 'dashboard', { isAdmin: false });
    expect(result.cards.some(c => c.id === 'dash-money')).toBe(false);
    expect(result.cards.some(c => c.id === 'dash-attention')).toBe(true);
  });

  it('falls back to DEFAULT_LAYOUTS when stored is null/garbage', () => {
    const withGarbage = resolveLayout({ nonsense: true } as any, 'dashboard', { isAdmin: true });
    const withNull = resolveLayout(null, 'dashboard', { isAdmin: true });
    expect(withGarbage).toEqual(withNull);
    expect(withNull.cards.map(c => c.id).sort()).toEqual(['dash-attention', 'dash-money']);
  });
});

describe('useCardLayout', () => {
  it('returns the default layout when nothing is stored', () => {
    const { result } = renderHook(() => useCardLayout('dashboard', { isAdmin: true }));
    expect(result.current.layout).toEqual(resolveLayout(null, 'dashboard', { isAdmin: true }));
  });

  it('seeds instantly from the localStorage mirror', () => {
    localStorage.setItem('cards-dashboard', JSON.stringify({ version: 1, cards: [{ id: 'dash-attention', width: 1 }] }));
    const { result } = renderHook(() => useCardLayout('dashboard', { isAdmin: true }));
    // Instant — no waitFor: this must be true on the very first render.
    expect(result.current.layout.cards).toEqual([{ id: 'dash-attention', width: 1 }]);
  });

  it('reconciles to the server value after mount', async () => {
    localStorage.setItem('token', 'tok');
    getUserPreferences.mockResolvedValue({
      'cards-dashboard': JSON.stringify({ version: 1, cards: [{ id: 'dash-money', width: 3 }] }),
    });
    const { result } = renderHook(() => useCardLayout('dashboard', { isAdmin: true }));
    // Before reconciliation, the default (no local mirror) is shown.
    await waitFor(() => {
      expect(result.current.layout.cards).toEqual([{ id: 'dash-money', width: 3 }]);
    });
  });

  it('setLayout persists to both localStorage and saveUserPreferences under key cards-dashboard', async () => {
    localStorage.setItem('token', 'tok');
    const { result } = renderHook(() => useCardLayout('dashboard', { isAdmin: true }));
    const next = { version: 1 as const, cards: [{ id: 'dash-attention', width: 1 as const }] };

    act(() => {
      result.current.setLayout(next);
    });

    expect(result.current.layout).toEqual(next);
    expect(localStorage.getItem('cards-dashboard')).toBe(JSON.stringify(next));
    await waitFor(() => {
      expect(saveUserPreferences).toHaveBeenCalledWith({ 'cards-dashboard': JSON.stringify(next) });
    });
  });

  it('reset restores DEFAULT_LAYOUTS for the page', () => {
    localStorage.setItem('cards-dashboard', JSON.stringify({ version: 1, cards: [{ id: 'dash-attention', width: 1 }] }));
    const { result } = renderHook(() => useCardLayout('dashboard', { isAdmin: true }));
    act(() => {
      result.current.reset();
    });
    expect(result.current.layout).toEqual(resolveLayout(null, 'dashboard', { isAdmin: true }));
  });
});
