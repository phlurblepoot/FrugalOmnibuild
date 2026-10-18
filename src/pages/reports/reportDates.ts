// src/pages/reports/reportDates.ts — the Payments received report's date
// range: presets over the local calendar, and how a report shows a calendar
// day. Report dates travel as 'YYYY-MM-DD' (server/reportsStore.ts, through
// billingDay), so they are shown as that day, never shifted through a
// timezone. The day helpers are billing's own (utils/billingDates).
import { formatDay, ymd } from '../../utils/billingDates';

export { formatDay, parseDay, ymd } from '../../utils/billingDates';

export type DatePreset = 'this-month' | 'last-month' | 'this-quarter' | 'year-to-date' | 'last-year' | 'all' | 'custom';

export const DATE_PRESETS: { value: DatePreset; label: string }[] = [
  { value: 'this-month', label: 'This month' },
  { value: 'last-month', label: 'Last month' },
  { value: 'this-quarter', label: 'This quarter' },
  { value: 'year-to-date', label: 'Year to date' },
  { value: 'last-year', label: 'Last year' },
  { value: 'all', label: 'All time' },
  { value: 'custom', label: 'Custom range' },
];

export const DEFAULT_DATE_PRESET: DatePreset = 'this-month';

/** The days a preset covers, both inclusive ('' = open). 'custom' has none of its own. */
export function presetRange(preset: DatePreset, today: Date = new Date()): { from: string; to: string } {
  const y = today.getFullYear();
  const m = today.getMonth();
  switch (preset) {
    case 'this-month': return { from: ymd(new Date(y, m, 1)), to: ymd(new Date(y, m + 1, 0)) };
    case 'last-month': return { from: ymd(new Date(y, m - 1, 1)), to: ymd(new Date(y, m, 0)) };
    case 'this-quarter': {
      const q = Math.floor(m / 3) * 3;
      return { from: ymd(new Date(y, q, 1)), to: ymd(new Date(y, q + 3, 0)) };
    }
    case 'year-to-date': return { from: ymd(new Date(y, 0, 1)), to: ymd(today) };
    case 'last-year': return { from: ymd(new Date(y - 1, 0, 1)), to: ymd(new Date(y - 1, 11, 31)) };
    case 'all':
    case 'custom': return { from: '', to: '' };
  }
}

/** "10/1/2026 – 10/31/2026", "From 10/1/2026", "Through 10/31/2026", "All dates". */
export function rangeLabel(from: string, to: string): string {
  if (from && to) return `${formatDay(from)} – ${formatDay(to)}`;
  if (from) return `From ${formatDay(from)}`;
  if (to) return `Through ${formatDay(to)}`;
  return 'All dates';
}
