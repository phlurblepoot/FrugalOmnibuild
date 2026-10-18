// src/pages/mail/ThreadView.tsx — the reading pane: action toolbar, the strip
// of app items the thread is linked to, the subject, and the message cards
// (everything collapsed except the newest message and anything still unread).
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, FolderInput, Forward, Link2, Mail, MoreHorizontal,
  PenSquare, Reply, ReplyAll, Star, Trash2, X,
} from 'lucide-react';
import { Skeleton } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { mailApi } from '../../utils/mailApi';
import { MailComposer } from './compose/MailComposer';
import { CreateFromThreadMenu } from './CreateFromThreadMenu';
import { orderFolders } from './FolderRail';
import { LinkPickerModal } from './LinkPickerModal';
import { MessageCard, type ReplyMode } from './MessageCard';
import { itemTypeLabel } from './mailFormat';
import { useMailFolders } from './useMailFolders';
import { useThread } from './useThread';
import type { MailAccount, MailAction, MessageRow } from './types';

// Same "read the app's own logged-in user" convention as TaskListPanel /
// ProjectBilling / ProjectView etc. — there is no useAuth hook in this app,
// just the user blob Login.tsx wrote to localStorage.
const currentUser = (): { id?: string; role?: string } => {
  try { return JSON.parse(localStorage.getItem('user') || '{}'); } catch { return {}; }
};

/** How long a message stays open before it counts as read (spec: 1 s). */
const MARK_READ_DELAY = 1000;

const TOOL =
  'inline-flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-ink-soft transition-colors ' +
  'hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none ' +
  'focus-visible:ring-2 focus-visible:ring-accent-500/40';

const MENU_ITEM =
  'flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm text-ink transition-colors hover:bg-hover';

/** Newest message first is what a reply/forward acts on. */
const newest = (messages: MessageRow[]): MessageRow | null => messages[messages.length - 1] ?? null;

const defaultExpanded = (messages: MessageRow[]): Set<string> => {
  const open = new Set<string>();
  const last = newest(messages);
  if (last) open.add(last.id);
  for (const m of messages) if (!m.isRead) open.add(m.id);
  return open;
};

