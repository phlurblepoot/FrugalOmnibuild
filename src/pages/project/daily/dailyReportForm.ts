import type { ManCountLine } from '../../../utils/store';

export const normalizeManCounts = (lines: ManCountLine[]): ManCountLine[] =>
  lines
    .map(l => ({ type: l.type.trim(), count: Number.isFinite(l.count) ? Math.max(0, Math.floor(l.count)) : 0 }))
    .filter(l => l.type !== '');
export const manCountLabel = (l: ManCountLine): string => `${l.type} — ${l.count} ${l.count === 1 ? 'man' : 'men'}`;
export const weatherLine = (summary: string, temperature: string): string =>
  [summary, temperature].filter(Boolean).join(' · ');

export const manCountTotal = (lines: ManCountLine[]): number =>
  lines.reduce((s, l) => s + (Number.isFinite(l.count) && l.count > 0 ? l.count : 0), 0);

export const formatReportDate = (d: string): string => {
  const m = d.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return d;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
};

// How the app names one report: since one date can hold a report per crew,
// the crew goes with the date — "Daily Report — Aug 26, 2026 — Crew 1". A
// report without a crew name (its crew is gone) is named by its date alone.
export const dailyReportTitle = (r: { reportDate: string; crewName?: string | null }): string =>
  `Daily Report — ${formatReportDate(r.reportDate)}${r.crewName ? ` — ${r.crewName}` : ''}`;

// A report's start time ('HH:MM', 24-hour) as the app shows it: "7:00 AM".
// Blank for none (a report made before start times existed); a malformed value
// falls back to the raw string, as formatReportDate does.
export const formatStartTime = (t: string | null | undefined): string => {
  if (!t) return '';
  const m = t.match(/^(\d{2}):(\d{2})$/);
  if (!m) return t;
  const h = Number(m[1]);
  return `${h % 12 === 0 ? 12 : h % 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
};

// The hour the report's weather starts at: the start time's hour (minutes
// dropped, as the server does), or 6 — the original 6 AM–6 PM window — when
// there is no start time. Two start times in the same hour fetch the same
// weather.
export const weatherStartHour = (t: string | null | undefined): number => {
  const m = (t ?? '').match(/^(\d{2}):\d{2}$/);
  return m ? Number(m[1]) : 6;
};
