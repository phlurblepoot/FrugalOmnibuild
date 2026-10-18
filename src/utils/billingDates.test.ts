// src/utils/billingDates.test.ts — billing dates read as the day that was
// picked, in a US time zone (where UTC midnight is the evening before).
import { describe, it, expect, vi, afterEach } from 'vitest';
import { billingDay, formatBillingDate, formatDay, parseDay, todayDay, ymd } from './billingDates';
import { useTimeZone } from '../test/timeZone';

useTimeZone('America/Los_Angeles');

// What a billing editor stores for a day picked in its date box.
const picked = (day: string) => new Date(day).getTime();

afterEach(() => { vi.useRealTimers(); });

describe('billingDay', () => {
  it('runs west of UTC, where a picked day stored at UTC midnight is the evening before', () => {
    expect(new Date(picked('2026-10-01')).getDate()).toBe(30);
  });

  it('reads a picked day (UTC midnight) as that day', () => {
    expect(billingDay(picked('2026-10-01'))).toBe('2026-10-01');
    for (const day of ['2026-01-01', '2026-03-08', '2026-11-01', '2026-12-31', '2028-02-29']) {
      expect(billingDay(picked(day))).toBe(day);
    }
  });

  it('reads a pay app\'s YYYY-MM-DD text as that day', () => {
    expect(billingDay('2026-10-01')).toBe('2026-10-01');
  });

  it('reads any other timestamp — a payment stamped "now" — as its local day', () => {
    // 8:30pm Oct 6 in Los Angeles is already Oct 7 in UTC.
    expect(billingDay(Date.UTC(2026, 9, 7, 3, 30))).toBe('2026-10-06');
    expect(billingDay(Date.UTC(2026, 9, 1, 15, 30))).toBe('2026-10-01');
    expect(billingDay('2026-10-07T03:30:00.000Z')).toBe('2026-10-06');
    expect(billingDay('2026-10-01T00:00:00.000Z')).toBe('2026-10-01');
  });

  it('is null when there is no date', () => {
    for (const none of [null, undefined, '', 'soon', NaN, 1e20]) expect(billingDay(none)).toBeNull();
  });
});

describe('formatBillingDate', () => {
  const oct1 = new Date(2026, 9, 1).toLocaleDateString();

  it('shows a picked day as that day, not the day before', () => {
    expect(formatBillingDate(picked('2026-10-01'))).toBe(oct1);
    expect(formatBillingDate('2026-10-01')).toBe(oct1);
  });

  it('shows an instant as its local day, and a dash for none', () => {
    expect(formatBillingDate(Date.UTC(2026, 9, 2, 3, 30))).toBe(oct1);
    expect(formatBillingDate(null)).toBe('—');
    expect(formatBillingDate(undefined)).toBe('—');
  });
});

describe('days', () => {
  it('today is the local calendar day, even when UTC has moved on', () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 9, 7, 3, 30)); // Oct 6, 8:30pm in Los Angeles
    expect(todayDay()).toBe('2026-10-06');
  });

  it('parses and formats YYYY-MM-DD as that local day', () => {
    expect(ymd(parseDay('2026-10-01')!)).toBe('2026-10-01');
    expect(parseDay('10/01/2026')).toBeNull();
    expect(formatDay('2026-10-01')).toBe(new Date(2026, 9, 1).toLocaleDateString());
    expect(formatDay(null)).toBe('—');
  });
});
