// src/pages/mail/MessageCard.tsx — one message in the reading pane. Collapsed
// it is a single line (from · snippet · date); expanded it shows the full
// header, the sandboxed body and the attachment chips.
import React from 'react';
import { ChevronUp, Forward, Pencil, Reply, ReplyAll } from 'lucide-react';
import { AttachmentChips } from './AttachmentChips';
import { MessageBodyFrame } from './MessageBodyFrame';
import { formatMailDate } from './mailFormat';
import type { Addr, MessageRow } from './types';

export type ReplyMode = 'reply' | 'replyAll' | 'forward';

const displayName = (a: Addr | null): string => (a?.name || '').trim() || a?.addr || '(unknown sender)';

/** "to me, cc Dana Lee" — the reader is always "me", everyone else by name. */
export function recipientsLabel(message: MessageRow, ownAddresses: string[]): string {
  const own = new Set(ownAddresses.map(a => a.trim().toLowerCase()));
  const names = (list: Addr[]): string[] => {
    const out: string[] = [];
    for (const a of list ?? []) {
      const label = own.has((a.addr ?? '').trim().toLowerCase()) ? 'me' : (a.name || '').trim() || a.addr;
      if (label && !out.includes(label)) out.push(label);
    }
    return out;
  };
  const shorten = (out: string[]): string => (out.length > 3 ? `${out.slice(0, 3).join(', ')} +${out.length - 3}` : out.join(', '));

  const parts: string[] = [];
  const to = names(message.to);
  const cc = names(message.cc);
  if (to.length) parts.push(`to ${shorten(to)}`);
  if (cc.length) parts.push(`cc ${shorten(cc)}`);
  return parts.join(', ');
}

const ReplyButton: React.FC<{ label: string; Icon: typeof Forward; onClick: () => void }> = ({ label, Icon, onClick }) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    onClick={e => {
      e.stopPropagation();
      onClick();
    }}
    className="rounded p-1.5 text-ink-faint transition-colors hover:bg-hover hover:text-ink"
  >
    <Icon size={15} />
  </button>
);

export const MessageCard: React.FC<{
  message: MessageRow;
  expanded: boolean;
  onToggle: () => void;
  ownAddresses: string[];
  onReply: (mode: ReplyMode) => void;
  onSave?: () => void;
  /** Reopens this message in the composer; offered only on drafts. */
  onEditDraft?: () => void;
}> = ({ message, expanded, onToggle, ownAddresses, onReply, onSave, onEditDraft }) => {
  const from = displayName(message.from);
  const initial = (from.replace(/[^A-Za-z0-9]/g, '')[0] ?? '?').toUpperCase();
  const date = formatMailDate(message.date);
  const fullDate = new Date(message.date).toLocaleString('en-US');
  const editDraft = message.isDraft && onEditDraft ? (
    <button
      type="button"
      data-testid="mail-edit-draft"
      onClick={e => {
        e.stopPropagation();
        onEditDraft();
      }}
      className="inline-flex shrink-0 items-center gap-1 rounded-lg border border-edge px-2 py-0.5 text-xs font-medium text-ink hover:bg-hover"
    >
      <Pencil size={12} />
      Edit draft
    </button>
  ) : null;

  if (!expanded) {
    return (
      <div
        role="button"
        tabIndex={0}
        data-testid="mail-message-card"
        data-message-id={message.id}
        data-expanded="false"
        data-unread={String(!message.isRead)}
        onClick={onToggle}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        className={`flex w-full cursor-pointer items-baseline gap-2 rounded-xl border border-edge px-3 py-2 text-left transition-colors hover:bg-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40 ${
          message.isRead ? 'bg-raised' : 'bg-raised font-semibold'
        }`}
      >
        <span className="shrink-0 truncate text-sm text-ink">{from}</span>
        <span className="min-w-0 flex-1 truncate text-xs font-normal text-ink-faint">{message.snippet}</span>
        {editDraft}
        <span className="shrink-0 text-xs font-normal text-ink-faint" title={fullDate}>{date}</span>
      </div>
    );
  }

  return (
    <div
      data-testid="mail-message-card"
      data-message-id={message.id}
      data-expanded="true"
      data-unread={String(!message.isRead)}
      className="rounded-xl border border-edge bg-raised"
    >
      <div
        role="button"
        tabIndex={0}
        data-testid="mail-message-header"
        onClick={onToggle}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onToggle();
          }
        }}
        className="flex w-full cursor-pointer items-start gap-3 px-3 py-2.5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent-500/40"
      >
        <span
          data-testid="mail-avatar"
          aria-hidden="true"
          className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full bg-accent-500/15 text-sm font-semibold text-accent-700 dark:text-accent-300"
        >
          {initial}
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="truncate text-sm font-semibold text-ink">{from}</span>
            {message.from?.addr && message.from.addr !== from && (
              <span className="truncate text-xs text-ink-faint">{message.from.addr}</span>
            )}
          </div>
          <p className="truncate text-xs text-ink-faint">{recipientsLabel(message, ownAddresses)}</p>
        </div>

        <div className="flex shrink-0 items-center gap-1">
          {editDraft}
          <span className="text-xs text-ink-faint" title={fullDate}>{date}</span>
          {/* Distinct from the toolbar's thread-level Reply/Reply all/Forward:
              these act on THIS message, and the names must not collide. */}
          <ReplyButton label="Reply to this message" Icon={Reply} onClick={() => onReply('reply')} />
          <ReplyButton label="Reply all to this message" Icon={ReplyAll} onClick={() => onReply('replyAll')} />
          <ReplyButton label="Forward this message" Icon={Forward} onClick={() => onReply('forward')} />
          <ChevronUp size={15} className="text-ink-faint" />
        </div>
      </div>

      <div className="space-y-3 border-t border-edge px-3 py-3">
        <MessageBodyFrame messageId={message.id} />
        <AttachmentChips messageId={message.id} attachments={message.attachments} onSave={onSave} />
      </div>
    </div>
  );
};
