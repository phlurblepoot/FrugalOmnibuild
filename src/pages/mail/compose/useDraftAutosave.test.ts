// src/pages/mail/compose/useDraftAutosave.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import type { Addr } from '../types';

const h = vi.hoisted(() => ({ saveDraft: vi.fn(), deleteDraft: vi.fn() }));
vi.mock('../../../utils/mailApi', () => ({ mailApi: { saveDraft: h.saveDraft, deleteDraft: h.deleteDraft } }));

import { DRAFT_DEBOUNCE_MS, useDraftAutosave, type DraftSnapshot } from './useDraftAutosave';

const snap = (over: Partial<DraftSnapshot> = {}): DraftSnapshot => ({
  to: [] as Addr[], cc: [], bcc: [], subject: '', html: '', ...over,
});

const setup = (initial: DraftSnapshot = snap(), opts: { accountId?: string | null; enabled?: boolean } = {}) =>
  renderHook(
    ({ s }: { s: DraftSnapshot }) =>
      useDraftAutosave({
        accountId: opts.accountId === undefined ? 'a1' : opts.accountId,
        enabled: opts.enabled ?? true,
        get: () => s,
      }),
    { initialProps: { s: initial } }
  );

const tick = async (ms = DRAFT_DEBOUNCE_MS) => {
  await act(async () => { vi.advanceTimersByTime(ms); });
  await act(async () => { await Promise.resolve(); });
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  h.saveDraft.mockResolvedValue({ draftId: 'd1' });
  h.deleteDraft.mockResolvedValue(undefined);
});
afterEach(() => vi.useRealTimers());

