// src/pages/mail/MailPage.tsx — the mail client shell: folder rail, thread
// list, and the reading pane. All of the page's state lives in the URL
// (`/mail/:accountId/:folderId/:threadKey` + `?q=` + `?compose=1`) so a thread
// can be linked to from anywhere in the app.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Mail, MailOpen } from 'lucide-react';
import { Button, EmptyState, Skeleton } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { mailApi } from '../../utils/mailApi';
import { MailComposer } from './compose/MailComposer';
import { FolderRail, orderFolders } from './FolderRail';
import type { ReplyMode } from './MessageCard';
import { SaveAttachmentsModal } from './SaveAttachmentsModal';
import { ThreadList } from './ThreadList';
import { useMailAccounts } from './useMailAccounts';
import { useMailFolders } from './useMailFolders';
import { useMailHeartbeat } from './useMailHeartbeat';
import { ThreadView } from './ThreadView';
import { NO_FOLDER, useThreadList } from './useThreadList';
import type { MessageRow, OpenedDraft, ThreadListRow } from './types';

// ── pane sizing ───────────────────────────────────────────────────────────
// The three-pane layout is a CSS grid, and the two draggable widths ride into
// it as custom properties rather than an inline `grid-template-columns`: the
// px values must apply at `lg` ONLY (below that the grid is one or two
// columns), and an inline template would win over the breakpoint. Bounds keep
// a mis-drag from collapsing a pane to nothing or eating the reading pane.
const RAIL = { key: 'mail.rail.w', min: 160, max: 320, initial: 208 };   // 13rem
const LIST = { key: 'mail.list.w', min: 240, max: 520, initial: 320 };   // 20rem

const clampW = (px: number, b: typeof RAIL): number => Math.min(b.max, Math.max(b.min, Math.round(px)));

// localStorage is unavailable in a locked-down browser (and throws rather than
// returning null), so a stored width is a nicety, never a requirement.
const readW = (b: typeof RAIL): number => {
  try {
    const raw = Number(localStorage.getItem(b.key));
    return Number.isFinite(raw) && raw > 0 ? clampW(raw, b) : b.initial;
  } catch {
    return b.initial;
  }
};
const writeW = (b: typeof RAIL, px: number): void => {
  try {
    localStorage.setItem(b.key, String(px));
  } catch {
    /* private mode / storage disabled — the width just doesn't persist */
  }
};

/** The data a reply/forward composer needs — everything but where it renders
 *  (modal vs. inline), which is tracked separately so promoting one to the
 *  other never re-seeds it (see `replyVariant` below). */
interface ReplyComposerState {
  mode: ReplyMode;
  message: MessageRow;
  bodyHtml: string;
}

