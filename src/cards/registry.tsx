// src/cards/registry.tsx — skeleton this task; entries added by Tasks 6-11.
//
// NOTE: this file must never import a card module. Card modules import
// registerCards FROM here, so a static import the other way would create a
// circular import and CARD_REGISTRY would still be [] (TDZ) when the card
// module's top-level registerCards(...) call runs. src/cards/index.ts is the
// place side-effect card-module imports get appended (Tasks 6-11); everything
// outside src/cards imports from 'src/cards' (the index), not from here.
import { CardDef, CardPage, CardLayout, CardLayoutEntry, CardContext, CardWidth } from './types';

export const CARD_REGISTRY: CardDef[] = [];   // populated via registerCards()

export function registerCards(defs: CardDef[]): void {
  CARD_REGISTRY.push(...defs);
}

export function cardsForPage(page: CardPage, ctx: CardContext): CardDef[] {
  return CARD_REGISTRY.filter(c => c.page === page && (!c.adminOnly || ctx.isAdmin));
}

export const DEFAULT_LAYOUTS: Record<CardPage, CardLayout> = {
  dashboard: { version: 1, cards: [
    { id: 'dash-attention', width: 2 }, { id: 'dash-deck', width: 1 },
    { id: 'dash-money', width: 2 }, { id: 'dash-activity', width: 1 },
  ]},
  project: { version: 1, cards: [
    { id: 'pj-financial-band', width: 3 },
    { id: 'pj-open-items', width: 1 }, { id: 'pj-happenings', width: 2 },
  ]},
  customer: { version: 1, cards: [
    { id: 'cu-rollup', width: 3 },
    { id: 'cu-projects', width: 2 }, { id: 'cu-attention', width: 1 }, { id: 'cu-correspondence', width: 1 },
  ]},
};

// Nearest-lower supported width; falls back to the card's smallest supported
// width when the requested width is below everything the card supports.
function clampWidth(width: number, widths: CardWidth[]): CardWidth {
  const notGreater = widths.filter(w => w <= width);
  if (notGreater.length) return Math.max(...notGreater) as CardWidth;
  return Math.min(...widths) as CardWidth;
}

function isCardLayout(v: unknown): v is CardLayout {
  return !!v && typeof v === 'object' && (v as CardLayout).version === 1 && Array.isArray((v as CardLayout).cards);
}

// Sanitize a stored layout against the registry + ctx: drop unknown/ungated
// ids, clamp widths to each card's supported list, fall back to default.
export function resolveLayout(stored: CardLayout | null, page: CardPage, ctx: CardContext): CardLayout {
  const available = cardsForPage(page, ctx);
  const byId = new Map(available.map(c => [c.id, c]));
  const source: CardLayoutEntry[] = isCardLayout(stored) ? stored.cards : DEFAULT_LAYOUTS[page].cards;

  const cards: CardLayoutEntry[] = [];
  for (const entry of source) {
    const def = byId.get(entry.id);
    if (!def) continue; // unknown id, or adminOnly and ctx isn't admin
    cards.push({ id: entry.id, width: clampWidth(entry.width, def.widths) });
  }
  return { version: 1, cards };
}
