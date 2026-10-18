// src/hooks/useItemThreadLinks.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import type { ThreadLink } from '../pages/mail/types';

const h = vi.hoisted(() => ({ links: vi.fn(), resolveThread: vi.fn() }));
vi.mock('../utils/mailApi', () => ({ mailApi: { links: h.links, resolveThread: h.resolveThread } }));

import { useItemThreadLinks } from './useItemThreadLinks';

const link = (over: Partial<ThreadLink> = {}): ThreadLink => ({
  id: 'l1', threadKey: 'tk-1', subjectSnapshot: 'RFI RFI-004', firstDate: '2026-08-27T12:00:00.000Z',
  participantsJson: null, itemType: 'rfi', itemId: 'r1', projectId: 'p1', customerId: null,
  linkedByUserId: 'u1', createdAt: '2026-08-27T12:00:00.000Z',
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.links.mockResolvedValue([]);
  h.resolveThread.mockResolvedValue({ match: null });
});

describe('useItemThreadLinks', () => {
  it('asks for nothing without an item id', async () => {
    const { result } = renderHook(() => useItemThreadLinks('rfi', undefined));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(h.links).not.toHaveBeenCalled();
    expect(result.current.links).toEqual([]);
    expect(result.current.newest).toBeNull();
  });

  it('loads the links and exposes the newest first', async () => {
    h.links.mockResolvedValue([
      link({ id: 'old', threadKey: 'tk-old', firstDate: '2026-08-01T00:00:00.000Z' }),
      link({ id: 'new', threadKey: 'tk-new', firstDate: '2026-08-27T00:00:00.000Z' }),
    ]);
    const { result } = renderHook(() => useItemThreadLinks('rfi', 'r1'));
    await waitFor(() => expect(result.current.links).toHaveLength(2));
    expect(h.links).toHaveBeenCalledWith('rfi', 'r1');
    expect(result.current.newest?.id).toBe('new');
  });

  // myThread now comes from ONE resolve-thread call — the server itself
  // decides which (if any) of this user's mailboxes the thread is in,
  // exact-match or via its subject+date+participant fallback.
  it('resolves myThread from the server match', async () => {
    h.links.mockResolvedValue([link()]);
    h.resolveThread.mockResolvedValue({ match: { accountId: 'a2', threadKey: 'tk-1' } });

    const { result } = renderHook(() => useItemThreadLinks('rfi', 'r1'));
    await waitFor(() => expect(result.current.myThread).not.toBeNull());
    expect(result.current.myThread).toEqual({ accountId: 'a2', threadKey: 'tk-1', subject: 'RFI RFI-004' });
    expect(h.resolveThread).toHaveBeenCalledWith({
      threadKey: 'tk-1', subject: 'RFI RFI-004', firstDate: '2026-08-27T12:00:00.000Z', participants: '',
    });
  });

  it('leaves myThread null when the server finds no match', async () => {
    h.links.mockResolvedValue([link()]);
    const { result } = renderHook(() => useItemThreadLinks('rfi', 'r1'));
    // `resolving` alone would be a race, since it is false until the links
    // themselves have landed.
    await waitFor(() => expect(h.resolveThread).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.resolving).toBe(false));
    expect(result.current.myThread).toBeNull();
  });

  // A network blip must not get remembered as "not yours" forever — a fresh
  // mount (or reload()) always asks again, since there is no longer a
  // module-level cache to poison.
  it('does not permanently hide a thread after a failed resolve', async () => {
    h.links.mockResolvedValue([link()]);
    h.resolveThread.mockRejectedValue(new Error('offline'));
    const first = renderHook(() => useItemThreadLinks('rfi', 'r1'));
    await waitFor(() => expect(h.resolveThread).toHaveBeenCalledTimes(1));
    expect(first.result.current.myThread).toBeNull();
    first.unmount();

    h.resolveThread.mockResolvedValue({ match: { accountId: 'a1', threadKey: 'tk-1' } });
    const second = renderHook(() => useItemThreadLinks('rfi', 'r1'));
    await waitFor(() => expect(second.result.current.myThread?.accountId).toBe('a1'));
  });

  // The chip reads `resolving` to decide whether it may say anything final.
  // It has to be true from the moment a link exists until the resolve call
  // answers — a flag an effect sets is one frame too late.
  it('reports resolving from the moment a link is known until resolve-thread answers', async () => {
    let release: (v: unknown) => void = () => {};
    h.links.mockResolvedValue([link()]);
    h.resolveThread.mockImplementation(() => new Promise(resolve => { release = resolve; }));

    const { result } = renderHook(() => useItemThreadLinks('rfi', 'r1'));
    await waitFor(() => expect(result.current.newest).not.toBeNull());
    expect(result.current.resolving).toBe(true);
    expect(result.current.myThread).toBeNull();

    await act(async () => { release({ match: null }); });
    await waitFor(() => expect(result.current.resolving).toBe(false));
    expect(result.current.myThread).toBeNull();
  });

  // reload() runs after a send, when the link the chip should show has just
  // been created — a stale "no match" from before the send must not stick.
  it('reload re-reads the links and re-resolves', async () => {
    const { result } = renderHook(() => useItemThreadLinks('rfi', 'r1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.links).toEqual([]);

    h.links.mockResolvedValue([link()]);
    h.resolveThread.mockResolvedValue({ match: { accountId: 'a1', threadKey: 'tk-1' } });
    act(() => { result.current.reload(); });

    await waitFor(() => expect(result.current.myThread?.threadKey).toBe('tk-1'));
    expect(h.links).toHaveBeenCalledTimes(2);
  });

  it('survives a links request that fails', async () => {
    h.links.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useItemThreadLinks('rfi', 'r1'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.links).toEqual([]);
    expect(result.current.myThread).toBeNull();
  });

  it('joins the participant snapshot into the resolve-thread query', async () => {
    h.links.mockResolvedValue([link({ participantsJson: JSON.stringify([{ addr: 'gc@tidewater.example' }, { addr: 'me@birchwood.example' }]) })]);
    renderHook(() => useItemThreadLinks('rfi', 'r1'));
    await waitFor(() => expect(h.resolveThread).toHaveBeenCalledWith(
      expect.objectContaining({ participants: 'gc@tidewater.example,me@birchwood.example' }),
    ));
  });
});