export const MailPage: React.FC = () => {
  const { accountId = null, folderId = null, threadKey = null } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const navigate = useNavigate();
  const { toast } = useToast();

  const q = searchParams.get('q') ?? '';
  const { accounts, loading: accountsLoading } = useMailAccounts();
  const { folders, loading: foldersLoading } = useMailFolders(accountId);
  const list = useThreadList(accountId, folderId, q);
  const { reload: reloadList } = list;
  useMailHeartbeat(accountId);

  const ownAddresses = useMemo(() => accounts.map(a => a.emailAddress), [accounts]);
  const railFolders = useMemo(() => {
    const { roleFolders, labelFolders } = orderFolders(folders);
    return [...roleFolders, ...labelFolders];
  }, [folders]);
  // Search survives folder/thread navigation; ?compose=1 does not.
  const search = q ? `?q=${encodeURIComponent(q)}` : '';

  // Land on the default mailbox…
  useEffect(() => {
    if (accountsLoading || accountId || accounts.length === 0) return;
    const target = accounts.find(a => a.isDefault) ?? accounts[0];
    navigate(`/mail/${target.id}${search}`, { replace: true });
  }, [accountsLoading, accountId, accounts, navigate, search]);

  // …then on its inbox, or on the unfiltered view when it has no inbox folder.
  useEffect(() => {
    if (!accountId || folderId || foldersLoading) return;
    const inbox = folders.find(f => f.role === 'inbox');
    navigate(`/mail/${accountId}/${inbox?.id ?? NO_FOLDER}${search}`, { replace: true });
  }, [accountId, folderId, folders, foldersLoading, navigate, search]);

  // Task 5: "Save to Documents…" on a message's attachments — set by
  // ThreadView's onSaveAttachments, read by SaveAttachmentsModal below.
  const [saveAttachmentsMessage, setSaveAttachmentsMessage] = useState<MessageRow | null>(null);

  // Task 7: the reply/forward composer ThreadView renders inline under the
  // thread. `replyVariant` is separate from `replyComposer` itself so
  // "Open in composer" only swaps which surface the SAME MailComposer
  // instance renders as (Modal vs. the inline block) — switching a prop, not
  // remounting, is what keeps whatever the user has already typed.
  const [replyComposer, setReplyComposer] = useState<ReplyComposerState | null>(null);
  const [replyVariant, setReplyVariant] = useState<'modal' | 'inline'>('inline');
  // Piece 1 (reply-discard confirm): mirrors the reply composer's own dirty
  // state (see MailComposer's onDirtyChange / useDraftAutosave's `dirty`).
  // Kept separate from `replyComposer` itself so a re-render of the composer
  // (which happens on every keystroke) doesn't have to round-trip through
  // this component's state for anything but the flag actually being checked.
  const [replyDirty, setReplyDirty] = useState(false);

  // Defensive reset: navigating to a different account/thread (back/forward,
  // another thread click) must not leave the modal open against a message
  // from whatever thread was previously showing, nor a reply composer open
  // against a thread that is no longer on screen.
  useEffect(() => {
    setSaveAttachmentsMessage(null);
    setReplyComposer(null);
    setReplyVariant('inline');
    setReplyDirty(false);
  }, [accountId, threadKey]);

  // Piece 1: the one gate every intentional navigation-away call below runs
  // through first. `true` means "go ahead" — either there is nothing to lose,
  // or the user confirmed losing it. A plain window.confirm is what the spec
  // asks for; it also blocks synchronously, which a real "are you sure" needs
  // to before the caller's navigate() runs.
  const confirmDiscardReply = useCallback((): boolean => {
    if (!replyComposer || !replyDirty) return true;
    return window.confirm('Discard your unsent reply?');
  }, [replyComposer, replyDirty]);

  // Every navigate() below that leaves the current thread — a different
  // thread, a different folder, a different account — funnels through this
  // instead of calling navigate directly.
  const guardedNavigate = useCallback(
    (path: string) => {
      if (!confirmDiscardReply()) return;
      navigate(path);
    },
    [navigate, confirmDiscardReply],
  );

  const listPath = accountId ? `/mail/${accountId}/${folderId ?? NO_FOLDER}` : '/mail';

  // Spec §9: a draft reopened in the composer, keeping its provider draft id
  // so edits update that same draft and Send removes it.
  const [draftComposer, setDraftComposer] = useState<OpenedDraft | null>(null);
  const openDraft = useCallback(
    async (messageId: string): Promise<boolean> => {
      try {
        setDraftComposer(await mailApi.openDraft(messageId));
        return true;
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Could not open this draft.', { type: 'error' });
        return false;
      }
    },
    [toast],
  );
  const closeDraftComposer = useCallback(() => {
    setDraftComposer(null);
    reloadList();
  }, [reloadList]);

  const inDraftsFolder = useMemo(
    () => !!folderId && folders.some(f => f.id === folderId && f.role === 'drafts'),
    [folderId, folders],
  );

  const openThread = useCallback(
    async (row: ThreadListRow) => {
      // In Drafts, a row is something to finish writing: open its newest draft
      // in the composer. A thread with no draft left falls through to reading.
      if (inDraftsFolder && accountId) {
        try {
          const { messages } = await mailApi.thread(accountId, row.threadKey);
          const draft = [...messages].reverse().find(m => m.isDraft);
          if (draft && (await openDraft(draft.id))) return;
        } catch {
          /* fall through to the reader */
        }
      }
      guardedNavigate(`${listPath}/${encodeURIComponent(row.threadKey)}${search}`);
    },
    [inDraftsFolder, accountId, openDraft, guardedNavigate, listPath, search],
  );

  const toggleStar = useCallback(
    async (row: ThreadListRow) => {
      if (!accountId) return;
      try {
        await mailApi.threadActions(accountId, [row.threadKey], row.isStarred > 0 ? 'unstar' : 'star');
        reloadList();
      } catch {
        toast('Could not update the star.', { type: 'error' });
      }
    },
    [accountId, reloadList, toast],
  );

  const loadOlder = useCallback(async () => {
    if (!accountId) return;
    toast('Loading older mail…');
    try {
      await mailApi.loadOlder(accountId, 6);
      reloadList();
    } catch {
      toast('Could not load older mail.', { type: 'error' });
    }
  }, [accountId, reloadList, toast]);

  const setQuery = useCallback(
    (next: string) => {
      const params = new URLSearchParams(searchParams);
      if (next) params.set('q', next);
      else params.delete('q');
      setSearchParams(params, { replace: true });
    },
    [searchParams, setSearchParams],
  );

  // A blank composer's openness lives in the URL (not local state) so the
  // command palette — and the two Compose buttons below — can deep-link to
  // it. It's read directly off `searchParams` each render rather than mirrored
  // into state, so there is nothing to keep in sync.
  const composeOpen = searchParams.get('compose') === '1';
  const openCompose = useCallback(() => {
    const params = new URLSearchParams(searchParams);
    params.set('compose', '1');
    setSearchParams(params);
  }, [searchParams, setSearchParams]);
  const closeCompose = useCallback(() => {
    const params = new URLSearchParams(searchParams);
    params.delete('compose');
    setSearchParams(params, { replace: true });
  }, [searchParams, setSearchParams]);

  const backToList = useCallback(() => guardedNavigate(`${listPath}${search}`), [guardedNavigate, listPath, search]);

  // Drag-to-resize for the two divider handles. Pointer events on `window`
  // rather than the handle itself so a fast drag that outruns the 4px strip
  // keeps resizing instead of stopping dead.
  const [railW, setRailW] = useState(() => readW(RAIL));
  const [listW, setListW] = useState(() => readW(LIST));
  const [drag, setDrag] = useState<{ which: 'rail' | 'list'; startX: number; startW: number } | null>(null);
  // Read by the pointerup handler, which is created once per drag and would
  // otherwise close over the width as it was when the drag STARTED.
  const widthsRef = useRef({ rail: railW, list: listW });
  widthsRef.current = { rail: railW, list: listW };

  useEffect(() => {
    if (!drag) return;
    const onMove = (e: PointerEvent) => {
      const next = drag.startW + (e.clientX - drag.startX);
      if (drag.which === 'rail') setRailW(clampW(next, RAIL));
      else setListW(clampW(next, LIST));
    };
    const onUp = () => {
      const bounds = drag.which === 'rail' ? RAIL : LIST;
      writeW(bounds, drag.which === 'rail' ? widthsRef.current.rail : widthsRef.current.list);
      setDrag(null);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  }, [drag]);

  const startDrag = useCallback(
    (which: 'rail' | 'list') => (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDrag({ which, startX: e.clientX, startW: which === 'rail' ? widthsRef.current.rail : widthsRef.current.list });
    },
    [],
  );

  // Keyboard parity for the mouse drag: the handle is a real separator, so
  // arrows nudge it and the new width persists like a drag would.
  const nudge = useCallback(
    (which: 'rail' | 'list') => (e: React.KeyboardEvent<HTMLDivElement>) => {
      const step = e.key === 'ArrowLeft' ? -16 : e.key === 'ArrowRight' ? 16 : 0;
      if (!step) return;
      e.preventDefault();
      const bounds = which === 'rail' ? RAIL : LIST;
      const next = clampW((which === 'rail' ? widthsRef.current.rail : widthsRef.current.list) + step, bounds);
      if (which === 'rail') setRailW(next);
      else setListW(next);
      writeW(bounds, next);
    },
    [],
  );

  const handle = (which: 'rail' | 'list', label: string, value: number, bounds: typeof RAIL) => (
    <div
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation="vertical"
      aria-valuenow={value}
      aria-valuemin={bounds.min}
      aria-valuemax={bounds.max}
      data-testid={`mail-resize-${which}`}
      onPointerDown={startDrag(which)}
      onKeyDown={nudge(which)}
      className="absolute inset-y-0 right-0 z-10 hidden w-1 cursor-col-resize bg-transparent transition-colors hover:bg-accent-500/40 focus-visible:bg-accent-500/60 focus-visible:outline-none lg:block"
    />
  );

  // ThreadView's reply/reply-all/forward — from the toolbar (newest message)
  // or a specific message's own buttons — fetches that message's rendered
  // body, then opens the inline composer under the thread with it quoted.
  // A message whose provider copy is still being filed answers `{pending}`;
  // there is nothing to quote yet, so this stays put rather than opening a
  // composer with an empty quote.
  const onReply = useCallback(
    async (mode: ReplyMode, message: MessageRow) => {
      try {
        const res = await mailApi.body(message.id);
        if ('pending' in res) {
          toast('Message still syncing — try again shortly.');
          return;
        }
        setReplyComposer({ mode, message, bodyHtml: res.html });
        setReplyVariant('inline');
      } catch {
        toast('Could not load this message.', { type: 'error' });
      }
    },
    [toast],
  );
  const closeReplyComposer = useCallback(() => {
    setReplyComposer(null);
    setReplyVariant('inline');
    setReplyDirty(false);
  }, []);
  const promoteReplyComposer = useCallback(() => setReplyVariant('modal'), []);

  if (accountsLoading) {
    return (
      <div className="space-y-2 p-6">
        {[0, 1, 2, 3].map(i => <Skeleton key={i} className="h-10" />)}
      </div>
    );
  }

  if (accounts.length === 0) {
    return (
      <div className="flex min-h-[60vh] items-center justify-center p-6">
        <EmptyState
          icon={<Mail size={22} />}
          title="Connect a mail account"
          description="Link Google, Microsoft, or any IMAP mailbox to read and send mail from inside FrugalOmnibuild."
          action={<Button onClick={() => navigate('/settings?tab=mail')}>Open mail settings</Button>}
        />
      </div>
    );
  }

  return (
    <div className="flex h-[calc(100dvh-3.5rem)] flex-col bg-surface md:h-dvh">
      <div
        data-testid="mail-grid"
        style={{ ['--mail-rail-w' as string]: `${railW}px`, ['--mail-list-w' as string]: `${listW}px` }}
        className={`grid min-h-0 flex-1 grid-cols-1 md:grid-cols-[13rem_minmax(0,1fr)] lg:grid-cols-[var(--mail-rail-w)_var(--mail-list-w)_minmax(0,1fr)] ${
          drag ? 'cursor-col-resize select-none' : ''
        }`}
      >
        <aside className="relative hidden min-h-0 border-r border-edge md:block">
          <FolderRail
            accounts={accounts}
            accountId={accountId}
            folders={folders}
            folderId={folderId}
            onSelectAccount={id => guardedNavigate(`/mail/${id}`)}
            onSelectFolder={id => guardedNavigate(`/mail/${accountId}/${id}${search}`)}
            onCompose={openCompose}
          />
          {handle('rail', 'Resize the folder rail', railW, RAIL)}
        </aside>

        {/* List: the only pane on a phone until a thread is opened, and one of
            two on a tablet; at lg it sits permanently beside the reading pane. */}
        <section className={`relative min-h-0 flex-col border-edge lg:border-r ${threadKey ? 'hidden lg:flex' : 'flex'}`}>
          <div className="flex items-center gap-2 border-b border-edge px-3 py-2 md:hidden">
            <select
              aria-label="Folder"
              value={folderId ?? NO_FOLDER}
              onChange={e => guardedNavigate(`/mail/${accountId}/${e.target.value}${search}`)}
              className="min-w-0 flex-1 rounded-lg border border-edge bg-raised px-2 py-1.5 text-sm text-ink focus-visible:outline-none"
            >
              {railFolders.map(({ folder, label }) => (
                <option key={folder.id} value={folder.id}>
                  {label}
                  {folder.unreadCount > 0 ? ` (${folder.unreadCount})` : ''}
                </option>
              ))}
            </select>
            <Button size="sm" onClick={openCompose}>Compose</Button>
          </div>

          <div className="min-h-0 flex-1">
            <ThreadList
              accountId={accountId}
              threads={list.threads}
              loading={list.loading}
              hasMore={list.hasMore}
              onLoadMore={list.loadMore}
              indexedSince={list.indexedSince}
              onLoadOlder={loadOlder}
              q={q}
              onQueryChange={setQuery}
              selectedKey={threadKey}
              ownAddresses={ownAddresses}
              onOpen={openThread}
              onToggleStar={toggleStar}
              onReload={reloadList}
              onServerResults={list.showServerResults}
              serverResultCount={list.serverResultKeys?.length ?? null}
              onClearServerResults={list.clearServerResults}
            />
          </div>
          {handle('list', 'Resize the conversation list', listW, LIST)}
        </section>

        <section className={`min-h-0 flex-col ${threadKey ? 'flex' : 'hidden lg:flex'}`}>
          {threadKey ? (
            <>
              <div className="flex items-center gap-2 border-b border-edge px-3 py-2 lg:hidden">
                <Button variant="ghost" size="sm" onClick={backToList}>
                  <ArrowLeft size={14} />
                  <span>Back</span>
                </Button>
              </div>
              <div
                data-testid="mail-thread-slot"
                data-account-id={accountId ?? ''}
                data-thread-key={threadKey}
                className="min-h-0 flex-1"
              >
                {accountId && (
                  <ThreadView
                    key={`${accountId} ${threadKey}`}
                    accountId={accountId}
                    threadKey={threadKey}
                    ownAddresses={ownAddresses}
                    accounts={accounts}
                    onBack={backToList}
                    onReply={onReply}
                    onOpenInComposer={openCompose}
                    onSaveAttachments={message => setSaveAttachmentsMessage(message)}
                    onEditDraft={message => void openDraft(message.id)}
                    replyComposer={replyComposer}
                    replyVariant={replyVariant}
                    onReplyClose={closeReplyComposer}
                    onReplyDirtyChange={setReplyDirty}
                    onReplyPromote={promoteReplyComposer}
                    navigate={navigate}
                  />
                )}
              </div>
            </>
          ) : (
            <div className="flex h-full items-center justify-center p-8">
              <EmptyState
                icon={<MailOpen size={22} />}
                title="Select a conversation"
                description="Pick a thread from the list to read it here."
              />
            </div>
          )}
        </section>
      </div>

      {saveAttachmentsMessage && (
        <SaveAttachmentsModal
          open
          onClose={() => setSaveAttachmentsMessage(null)}
          messageId={saveAttachmentsMessage.id}
          attachments={saveAttachmentsMessage.attachments}
        />
      )}

      {composeOpen && (
        <MailComposer
          key="new"
          open
          variant="modal"
          onClose={closeCompose}
          accounts={accounts}
          defaultAccountId={accountId ?? undefined}
          mode="new"
          onSent={reloadList}
        />
      )}

      {draftComposer && (
        <MailComposer
          key={`draft:${draftComposer.messageId}`}
          open
          variant="modal"
          onClose={closeDraftComposer}
          accounts={accounts}
          defaultAccountId={draftComposer.accountId}
          mode="new"
          initial={{
            to: draftComposer.to,
            cc: draftComposer.cc,
            bcc: draftComposer.bcc,
            subject: draftComposer.subject,
            html: draftComposer.html,
            attachments: draftComposer.attachments.map(a => ({ kind: 'upload' as const, ...a })),
          }}
          resumeDraft={{ accountId: draftComposer.accountId, draftId: draftComposer.draftId, replyTo: draftComposer.replyTo }}
          onSent={reloadList}
        />
      )}
    </div>
  );
};
