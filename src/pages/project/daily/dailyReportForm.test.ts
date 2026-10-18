import { describe, it, expect } from 'vitest';
import { normalizeManCounts, manCountLabel, weatherLine, formatStartTime, weatherStartHour, dailyReportTitle } from './dailyReportForm';

describe('normalizeManCounts', () => {
  it('drops empty-type lines and clamps counts to non-negative integers', () => {
    expect(normalizeManCounts([
      { type: ' Plasterer ', count: 4.7 }, { type: '', count: 3 }, { type: 'Sup', count: -1 },
    ])).toEqual([{ type: 'Plasterer', count: 4 }, { type: 'Sup', count: 0 }]);
  });
  it('keeps zero-count typed lines (a named crew with 0 men is meaningful)', () => {
    expect(normalizeManCounts([{ type: 'Laborer', count: 0 }])).toEqual([{ type: 'Laborer', count: 0 }]);
  });
});
describe('manCountLabel', () => {
  it('pluralizes', () => {
    expect(manCountLabel({ type: 'Plasterer', count: 4 })).toBe('Plasterer — 4 men');
    expect(manCountLabel({ type: 'Supervisor', count: 1 })).toBe('Supervisor — 1 man');
  });
});
describe('weatherLine', () => {
  it('joins summary and temperature, omitting empties', () => {
    expect(weatherLine('Partly cloudy', '58–74°F')).toBe('Partly cloudy · 58–74°F');
    expect(weatherLine('', '58–74°F')).toBe('58–74°F');
    expect(weatherLine('', '')).toBe('');
  });
});
describe('formatStartTime', () => {
  it('shows HH:MM as a 12-hour clock time', () => {
    expect(formatStartTime('07:00')).toBe('7:00 AM');
    expect(formatStartTime('06:30')).toBe('6:30 AM');
    expect(formatStartTime('13:45')).toBe('1:45 PM');
    expect(formatStartTime('12:00')).toBe('12:00 PM');
    expect(formatStartTime('00:15')).toBe('12:15 AM');
    expect(formatStartTime('23:59')).toBe('11:59 PM');
  });
  it('is blank for no start time and the raw string when malformed', () => {
    expect(formatStartTime(null)).toBe('');
    expect(formatStartTime(undefined)).toBe('');
    expect(formatStartTime('')).toBe('');
    expect(formatStartTime('7am')).toBe('7am');
  });
});
describe('weatherStartHour', () => {
  it('is the start time\'s hour, minutes dropped', () => {
    expect(weatherStartHour('07:00')).toBe(7);
    expect(weatherStartHour('07:59')).toBe(7);
    expect(weatherStartHour('18:30')).toBe(18);
    expect(weatherStartHour('00:00')).toBe(0);
  });
  it('is 6 (the original 6 AM–6 PM window) without a start time', () => {
    expect(weatherStartHour(null)).toBe(6);
    expect(weatherStartHour('')).toBe(6);
  });
});
describe('dailyReportTitle', () => {
  it('names a report by its date and crew — one date can hold a report per crew', () => {
    expect(dailyReportTitle({ reportDate: '2026-08-26', crewName: 'Smith Drywall' })).toBe('Daily Report — Aug 26, 2026 — Smith Drywall');
  });
  it('falls back to the date alone when the crew is unknown', () => {
    expect(dailyReportTitle({ reportDate: '2026-08-26', crewName: null })).toBe('Daily Report — Aug 26, 2026');
    expect(dailyReportTitle({ reportDate: '2026-08-26' })).toBe('Daily Report — Aug 26, 2026');
  });
});
