// src/pages/mail/mailFormat.test.ts
import { describe, it, expect } from 'vitest';
import { formatMailDate, itemTypeLabel, participantsLabel } from './mailFormat';
import type { Addr } from './types';

// Fixed "now" so the three branches are deterministic: Sat 2026-08-29 15:00 local.
const NOW = new Date(2026, 7, 29, 15, 0, 0);
const at = (y: number, m: number, d: number, h = 9, min = 0) => new Date(y, m, d, h, min).toISOString();

describe('formatMailDate', () => {
  it('shows the clock time for a message from today', () => {
    expect(formatMailDate(at(2026, 7, 29, 10, 42), NOW)).toBe('10:42 AM');
  });

  it('shows month + day for an earlier message in the same year', () => {
    expect(formatMailDate(at(2026, 7, 27), NOW)).toBe('Aug 27');
  });

  it('shows a numeric M/D/YY date for a message from another year', () => {
    expect(formatMailDate(at(2025, 7, 27), NOW)).toBe('8/27/25');
  });

  it('treats a same-clock-time message from another day as a date, not a time', () => {
    expect(formatMailDate(at(2026, 7, 28, 15, 0), NOW)).toBe('Aug 28');
  });

  it('returns an empty string for a missing or unparseable date', () => {
    expect(formatMailDate('', NOW)).toBe('');
    expect(formatMailDate('not-a-date', NOW)).toBe('');
  });
});

describe('participantsLabel', () => {
  const p = (addr: string, name?: string): Addr => (name ? { addr, name } : { addr });

  it('replaces the account owner with "me" (case-insensitively) and uses first names', () => {
    expect(
      participantsLabel([p('noah@birchwoodplaster.example', 'Noah Reed'), p('bob@acme.com', 'Bob Smith')], [
        'Noah@BirchwoodPlaster.example',
      ]),
    ).toBe('me, Bob');
  });

  it('falls back to the address local part when a participant has no display name', () => {
    expect(participantsLabel([p('jane.doe@acme.com')], [])).toBe('jane.doe');
  });

  it('collapses duplicates so a long back-and-forth reads as two people', () => {
    expect(
      participantsLabel([p('me@x.com', 'Me'), p('bob@acme.com', 'Bob Smith'), p('bob@acme.com', 'Bob Smith')], ['me@x.com']),
    ).toBe('me, Bob');
  });

  it('shows at most three names and marks the rest with an ellipsis', () => {
    const label = participantsLabel(
      [p('a@x.com', 'Ann A'), p('b@x.com', 'Bob B'), p('c@x.com', 'Cara C'), p('d@x.com', 'Dan D')],
      [],
    );
    expect(label).toBe('Ann, Bob, Cara…');
  });

  it('returns a placeholder rather than an empty cell when there are no participants', () => {
    expect(participantsLabel([], ['me@x.com'])).toBe('(unknown)');
  });
});

describe('itemTypeLabel', () => {
  it('renders the acronym types uppercase and the camelCase ones as words', () => {
    expect(itemTypeLabel('rfi')).toBe('RFI');
    expect(itemTypeLabel('changeOrder')).toBe('Change Order');
    expect(itemTypeLabel('payApp')).toBe('Pay App');
    expect(itemTypeLabel('dailyReport')).toBe('Daily Report');
    expect(itemTypeLabel('proposal')).toBe('Proposal');
  });
});
