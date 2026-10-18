// src/cards/useCardLayout.ts
//
// Per-user card layout for one page: instant from a localStorage mirror,
// reconciled against the account's stored preference (server wins when it
// differs) on mount and again on cross-device sync — same shape as the
// accent-color/theme prefs in ThemeContext.tsx.
import { useEffect, useRef, useState } from 'react';
import { getUserPreferences, saveUserPreferences } from '../utils/store';
import type { CardContext, CardLayout, CardPage } from './types';
import { DEFAULT_LAYOUTS, resolveLayout } from './registry';

function readLocal(key: string): CardLayout | null {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw) as CardLayout;
  } catch {
    return null;
  }
}

function writeLocal(key: string, layout: CardLayout): void {
  try {
    localStorage.setItem(key, JSON.stringify(layout));
  } catch {
    // storage unavailable (private browsing, quota) — in-memory state still works
  }
}

export function useCardLayout(page: CardPage, ctx: CardContext): {
  layout: CardLayout;
  setLayout: (l: CardLayout) => void;
  reset: () => void;
} {
  const key = `cards-${page}`;
  // ctx can change (e.g. isAdmin resolving) without page changing; reconcile
  // reads the latest ctx without re-subscribing the effect below.
  const ctxRef = useRef(ctx);
  ctxRef.current = ctx;

  const [layout, setLayoutState] = useState<CardLayout>(() =>
    resolveLayout(readLocal(key), page, ctx)
  );

  useEffect(() => {
    const reconcile = () => {
      if (!localStorage.getItem('token')) return;
      getUserPreferences().then(prefs => {
        const raw = prefs[key];
        if (!raw) return;
        try {
          const parsed = JSON.parse(raw) as CardLayout;
          setLayoutState(resolveLayout(parsed, page, ctxRef.current));
        } catch {
          // malformed stored value — keep whatever's currently shown
        }
      }).catch(() => { /* offline / not logged in — keep localStorage/default */ });
    };

    reconcile();
    window.addEventListener('app:prefs-sync', reconcile);
    return () => window.removeEventListener('app:prefs-sync', reconcile);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, key]);

  const setLayout = (l: CardLayout) => {
    setLayoutState(l);
    writeLocal(key, l);
    if (localStorage.getItem('token')) {
      saveUserPreferences({ [key]: JSON.stringify(l) }).catch(() => {});
    }
  };

  // layout is documented as always "resolved" — reset re-resolves the raw
  // default against the live registry + ctx rather than storing it verbatim,
  // so a reset layout is never stale relative to what's actually registered.
  const reset = () => setLayout(resolveLayout(DEFAULT_LAYOUTS[page], page, ctxRef.current));

  return { layout, setLayout, reset };
}
