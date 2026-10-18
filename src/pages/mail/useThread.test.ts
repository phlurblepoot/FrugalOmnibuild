// src/pages/mail/useThread.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { MessageRow, ThreadLink, ThreadListRow } from './types';

const { thread } = vi.hoisted(() => ({ thread: vi.fn() }));
vi.mock('../../utils/mailApi', () => ({ mailApi: { thread } }));

// A fake socket (on/off/fire), same pattern as TaskEditor.test.tsx /
// useLiveQuery.test.tsx, so live 'mailThread' events can be simulated.
const { fakeSocket } = vi.hoisted(() => {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  const fakeSocket = {
    handlers,
    on: vi.fn((e: string, cb: any) => { (handlers[e] ??= []).push(cb); return fakeSocket; }),
    off: vi.fn((e: string, cb: any) => { handlers[e] = (handlers[e] ?? []).filter(h => h !== cb); return fakeSocket; }),
    fire: (e: string, ...a: any[]) => (handlers[e] ?? []).forEach(cb => cb(...a)),
  };
  return { fakeSocket };
});
vi.mock('../../context/CollaborationContext', () => ({ useCollaboration: () => ({ socket: fakeSocket }) }));

import { useThread } from './useThread';

const threadRow = (key: string): ThreadListRow => ({
  threadKey: key, subject: `Subject ${key}`, firstDate: '2026-08-27T12:00:00.000Z',
  lastDate: '2026-08-27T13:00:00.000Z', messageCount: 1, unreadCount: 0, hasAttachments: 0, isStarred: 0,
  participants: [], folderIds: ['f-inbox'], snippet: '', links: [],
});

const message = (id: string, key: string): MessageRow => ({
  id, accountId: 'a1', threadKey: key, messageIdHeader: null, inReplyTo: null, references: [],
  from: { addr: 'bob@acme.com' }, to: [], cc: [], bcc: [], subject: 'S', snippet: '',
  date: '2026-08-27T12:00:00.000Z', isRead: true, isStarred: false, isDraft: false, hasAttachments: false,
  attachments: [], sizeBytes: 1, folderIds: ['f-inbox'], sentFromApp: false,
});

const link: ThreadLink = {
  id: 'l1', threadKey: 'tk-1', subjectSnapshot: null, firstDate: null, participantsJson: null,
  itemType: 'rfi', itemId: 'r1', projectId: null, customerId: null, linkedByUserId: 'u1',
  createdAt: '2026-08-27T12:00:00.000Z',
};

const payload = (key: string) => ({ thread: threadRow(key), messages: [message(`m-${key}`, key)], links: [link] });

beforeEach(() => {
  vi.clearAllMocks();
  thread.mockImplementation((_a: string, key: string) => Promise.resolve(payload(key)));
  for (const k of Object.keys(fakeSocket.handlers)) delete fakeSocket.handlers[k];
});

describe('useThread', () => {
  it('loads the conversation for the account and thread key', async () => {
    const { result } = renderHook(() => useThread('a1', 'tk-1'));
    await waitFor(() => expect(result.current.thread).not.toBeNull());
    expect(thread).toHaveBeenCalledWith('a1', 'tk-1');
    expect(result.current.messages.map(m => m.id)).toEqual(['m-tk-1']);
    expect(result.current.links).toHaveLength(1);
    expect(result.current.loading).toBe(false);
    expect(result.current.error).toBeNull();
  });

  it('fetches nothing without an account or a thread key', async () => {
    const { result } = renderHook(() => useThread('a1', null));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(thread).not.toHaveBeenCalled();
    expect(result.current.thread).toBeNull();
    expect(result.current.messages).toEqual([]);
  });

  it('never hands back the previous thread while the next one is in flight', async () => {
    let release: (v: unknown) => void = () => {};
    const { result, rerender } = renderHook(({ k }: { k: string }) => useThread('a1', k), {
      initialProps: { k: 'tk-1' },
    });
    await waitFor(() => expect(result.current.thread?.threadKey).toBe('tk-1'));

    thread.mockReturnValueOnce(new Promise(r => { release = r; }));
    rerender({ k: 'tk-2' });
    // The old conversation is gone the moment the URL moves, not when the new
    // one arrives — otherwise tk-1's messages sit under tk-2's subject.
    expect(result.current.thread).toBeNull();
    expect(result.current.messages).toEqual([]);
    expect(result.current.loading).toBe(true);

    release(payload('tk-2'));
    await waitFor(() => expect(result.current.thread?.threadKey).toBe('tk-2'));
    expect(result.current.messages.map(m => m.id)).toEqual(['m-tk-2']);
  });

  it('surfaces a failed load and stops reporting itself as loading', async () => {
    thread.mockRejectedValue(new Error('Thread not found'));
    const { result } = renderHook(() => useThread('a1', 'tk-1'));
    await waitFor(() => expect(result.current.error).toBe('Thread not found'));
    expect(result.current.loading).toBe(false);
    expect(result.current.thread).toBeNull();
  });

  it('drops the previous thread failure when the reader moves on', async () => {
    thread.mockRejectedValueOnce(new Error('Thread not found'));
    const { result, rerender } = renderHook(({ k }: { k: string }) => useThread('a1', k), {
      initialProps: { k: 'tk-1' },
    });
    await waitFor(() => expect(result.current.error).toBe('Thread not found'));

    rerender({ k: 'tk-2' });
    await waitFor(() => expect(result.current.thread?.threadKey).toBe('tk-2'));
    expect(result.current.error).toBeNull();
  });

  it('refetches on demand', async () => {
    const { result } = renderHook(() => useThread('a1', 'tk-1'));
    await waitFor(() => expect(result.current.thread).not.toBeNull());
    result.current.reload();
    await waitFor(() => expect(thread).toHaveBeenCalledTimes(2));
  });

  // Regression: useLiveQuery's own "reload when the filter identity changes"
  // effect and useThread's "load when accountId/threadKey changes" effect
  // used to both fire on a thread switch — one API call became two.
  it('fetches exactly once per thread switch, not twice', async () => {
    const { result, rerender } = renderHook(({ k }: { k: string }) => useThread('a1', k), {
      initialProps: { k: 'tk-1' },
    });
    await waitFor(() => expect(result.current.thread?.threadKey).toBe('tk-1'));
    expect(thread).toHaveBeenCalledTimes(1);

    rerender({ k: 'tk-2' });
    await waitFor(() => expect(result.current.thread?.threadKey).toBe('tk-2'));
    expect(thread).toHaveBeenCalledTimes(2);
  });

  it('still reloads on a live mailThread event for the open thread', async () => {
    const { result } = renderHook(() => useThread('a1', 'tk-1'));
    await waitFor(() => expect(result.current.thread).not.toBeNull());
    expect(thread).toHaveBeenCalledTimes(1);

    fakeSocket.fire('entity-changed', { type: 'mailThread', id: 'tk-1', action: 'updated' });
    // useLiveQuery debounces live reloads by 500ms (useThread's debounceMs).
    await waitFor(() => expect(thread).toHaveBeenCalledTimes(2), { timeout: 2000 });
  });
});
