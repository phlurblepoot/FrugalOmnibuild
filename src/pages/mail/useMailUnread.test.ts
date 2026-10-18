// src/pages/mail/useMailUnread.test.ts
// useMailUnread wraps mailApi.unreadCount() behind useLiveQuery. useLiveQuery
// itself needs a CollaborationProvider (socket context) we don't care about
// here, so it's mocked at the module level — same pattern as
// useGeneratedDocument.test.tsx.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';

const unreadCount = vi.fn();
vi.mock('../../utils/mailApi', () => ({
  mailApi: { unreadCount: (...args: unknown[]) => unreadCount(...args) },
}));

const useLiveQuery = vi.fn();
vi.mock('../../hooks/useLiveQuery', () => ({
  useLiveQuery: (...args: unknown[]) => useLiveQuery(...args),
}));

const { useMailUnread } = await import('./useMailUnread');

describe('useMailUnread', () => {
  beforeEach(() => {
    unreadCount.mockReset();
    useLiveQuery.mockReset();
    // Emulate useLiveQuery's initial-load behavior without needing a socket.
    useLiveQuery.mockImplementation((load: () => void) => { void load(); });
  });

  it('returns the total unread count on success', async () => {
    unreadCount.mockResolvedValue({ total: 7, byAccount: { acc1: 7 } });
    const { result } = renderHook(() => useMailUnread());
    await waitFor(() => expect(result.current).toBe(7));
  });

  it('returns 0 when the request fails (no accounts / old server)', async () => {
    unreadCount.mockRejectedValue(new Error('404'));
    const { result } = renderHook(() => useMailUnread());
    await waitFor(() => expect(result.current).toBe(0));
  });

  it('starts at 0 before the fetch resolves', () => {
    unreadCount.mockResolvedValue({ total: 3, byAccount: {} });
    const { result } = renderHook(() => useMailUnread());
    expect(result.current).toBe(0);
  });

  it('subscribes via useLiveQuery for mailThread/mailAccount changes, debounced 1s', () => {
    unreadCount.mockResolvedValue({ total: 0, byAccount: {} });
    renderHook(() => useMailUnread());
    expect(useLiveQuery).toHaveBeenCalledWith(
      expect.any(Function),
      { types: ['mailThread', 'mailAccount'] },
      { debounceMs: 1000 },
    );
  });
});
