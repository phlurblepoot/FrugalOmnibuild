import { describe, it, expect } from 'vitest';
import { proposalLabel, expiryText, STATUS_TONE } from './proposalPresentation';

describe('proposalPresentation', () => {
  it('labels revisions', () => {
    expect(proposalLabel({ number: 2, revisedFromNumber: 1 })).toBe('#2 (rev. of #1)');
    expect(proposalLabel({ number: 1, revisedFromNumber: null })).toBe('#1');
  });

  it('expiry only for sent proposals', () => {
    const today = new Date('2026-08-28T12:00:00');
    expect(expiryText({ status: 'draft', validUntil: '2026-08-30' }, today)).toBeNull();
    expect(expiryText({ status: 'sent', validUntil: null }, today)).toBeNull();
    expect(expiryText({ status: 'sent', validUntil: '2026-09-03' }, today)).toBe('expires in 6 days');
    expect(expiryText({ status: 'sent', validUntil: '2026-08-28' }, today)).toBe('expires today');
    expect(expiryText({ status: 'sent', validUntil: '2026-08-25' }, today)).toBe('expired 3 days ago');
  });

  it('singularises a one-day window either side of today', () => {
    const today = new Date('2026-08-28T12:00:00');
    expect(expiryText({ status: 'sent', validUntil: '2026-08-29' }, today)).toBe('expires in 1 day');
    expect(expiryText({ status: 'sent', validUntil: '2026-08-27' }, today)).toBe('expired 1 day ago');
  });

  it('ignores expiry on settled proposals and unparseable dates', () => {
    const today = new Date('2026-08-28T12:00:00');
    expect(expiryText({ status: 'accepted', validUntil: '2026-08-01' }, today)).toBeNull();
    expect(expiryText({ status: 'declined', validUntil: '2026-09-01' }, today)).toBeNull();
    expect(expiryText({ status: 'sent', validUntil: 'not-a-date' }, today)).toBeNull();
  });

  it('tones every status', () => {
    expect(STATUS_TONE).toEqual({ draft: 'slate', sent: 'blue', accepted: 'emerald', declined: 'red' });
  });
});
