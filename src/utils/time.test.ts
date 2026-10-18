// src/utils/time.test.ts
import { describe, it, expect } from 'vitest';
import { DAY, timeAgo, startOfWeek, hoursThisWeek, fmtDate } from './time';

describe('DAY', () => {
  it('is 86,400,000ms', () => {
    expect(DAY).toBe(86_400_000);
  });
});

describe('timeAgo', () => {
  it('formats rough relative times', () => {
    const now = Date.now();
    expect(timeAgo(now - 30_000)).toBe('just now');
    expect(timeAgo(now - 5 * 60_000)).toBe('5m ago');
    expect(timeAgo(now - 3 * 3_600_000)).toBe('3h ago');
    expect(timeAgo(now - 2 * 86_400_000)).toBe('2d ago');
  });
});

describe('startOfWeek', () => {
  it('returns the preceding Sunday at 00:00 for a mid-week date', () => {
    // Wed 2026-06-10 15:30 local → Sun 2026-06-07 00:00 local
    const wed = new Date(2026, 5, 10, 15, 30);
    const start = new Date(startOfWeek(wed));
    expect(start.getDay()).toBe(0); // Sunday
    expect([start.getHours(), start.getMinutes()]).toEqual([0, 0]);
    expect(start.getDate()).toBe(7);
  });

  it('anchors a Sunday input to that same Sunday at 00:00 (its Sun–Sat week starts there)', () => {
    // Sun 2026-06-14 09:00 → Sun 2026-06-14 00:00 local — a Sunday begins
    // its own week, it does not fall back to the previous one.
    const sun = new Date(2026, 5, 14, 9, 0);
    const start = new Date(startOfWeek(sun));
    expect(start.getDay()).toBe(0);
    expect(start.getDate()).toBe(14);
    expect(start.getMonth()).toBe(5);
  });
});

describe('hoursThisWeek', () => {
  it('sums only entries clocked in this week, counting open entries to now', () => {
    const now = new Date(2026, 5, 10, 12, 0).getTime(); // Wed noon
    const weekStart = startOfWeek(new Date(now));
    const entries = [
      { clockIn: weekStart + 3_600_000, clockOut: weekStart + 3 * 3_600_000 }, // 2h
      { clockIn: now - 1_800_000, clockOut: null },                            // 0.5h open
      { clockIn: weekStart - 24 * 3_600_000, clockOut: weekStart - 20 * 3_600_000 }, // last week
    ];
    expect(hoursThisWeek(entries, now)).toBeCloseTo(2.5, 5);
  });

  it('charges an overnight Sat→Sun shift to the week it started in (last week)', () => {
    // Sunday 2026-06-07 00:00 is the start of "this" week.
    const now = new Date(2026, 5, 10, 12, 0).getTime(); // Wed noon, same week
    const weekStart = startOfWeek(new Date(now));
    const saturdayBeforeMidnight = weekStart - 2 * 3_600_000; // Sat 22:00, previous week
    const sundayAfterMidnight = weekStart + 1 * 3_600_000;    // Sun 01:00, this week
    const entries = [
      { clockIn: saturdayBeforeMidnight, clockOut: sundayAfterMidnight }, // started last week
    ];
    // Charged entirely to the week it STARTED in → excluded from "this week".
    expect(hoursThisWeek(entries, now)).toBe(0);
  });
});

describe('fmtDate', () => {
  it('formats an epoch-ms number', () => {
    const ms = new Date(2026, 5, 10).getTime();
    expect(fmtDate(ms)).toBe(new Date(ms).toLocaleDateString());
  });

  it('formats an ISO string', () => {
    const iso = '2026-06-10T00:00:00.000Z';
    expect(fmtDate(iso)).toBe(new Date(iso).toLocaleDateString());
  });

  it('returns an em dash for null or undefined', () => {
    expect(fmtDate(null)).toBe('—');
    expect(fmtDate(undefined)).toBe('—');
  });
});