describe('useDraftAutosave', () => {
  it('does not save the snapshot it was mounted with', async () => {
    setup(snap({ subject: 'Seeded' }));
    await tick();
    expect(h.saveDraft).not.toHaveBeenCalled();
  });

  // Piece 1 (reply-discard confirm): `dirty` is what a nav guard checks
  // before firing window.confirm, so it has to flip in step with autosave's
  // own "changed since open" judgement — same baseline, same comparison.
  describe('dirty', () => {
    it('is false for the snapshot the hook opened with', async () => {
      const { result } = setup(snap({ subject: 'Seeded' }));
      await tick(0);
      expect(result.current.dirty).toBe(false);
    });

    it('flips true the moment the snapshot changes, before the debounce fires', () => {
      const { result, rerender } = setup();
      expect(result.current.dirty).toBe(false);
      rerender({ s: snap({ subject: 'Typed something' }) });
      expect(result.current.dirty).toBe(true);
      // Still true even though nothing has been saved to the server yet.
      expect(h.saveDraft).not.toHaveBeenCalled();
    });

    it('is false while disabled, regardless of the snapshot', () => {
      const { result } = setup(snap({ subject: 'Typed' }), { enabled: false });
      expect(result.current.dirty).toBe(false);
    });

    it('resets to false when the composer closes (disabled) and re-baselines on the next open', () => {
      const { result, rerender } = renderHook(
        ({ s, enabled }: { s: DraftSnapshot; enabled: boolean }) =>
          useDraftAutosave({ accountId: 'a1', enabled, get: () => s }),
        { initialProps: { s: snap(), enabled: true } },
      );

      rerender({ s: snap({ subject: 'Draft one' }), enabled: true });
      expect(result.current.dirty).toBe(true);

      // Closed: no longer tracked as dirty.
      rerender({ s: snap({ subject: 'Draft one' }), enabled: false });
      expect(result.current.dirty).toBe(false);

      // Reopened — the current snapshot is the new baseline, so it starts clean.
      rerender({ s: snap({ subject: 'Draft one' }), enabled: true });
      expect(result.current.dirty).toBe(false);
    });

    // Review finding 1 (fix round 1): a FAILED send toggles MailComposer's
    // `sending` state true→false, which is folded into `enabled` (pausing
    // autosave mid-send) but must NOT be folded into whatever gates `dirty`
    // — otherwise `enabled` briefly going false→true re-baselines `dirty` to
    // the still-unsent text and the discard-confirm goes silent on the next
    // nav. `dirtyEnabled` is the caller's escape hatch from that coupling.
    it('stays true across an enabled false->true toggle when dirtyEnabled never dropped (failed-send simulation)', () => {
      const { result, rerender } = renderHook(
        ({ s, enabled }: { s: DraftSnapshot; enabled: boolean }) =>
          useDraftAutosave({ accountId: 'a1', enabled, dirtyEnabled: true, get: () => s }),
        { initialProps: { s: snap(), enabled: true } },
      );

      rerender({ s: snap({ subject: 'Half-typed reply' }), enabled: true });
      expect(result.current.dirty).toBe(true);

      // The send attempt starts: MailComposer's `enabled` drops (sending=true)…
      rerender({ s: snap({ subject: 'Half-typed reply' }), enabled: false });
      // …and fails: `enabled` comes back (sending=false), composer stays open
      // with the SAME unsent text. dirtyEnabled never moved, so no re-baseline.
      rerender({ s: snap({ subject: 'Half-typed reply' }), enabled: true });
      expect(result.current.dirty).toBe(true);
    });

    it('without dirtyEnabled (falls back to enabled), the same toggle DOES lose dirty — documents the bug dirtyEnabled exists to avoid', () => {
      const { result, rerender } = renderHook(
        ({ s, enabled }: { s: DraftSnapshot; enabled: boolean }) =>
          useDraftAutosave({ accountId: 'a1', enabled, get: () => s }),
        { initialProps: { s: snap(), enabled: true } },
      );

      rerender({ s: snap({ subject: 'Half-typed reply' }), enabled: true });
      expect(result.current.dirty).toBe(true);

      rerender({ s: snap({ subject: 'Half-typed reply' }), enabled: false });
      rerender({ s: snap({ subject: 'Half-typed reply' }), enabled: true });
      expect(result.current.dirty).toBe(false);
    });
  });

  it('creates a draft 3s after the first change, then updates it in place', async () => {
    const { result, rerender } = setup();

    rerender({ s: snap({ subject: 'Hello' }) });
    await act(async () => { vi.advanceTimersByTime(DRAFT_DEBOUNCE_MS - 1); });
    expect(h.saveDraft).not.toHaveBeenCalled();

    await tick(1);
    expect(h.saveDraft).toHaveBeenCalledTimes(1);
    expect(h.saveDraft).toHaveBeenCalledWith(
      { accountId: 'a1', to: [], cc: [], bcc: [], subject: 'Hello', html: '' },
      undefined
    );
    expect(result.current.draftId).toBe('d1');
    expect(result.current.status).toBe('saved');
    expect(result.current.savedAt).toBeInstanceOf(Date);

    rerender({ s: snap({ subject: 'Hello again' }) });
    await tick();
    expect(h.saveDraft).toHaveBeenCalledTimes(2);
    expect(h.saveDraft.mock.calls[1][1]).toBe('d1');
  });

  it('collapses rapid edits into one save', async () => {
    const { rerender } = setup();
    rerender({ s: snap({ subject: 'a' }) });
    await act(async () => { vi.advanceTimersByTime(1000); });
    rerender({ s: snap({ subject: 'ab' }) });
    await act(async () => { vi.advanceTimersByTime(1000); });
    rerender({ s: snap({ subject: 'abc' }) });
    await tick();
    expect(h.saveDraft).toHaveBeenCalledTimes(1);
    expect(h.saveDraft.mock.calls[0][0].subject).toBe('abc');
  });

  it('reports an error status when the save fails', async () => {
    h.saveDraft.mockRejectedValue(new Error('nope'));
    const { result, rerender } = setup();
    rerender({ s: snap({ subject: 'Hello' }) });
    await tick();
    expect(result.current.status).toBe('error');
    expect(result.current.draftId).toBeNull();
  });

  it('stays idle when disabled or without an account', async () => {
    const off = setup(snap(), { enabled: false });
    off.rerender({ s: snap({ subject: 'x' }) });
    await tick();
    expect(h.saveDraft).not.toHaveBeenCalled();

    const anon = setup(snap(), { accountId: null });
    anon.rerender({ s: snap({ subject: 'x' }) });
    await tick();
    expect(h.saveDraft).not.toHaveBeenCalled();
  });

  it('does not fire a pending save after unmount', async () => {
    const { rerender, unmount } = setup();
    rerender({ s: snap({ subject: 'Hello' }) });
    unmount();
    await tick();
    expect(h.saveDraft).not.toHaveBeenCalled();
  });

  it('discard deletes the saved draft and resets', async () => {
    const { result, rerender } = setup();
    rerender({ s: snap({ subject: 'Hello' }) });
    await tick();
    expect(result.current.draftId).toBe('d1');

    await act(async () => { await result.current.discard(); });
    expect(h.deleteDraft).toHaveBeenCalledWith('a1', 'd1');
    expect(result.current.draftId).toBeNull();
    expect(result.current.status).toBe('idle');
  });

  it('starts a fresh draft when the composer is reopened', async () => {
    const { result, rerender } = renderHook(
      ({ s, enabled }: { s: DraftSnapshot; enabled: boolean }) =>
        useDraftAutosave({ accountId: 'a1', enabled, get: () => s }),
      { initialProps: { s: snap(), enabled: true } }
    );

    rerender({ s: snap({ subject: 'First' }), enabled: true });
    await tick();
    expect(result.current.draftId).toBe('d1');

    rerender({ s: snap(), enabled: false });          // composer closed
    rerender({ s: snap(), enabled: true });           // reopened
    expect(result.current.draftId).toBeNull();

    h.saveDraft.mockResolvedValue({ draftId: 'd2' });
    rerender({ s: snap({ subject: 'Second' }), enabled: true });
    await tick();
    expect(h.saveDraft.mock.calls.at(-1)![1]).toBeUndefined();
  });

  it('starts a fresh draft when the From account changes mid-compose', async () => {
    const { result, rerender } = renderHook(
      ({ s, accountId }: { s: DraftSnapshot; accountId: string }) =>
        useDraftAutosave({ accountId, enabled: true, get: () => s }),
      { initialProps: { s: snap(), accountId: 'a1' } }
    );

    rerender({ s: snap({ subject: 'First' }), accountId: 'a1' });
    await tick();
    expect(h.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'a1' }), undefined);
    expect(result.current.draftId).toBe('d1');

    h.saveDraft.mockResolvedValue({ draftId: 'd2' });
    rerender({ s: snap({ subject: 'First' }), accountId: 'a2' });
    expect(result.current.draftId).toBeNull();

    rerender({ s: snap({ subject: 'Second' }), accountId: 'a2' });
    await tick();
    // A create against the new mailbox, not a PUT of the old account's draft id.
    expect(h.saveDraft).toHaveBeenLastCalledWith(expect.objectContaining({ accountId: 'a2' }), undefined);
  });

  describe('a reopened draft', () => {
    const reopen = (accountId = 'a1') => renderHook(
      ({ s, enabled, acct }: { s: DraftSnapshot; enabled: boolean; acct: string }) =>
        useDraftAutosave({ accountId: acct, enabled, dirtyEnabled: true, initialDraft: { accountId: 'a1', draftId: 'prov-7' }, get: () => s }),
      { initialProps: { s: snap({ subject: 'Saved earlier' }), enabled: true, acct: accountId } },
    );

    it('starts from its provider id and updates that draft in place', async () => {
      h.saveDraft.mockResolvedValue({ draftId: 'prov-7' });
      const { result, rerender } = reopen();
      expect(result.current.draftId).toBe('prov-7');
      await tick();
      expect(h.saveDraft).not.toHaveBeenCalled();

      rerender({ s: snap({ subject: 'Edited' }), enabled: true, acct: 'a1' });
      await tick();
      expect(h.saveDraft).toHaveBeenCalledWith(expect.objectContaining({ subject: 'Edited' }), 'prov-7');
    });

    it('keeps its id through a send attempt that pauses autosave', async () => {
      const { result, rerender } = reopen();
      rerender({ s: snap({ subject: 'Edited' }), enabled: false, acct: 'a1' });   // sending…
      rerender({ s: snap({ subject: 'Edited' }), enabled: true, acct: 'a1' });    // …failed
      expect(result.current.draftId).toBe('prov-7');
    });

    it('does not carry its id into another mailbox', async () => {
      const { result, rerender } = reopen();
      rerender({ s: snap({ subject: 'Saved earlier' }), enabled: true, acct: 'a2' });
      expect(result.current.draftId).toBeNull();
    });

    it('discard deletes it', async () => {
      const { result } = reopen();
      await act(async () => { await result.current.discard(); });
      expect(h.deleteDraft).toHaveBeenCalledWith('a1', 'prov-7');
    });
  });

  it('discard is a no-op with nothing saved', async () => {
    const { result } = setup();
    await act(async () => { await result.current.discard(); });
    expect(h.deleteDraft).not.toHaveBeenCalled();
  });
});
