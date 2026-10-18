// src/pages/reports/reportDates.test.ts — the Payments received report's date
// presets (local calendar) and how report days are shown.
import { describe, it, expect } from 'vitest';
import { presetRange, parseDay, formatDay, rangeLabel, ymd, DATE_PRESETS, DEFAULT_DATE_PRESET } from './reportDates';

// Wed Oct 6, 2026, late evening local — a UTC-based calculation would roll
// into the 7th in the Americas.
const today = new Date(2026, 9, 6, 23, 30);

describe('presetRange', () => {
  it('covers whole local calendar periods, both ends inclusive', () => {
    expect(presetRange('this-month', today)).toEqual({ from: '2026-10-01', to: '2026-10-31' });
    expect(presetRange('last-month', today)).toEqual({ from: '2026-09-01', to: '2026-09-30' });
    expect(presetRange('this-quarter', today)).toEqual({ from: '2026-10-01', to: '2026-12-31' });
    expect(presetRange('year-to-date', today)).toEqual({ from: '2026-01-01', to: '2026-10-06' });
    expect(presetRange('last-year', today)).toEqual({ from: '2025-01-01', to: '2025-12-31' });
    expect(presetRange('all', today)).toEqual({ from: '', to: '' });
  });

  it('handles January (last month is last year\'s December) and February', () => {
    expect(presetRange('last-month', new Date(2027, 0, 15))).toEqual({ from: '2026-12-01', to: '2026-12-31' });
    expect(presetRange('this-month', new Date(2028, 1, 3))).toEqual({ from: '2028-02-01', to: '2028-02-29' });
    expect(presetRange('this-quarter', new Date(2026, 1, 3))).toEqual({ from: '2026-01-01', to: '2026-03-31' });
  });

  it('defaults to this month, and lists a custom range last', () => {
    expect(DEFAULT_DATE_PRESET).toBe('this-month');
    expect(DATE_PRESETS.map(p => p.value).at(-1)).toBe('custom');
  });
});

describe('report days', () => {
  it('parses YYYY-MM-DD as that local day, never shifted', () => {
    expect(ymd(parseDay('2026-10-01')!)).toBe('2026-10-01');
    expect(parseDay('10/01/2026')).toBeNull();
    expect(parseDay(null)).toBeNull();
  });

  it('formats a day in the viewer\'s format, or a dash', () => {
    expect(formatDay('2026-10-01')).toBe(new Date(2026, 9, 1).toLocaleDateString());
    expect(formatDay(null)).toBe('—');
  });

  it('labels a range', () => {
    const d = (s: string) => formatDay(s);
    expect(rangeLabel('2026-10-01', '2026-10-31')).toBe(`${d('2026-10-01')} – ${d('2026-10-31')}`);
    expect(rangeLabel('2026-10-01', '')).toBe(`From ${d('2026-10-01')}`);
    expect(rangeLabel('', '2026-10-31')).toBe(`Through ${d('2026-10-31')}`);
    expect(rangeLabel('', '')).toBe('All dates');
  });
});
