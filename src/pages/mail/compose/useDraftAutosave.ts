// src/pages/mail/compose/useDraftAutosave.ts — keeps a composer draft on the
// server so a closed tab doesn't lose a half-written message.
//
// Design notes:
//  - The snapshot the hook is *mounted* with is never saved. Opening a reply
//    seeds recipients, a subject and a quote; treating that as a change would
//    litter the Drafts folder with a draft per opened reply.
//  - Saves are debounced and collapse: a burst of typing produces one write,
//    always of the latest state.
//  - The first successful save records a draft id and every later save updates
//    it in place, so the folder holds one row per composer, not one per pause.
import { useCallback, useEffect, useRef, useState } from 'react';
import { mailApi } from '../../../utils/mailApi';
import type { Addr } from '../types';

export const DRAFT_DEBOUNCE_MS = 3000;

/** Attachment as persisted on a draft: an app file or a staged upload. */
export type DraftAttachment = { fileId: string; name?: string } | { uploadId: string };

export interface DraftSnapshot {
  to: Addr[];
  cc: Addr[];
  bcc: Addr[];
  subject: string;
  html: string;
  attachments?: DraftAttachment[];
  /** The thread a reply draft answers; the server writes its threading headers from it. */
  replyTo?: { accountId: string; threadKey: string };
}

export type DraftStatus = 'idle' | 'saving' | 'saved' | 'error';

export interface DraftAutosaveOptions {
  accountId: string | null;
  enabled: boolean;
  /** Gates the `dirty` baseline ONLY — separate from `enabled`, which also
   *  pauses the autosave write mid-send (the server deletes the draft as
   *  part of a successful send, so a debounce firing during/after one would
   *  recreate it as a ghost). A composer session must stay "open" for dirty
   *  purposes across a send ATTEMPT, successful or not: a failed send keeps
   *  the composer open with the typed text intact, and `enabled` briefly
   *  goes false→true around it — without a separate gate here, that flip
   *  would re-baseline `dirty` to the still-unsent text and silently skip
   *  the discard-confirm on the next navigation. Defaults to `enabled` when
   *  omitted (callers that don't autosave — item sends — don't need dirty
   *  tracked separately either). */
  dirtyEnabled?: boolean;
  /** A draft reopened from the mailbox: saves in its account update it in
   *  place instead of creating a new one, and send/discard remove it. */
  initialDraft?: { accountId: string; draftId: string } | null;
  get: () => DraftSnapshot;
}

export interface DraftAutosaveState {
  draftId: string | null;
  status: DraftStatus;
  savedAt: Date | null;
  /** The snapshot has changed since the composer opened (and seeded) — i.e.
   *  there is something a navigation-away would discard. Gated on
   *  `dirtyEnabled` (defaulting to `enabled`) rather than `enabled` itself,
   *  so a failed send — which briefly disables autosave via `enabled` but
   *  must NOT look "clean" — does not clear it. */
  dirty: boolean;
  discard: () => Promise<void>;
}

export function useDraftAutosave({ accountId, enabled, dirtyEnabled, initialDraft, get }: DraftAutosaveOptions): DraftAutosaveState {
  const seedFor = (acct: string | null): string | null =>
    initialDraft && acct && initialDraft.accountId === acct ? initialDraft.draftId : null;
  const [draftId, setDraftId] = useState<string | null>(() => seedFor(accountId));
  const [status, setStatus] = useState<DraftStatus>('idle');
  const [savedAt, setSavedAt] = useState<Date | null>(null);

  // The snapshot is recomputed every render (the composer re-renders on every
  // keystroke); serialising it gives a cheap, stable change key for the effect.
  const snapshot = get();
  const serialized = JSON.stringify(snapshot);

  const latest = useRef(snapshot);
  latest.current = snapshot;

  const draftIdRef = useRef<string | null>(null);
  draftIdRef.current = draftId;

  // Baseline: whatever the composer opened with. Re-baselined whenever the
  // hook goes inactive so re-enabling it doesn't immediately save.
  const baseline = useRef<string | null>(null);
  const active = enabled && !!accountId;
  if (!active) baseline.current = null;
  else if (baseline.current === null) baseline.current = serialized;

  // `dirty` gets its OWN baseline, gated on `dirtyEnabled` rather than
  // `active` — see the option's doc comment. Kept as a separate ref so a
  // send attempt pausing the autosave-gate (`active` going false) never
  // touches this one.
  const dirtyBaseline = useRef<string | null>(null);
  const dirtyActive = (dirtyEnabled ?? enabled) && !!accountId;
  if (!dirtyActive) dirtyBaseline.current = null;
  else if (dirtyBaseline.current === null) dirtyBaseline.current = serialized;

  // Each composer session — and each mailbox within one — gets its own draft
  // row. Without this, closing a composer without sending and opening a new one
  // would autosave the new message on top of the old draft, and switching the
  // From account would PUT the previous account's draft id against the new one.
  // A session is keyed on `dirtyActive`, not `active`: a send attempt pauses
  // `active` but not the session, and a failed send must keep the draft id it
  // had (a reopened draft's id included) or the next save forks a second copy.
  // A reopened draft starts from its own id in its own account.
  useEffect(() => {
    if (!dirtyActive) return;
    const seed = seedFor(accountId);
    draftIdRef.current = seed;
    setDraftId(seed);
    setStatus('idle');
    setSavedAt(null);
  }, [dirtyActive, accountId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!active || !accountId) return;
    if (serialized === baseline.current) return;

    const t = setTimeout(() => {
      const body = { accountId, ...latest.current };
      setStatus('saving');
      mailApi.saveDraft(body, draftIdRef.current ?? undefined)
        .then(res => {
          if (res?.draftId) {
            draftIdRef.current = res.draftId;
            setDraftId(res.draftId);
          }
          setStatus('saved');
          setSavedAt(new Date());
        })
        // A failed autosave is not worth a toast — the user hasn't asked for
        // anything. The status line carries it, and the next edit retries.
        .catch(() => setStatus('error'));
    }, DRAFT_DEBOUNCE_MS);

    // Also the unmount path: a composer closed mid-debounce writes nothing.
    return () => clearTimeout(t);
  }, [serialized, active, accountId]);

  const discard = useCallback(async () => {
    const id = draftIdRef.current;
    draftIdRef.current = null;
    setDraftId(null);
    setStatus('idle');
    setSavedAt(null);
    if (!id || !accountId) return;
    try {
      await mailApi.deleteDraft(accountId, id);
    } catch {
      // The message it was backing has already been sent (or abandoned) — a
      // stray draft row is not worth interrupting the user for.
    }
  }, [accountId]);

  return { draftId, status, savedAt, dirty: dirtyActive && serialized !== dirtyBaseline.current, discard };
}
