// src/utils/money.ts
// Money helpers — the server is the source of truth for totals (cents); these
// format for display and convert form input. Never sum dollar floats in the UI.

export const formatMoney = (cents: number): string =>
  (cents / 100).toLocaleString(undefined, { style: 'currency', currency: 'USD' });

export const dollarsToCents = (dollars: number | string): number => {
  const n = typeof dollars === 'string' ? parseFloat(dollars) : dollars;
  return Math.round((Number.isFinite(n) ? n : 0) * 100);
};

export const centsToDollars = (cents: number): number => cents / 100;