export const ThreadView: React.FC<{
  accountId: string;
  threadKey: string;
  ownAddresses: string[];
  accounts: MailAccount[];
  onBack?: () => void;
  onReply: (mode: ReplyMode, message: MessageRow) => void;
  onOpenInComposer: () => void;
  /** Task 5 mounts the Save-to-Documents modal on this. */
  onSaveAttachments?: (message: MessageRow) => void;
  /** Reopens a draft in this thread in the composer (spec §9). */
  onEditDraft?: (message: MessageRow) => void;
  /** Task 7: the reply/forward composer MailPage owns, rendered below the
   *  messages so it reads as part of the conversation. `null` when no
   *  reply is in progress for this thread. */
  replyComposer: { mode: ReplyMode; message: MessageRow; bodyHtml: string } | null;
  replyVariant: 'modal' | 'inline';
  onReplyClose: () => void;
  /** Piece 1 (reply-discard confirm): mirrors the reply composer's own
   *  "has anything been typed since it opened" state up to MailPage, which
   *  checks it before navigating away from this thread. */
  onReplyDirtyChange?: (dirty: boolean) => void;
  /** "Open in composer" on the inline composer itself — promotes it to the
   *  modal without losing anything typed (MailPage only flips `replyVariant`,
   *  it does not remount the composer). */
  onReplyPromote: () => void;
  /** Task 3: CreateFromThreadMenu's "Create ▾" navigates through this after
   *  converting the thread — MailPage owns the router (see useNavigate there)
   *  so ThreadView takes it as a prop rather than calling useNavigate itself,
   *  keeping this component testable without a Router wrapper. */
  navigate: (path: string) => void;
}> = ({
  accountId, threadKey, ownAddresses, accounts, onBack, onReply, onOpenInComposer, onSaveAttachments, onEditDraft,
  replyComposer, replyVariant, onReplyClose, onReplyDirtyChange, onReplyPromote, navigate,
}) => {
  const { toast } = useToast();
  const { thread, messages, links, loading, error, reload } = useThread(accountId, threadKey);
  const { folders } = useMailFolders(accountId);

  const [busy, setBusy] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [moveOpen, setMoveOpen] = useState(false);
  const [linkModalOpen, setLinkModalOpen] = useState(false);
  // The link id currently being unlinked (disables just that chip's × while
  // its DELETE is in flight — a busy state shared across chips would freeze
  // every other one for no reason).
  const [unlinkingId, setUnlinkingId] = useState<string | null>(null);
  // `null` = "nobody has clicked yet", so the default (newest + unread) applies.
  const [expandedIds, setExpandedIds] = useState<Set<string> | null>(null);
  // Optimistic read flags: the card's unread styling must go the moment it is
  // opened, well before the 1 s mark-read call and the live event that follows.
  const [locallyRead, setLocallyRead] = useState<Set<string>>(() => new Set());

  const scheduledRef = useRef<Set<string>>(new Set());
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const key = `${accountId} ${threadKey}`;

  // A different conversation starts from a clean slate.
  useEffect(() => {
    setExpandedIds(null);
    setLocallyRead(new Set());
    setMenuOpen(false);
    setMoveOpen(false);
    scheduledRef.current = new Set();
  }, [key]);

  useEffect(() => () => timersRef.current.forEach(clearTimeout), []);

  // Escape closes whichever popover is open (the click-catcher behind them
  // handles the pointer case).
  useEffect(() => {
    if (!menuOpen && !moveOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      setMenuOpen(false);
      setMoveOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen, moveOpen]);

  const expanded = useMemo(() => expandedIds ?? defaultExpanded(messages), [expandedIds, messages]);

  // Mark every open, unread message read once — scheduledRef keeps a live
  // refresh (or a re-render) from firing the same call twice, and the timer is
  // deliberately NOT cancelled by that refresh, only by unmount.
  useEffect(() => {
    const ids = messages.filter(m => !m.isRead && expanded.has(m.id) && !scheduledRef.current.has(m.id)).map(m => m.id);
    if (ids.length === 0) return;
    for (const id of ids) scheduledRef.current.add(id);
    setLocallyRead(prev => {
      const next = new Set(prev);
      for (const id of ids) next.add(id);
      return next;
    });
    timersRef.current.push(
      setTimeout(() => {
        // The optimistic flip already happened, so a failure here only means
        // the server still thinks these are unread — worth a line in the
        // console, not a toast over a message the reader is busy reading.
        mailApi.messageActions(ids, 'read').catch(e => console.warn('[mail] mark-read failed', e));
      }, MARK_READ_DELAY),
    );
  }, [messages, expanded]);

  const toggle = useCallback(
    (id: string) => {
      setExpandedIds(prev => {
        const next = new Set(prev ?? defaultExpanded(messages));
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
    },
    [messages],
  );

  const run = useCallback(
    async (action: MailAction, opts: { folderId?: string; back?: boolean; failure: string }) => {
      if (busy) return;
      setBusy(true);
      setMenuOpen(false);
      setMoveOpen(false);
      try {
        // Move is the only action with a destination (archive/trash resolve
        // their own role folder server-side), so the argument is left off
        // entirely rather than sent as an undefined the request would carry.
        if (opts.folderId) await mailApi.threadActions(accountId, [threadKey], action, opts.folderId);
        else await mailApi.threadActions(accountId, [threadKey], action);
        if (opts.back) onBack?.();
      } catch {
        toast(opts.failure, { type: 'error' });
      } finally {
        setBusy(false);
      }
    },
    [accountId, threadKey, busy, onBack, toast],
  );

  const last = newest(messages);
  const reply = useCallback(
    (mode: ReplyMode) => {
      if (last) onReply(mode, last);
    },
    [last, onReply],
  );

  const unlink = useCallback(
    async (linkId: string) => {
      if (unlinkingId) return;
      setUnlinkingId(linkId);
      try {
        await mailApi.deleteLink(linkId);
        reload();
      } catch {
        toast('Could not remove that link.', { type: 'error' });
      } finally {
        setUnlinkingId(null);
      }
    },
    [unlinkingId, reload, toast],
  );

  const starred = (thread?.isStarred ?? 0) > 0;
  const railFolders = useMemo(() => {
    const { roleFolders, labelFolders } = orderFolders(folders);
    return [...roleFolders, ...labelFolders];
  }, [folders]);

  const view = useMemo(
    () => messages.map(m => (locallyRead.has(m.id) && !m.isRead ? { ...m, isRead: true } : m)),
    [messages, locallyRead],
  );

  if (loading) {
    return (
      <div data-testid="mail-thread-loading" className="space-y-3 p-4">
        <Skeleton className="h-8 w-1/2" />
        <Skeleton className="h-24" />
        <Skeleton className="h-40" />
      </div>
    );
  }

  if (error || !thread) {
    return (
      <div className="p-6 text-sm text-ink-faint">{error ?? 'This conversation is no longer available.'}</div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="relative flex flex-wrap items-center gap-1 border-b border-edge px-2 py-1.5">
        <button type="button" className={TOOL} disabled={!last} onClick={() => reply('reply')} aria-label="Reply">
          <Reply size={15} />
          <span>Reply</span>
        </button>

        <CreateFromThreadMenu
          threadKey={threadKey}
          subject={thread.subject}
          snippet={thread.snippet}
          messages={messages}
          ownAddresses={ownAddresses}
          links={links}
          navigate={navigate}
        />

        {/* Everything below the fold on a phone lives in the ⋯ menu instead. */}
        <div className="hidden items-center gap-1 sm:flex">
          <button type="button" className={TOOL} disabled={!last} onClick={() => reply('replyAll')} aria-label="Reply all">
            <ReplyAll size={15} />
            <span>Reply all</span>
          </button>
          <button type="button" className={TOOL} disabled={!last} onClick={() => reply('forward')} aria-label="Forward">
            <Forward size={15} />
            <span>Forward</span>
          </button>

          <span className="mx-1 h-4 w-px bg-edge" aria-hidden="true" />

          <button
            type="button"
            className={TOOL}
            disabled={busy}
            aria-label="Archive"
            onClick={() => run('archive', { back: true, failure: 'Could not archive this conversation.' })}
          >
            <Archive size={15} />
            <span>Archive</span>
          </button>
          <button
            type="button"
            className={TOOL}
            aria-label="Move"
            aria-expanded={moveOpen}
            onClick={() => {
              setMenuOpen(false);
              setMoveOpen(o => !o);
            }}
          >
            <FolderInput size={15} />
            <span>Move</span>
          </button>
          <button
            type="button"
            className={TOOL}
            disabled={busy}
            aria-label="Trash"
            onClick={() => run('trash', { back: true, failure: 'Could not delete this conversation.' })}
          >
            <Trash2 size={15} />
            <span>Trash</span>
          </button>
          <button
            type="button"
            className={TOOL}
            disabled={busy}
            aria-label={starred ? 'Unstar' : 'Star'}
            onClick={() => run(starred ? 'unstar' : 'star', { failure: 'Could not update the star.' })}
          >
            <Star size={15} className={starred ? 'fill-amber-400 text-amber-500' : ''} />
            <span>{starred ? 'Unstar' : 'Star'}</span>
          </button>
          <button
            type="button"
            className={TOOL}
            disabled={busy}
            aria-label="Mark unread"
            onClick={() => run('unread', { back: true, failure: 'Could not mark this conversation unread.' })}
          >
            <Mail size={15} />
            <span>Mark unread</span>
          </button>
        </div>

        <div className="relative ml-auto">
          <button
            type="button"
            className={TOOL}
            aria-label="More actions"
            aria-expanded={menuOpen}
            onClick={() => {
              setMoveOpen(false);
              setMenuOpen(o => !o);
            }}
          >
            <MoreHorizontal size={16} />
          </button>

          {menuOpen && (
            <>
              <div className="fixed inset-0 z-10" aria-hidden="true" onClick={() => setMenuOpen(false)} />
              <div
                data-testid="mail-thread-menu"
                className="absolute right-0 z-20 mt-1 w-56 rounded-xl border border-edge bg-raised p-1 shadow-lg"
              >
                <button type="button" className={`${MENU_ITEM} sm:hidden`} disabled={!last} onClick={() => { setMenuOpen(false); reply('replyAll'); }}>
                  <ReplyAll size={15} /> Reply all
                </button>
                <button type="button" className={`${MENU_ITEM} sm:hidden`} disabled={!last} onClick={() => { setMenuOpen(false); reply('forward'); }}>
                  <Forward size={15} /> Forward
                </button>
                <button type="button" className={`${MENU_ITEM} sm:hidden`} onClick={() => run('archive', { back: true, failure: 'Could not archive this conversation.' })}>
                  <Archive size={15} /> Archive
                </button>
                <button type="button" className={`${MENU_ITEM} sm:hidden`} onClick={() => { setMenuOpen(false); setMoveOpen(true); }}>
                  <FolderInput size={15} /> Move to folder…
                </button>
                <button type="button" className={`${MENU_ITEM} sm:hidden`} onClick={() => run('trash', { back: true, failure: 'Could not delete this conversation.' })}>
                  <Trash2 size={15} /> Trash
                </button>
                <button type="button" className={`${MENU_ITEM} sm:hidden`} onClick={() => run(starred ? 'unstar' : 'star', { failure: 'Could not update the star.' })}>
                  <Star size={15} /> {starred ? 'Unstar' : 'Star'}
                </button>
                <button type="button" className={`${MENU_ITEM} sm:hidden`} onClick={() => run('unread', { back: true, failure: 'Could not mark this conversation unread.' })}>
                  <Mail size={15} /> Mark unread
                </button>
                {/* A blank composer — not "open THIS thread in the composer",
                    which is what the inline reply's own promote button does. */}
                <button type="button" className={MENU_ITEM} onClick={() => { setMenuOpen(false); onOpenInComposer(); }}>
                  <PenSquare size={15} /> New message
                </button>
              </div>
            </>
          )}
        </div>

        {moveOpen && (
          <>
            <div className="fixed inset-0 z-10" aria-hidden="true" onClick={() => setMoveOpen(false)} />
            <div
              data-testid="mail-move-menu"
              className="absolute left-2 top-full z-20 mt-1 max-h-72 w-56 overflow-y-auto rounded-xl border border-edge bg-raised p-1 shadow-lg"
            >
              {railFolders.length === 0 && <p className="px-2 py-1.5 text-sm text-ink-faint">No folders</p>}
              {railFolders.map(({ folder, label, Icon }) => (
                <button
                  key={folder.id}
                  type="button"
                  className={MENU_ITEM}
                  onClick={() => run('move', { folderId: folder.id, back: true, failure: 'Could not move this conversation.' })}
                >
                  <Icon size={15} /> {label}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3 sm:px-4">
        <div className="mb-2 flex flex-wrap items-center gap-1.5">
          {links.map(l => {
            const me = currentUser();
            const canUnlink = !!me.id && (l.linkedByUserId === me.id || me.role === 'admin');
            return (
              <span
                key={l.id}
                data-testid="mail-thread-link-chip"
                title={`${itemTypeLabel(l.itemType)} · ${l.label ?? l.itemId}`}
                className="inline-flex items-center gap-1 rounded bg-accent-500/10 py-0.5 pl-1.5 pr-1 text-[11px] font-medium text-accent-700 dark:text-accent-300"
              >
                {l.label ?? itemTypeLabel(l.itemType)}
                {canUnlink && (
                  <button
                    type="button"
                    aria-label={`Unlink ${l.label ?? itemTypeLabel(l.itemType)}`}
                    disabled={unlinkingId === l.id}
                    onClick={() => unlink(l.id)}
                    className="rounded p-0.5 text-accent-700/70 transition-colors hover:bg-accent-500/20 hover:text-accent-700 disabled:opacity-50 dark:text-accent-300/70 dark:hover:text-accent-300"
                  >
                    <X size={11} />
                  </button>
                )}
              </span>
            );
          })}
          <button
            type="button"
            onClick={() => setLinkModalOpen(true)}
            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-medium text-ink-faint transition-colors hover:bg-hover hover:text-ink"
          >
            <Link2 size={11} /> Link
          </button>
        </div>

        <LinkPickerModal
          open={linkModalOpen}
          onClose={() => setLinkModalOpen(false)}
          threadKey={threadKey}
          onLinked={reload}
        />

        <h1 className="mb-3 text-lg font-semibold text-ink">{thread.subject || '(no subject)'}</h1>

        <div className="space-y-2">
          {view.map(m => (
            <MessageCard
              key={m.id}
              message={m}
              expanded={expanded.has(m.id)}
              onToggle={() => toggle(m.id)}
              ownAddresses={ownAddresses}
              onReply={mode => onReply(mode, m)}
              onSave={onSaveAttachments ? () => onSaveAttachments(m) : undefined}
              onEditDraft={onEditDraft ? () => onEditDraft(m) : undefined}
            />
          ))}
        </div>

        {replyComposer && (
          <div className="mt-3">
            <MailComposer
              key={`${replyComposer.mode}:${replyComposer.message.id}`}
              open
              variant={replyVariant}
              onClose={onReplyClose}
              accounts={accounts}
              defaultAccountId={accountId}
              mode={replyComposer.mode}
              replyTo={{ accountId, threadKey, message: replyComposer.message, bodyHtml: replyComposer.bodyHtml }}
              onSent={() => reload()}
              onOpenInModal={replyVariant === 'inline' ? onReplyPromote : undefined}
              onDirtyChange={onReplyDirtyChange}
            />
          </div>
        )}
      </div>
    </div>
  );
};
