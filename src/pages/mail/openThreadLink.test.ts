// src/pages/mail/openThreadLink.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ resolveThread: vi.fn() }));
vi.mock('../../utils/mailApi', () => ({ mailApi: { resolveThread: h.resolveThread } }));

import { openThreadLink, resolveThreadMatch, parseLinkParticipants } from './openThreadLink';
import type { ThreadLink } from './types';

const link = (over: Partial<ThreadLink> = {}): ThreadLink => ({
  id: 'l1', threadKey: 'tk 1', subjectSnapshot: 'Invoice 12 — Dunmore Heights',
  firstDate: '2026-08-27T12:00:00.000Z', participantsJson: null, itemType: 'invoice', itemId: 'inv-1',
  projectId: 'p1', customerId: null, linkedByUserId: 'u1', createdAt: '2026-08-27T12:00:00.000Z',
  ...over,
});

beforeEach(() => { h.resolveThread.mockReset(); });

describe('parseLinkParticipants', () => {
  it('parses a JSON array snapshot', () => {
    expect(parseLinkParticipants(JSON.stringify([{ addr: 'gc@tidewater.example', name: 'GC' }])))
      .toEqual([{ addr: 'gc@tidewater.example', name: 'GC' }]);
  });

  it('defaults to empty for null, malformed, or non-array JSON', () => {
    expect(parseLinkParticipants(null)).toEqual([]);
    expect(parseLinkParticipants(undefined)).toEqual([]);
    expect(parseLinkParticipants('not json')).toEqual([]);
    expect(parseLinkParticipants('{"addr":"x"}')).toEqual([]);
  });
});

describe('resolveThreadMatch', () => {
  it('sends the link snapshot as the resolve-thread query, joining participants', async () => {
    h.resolveThread.mockResolvedValue({ match: { accountId: 'a1', threadKey: 'tk 1' } });
    const l = link({ participantsJson: JSON.stringify([{ addr: 'gc@tidewater.example' }, { addr: ' me@birchwood.example ' }]) });
    const match = await resolveThreadMatch(l);
    expect(match).toEqual({ accountId: 'a1', threadKey: 'tk 1' });
    expect(h.resolveThread).toHaveBeenCalledWith({
      threadKey: 'tk 1', subject: 'Invoice 12 — Dunmore Heights',
      firstDate: '2026-08-27T12:00:00.000Z', participants: 'gc@tidewater.example,me@birchwood.example',
    });
  });

  it('sends empty strings for a null subject/firstDate rather than the literal "null"', async () => {
    h.resolveThread.mockResolvedValue({ match: null });
    await resolveThreadMatch(link({ subjectSnapshot: null, firstDate: null }));
    expect(h.resolveThread).toHaveBeenCalledWith(
      expect.objectContaining({ subject: '', firstDate: '' }),
    );
  });

  it('returns null on no match', async () => {
    h.resolveThread.mockResolvedValue({ match: null });
    await expect(resolveThreadMatch(link())).resolves.toBeNull();
  });

  it('propagates a genuine request failure rather than swallowing it as "no match"', async () => {
    h.resolveThread.mockRejectedValue(new Error('offline'));
    await expect(resolveThreadMatch(link())).rejects.toThrow('offline');
  });
});

describe('openThreadLink', () => {
  it('navigates to the matched thread and reports "opened"', async () => {
    h.resolveThread.mockResolvedValue({ match: { accountId: 'a1', threadKey: 'tk 1' } });
    const navigate = vi.fn();
    const result = await openThreadLink(link(), navigate);
    expect(result).toBe('opened');
    // The threadKey is opaque server text (not path-safe), and `_` is
    // MailPage's "any folder" segment (useThreadList.NO_FOLDER).
    expect(navigate).toHaveBeenCalledWith('/mail/a1/_/tk%201');
  });

  it('does not navigate and reports "card" when nothing matches', async () => {
    h.resolveThread.mockResolvedValue({ match: null });
    const navigate = vi.fn();
    const result = await openThreadLink(link(), navigate);
    expect(result).toBe('card');
    expect(navigate).not.toHaveBeenCalled();
  });
});
