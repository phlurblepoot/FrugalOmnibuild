// src/pages/project/rfi/PendingReplyBanner.tsx
//
// "Someone emailed an answer back on this RFI." The reply is captured
// server-side against the sent RFI but is deliberately NOT the recorded
// response until a person says so — an inbound email is a stranger's text, and
// the RFI response ends up on a printed, emailed document.
//
// Three rules the rest of this file exists to honour:
//
//  1. Everything the banner shows — the body, the sender's display name, every
//     attachment name — is attacker-chosen. It is rendered as React children
//     (escaped text) and nothing else: no dangerouslySetInnerHTML, no feeding
//     it into a PDF/HTML template, no building a path out of an attachment
//     name (the server sanitises names when it saves them to Documents).
//
//  2. pendingReply.accountId is the RECEIVING user's mailbox. Whoever sent the
//     RFI is usually not the person reading this banner, and for anyone else
//     the mail routes answer 403/404 — so the deep link is gated on
//     `canOpenThread`, which the editor works out, and the degraded state says
//     why rather than going silent. The SAME rule governs the attachments:
//     saving one posts to /api/mail/messages/:id/save on the receiving
//     mailbox, so for a non-owner it 404s. `ownsMailbox` gates that half —
//     separately from `canOpenThread`, which may be true via a second mailbox
//     of the viewer's that happens to hold the same thread, and that fallback
//     mailbox is NOT where this message id lives.
//
//  3. Recording the answer is ALWAYS the accept endpoint, never a bare
//     setRfiResponse: accept records text and/or file AND clears the pending
//     row in one transaction. setRfiResponse would flip the RFI to answered
//     while leaving the reply pending — an orphan the banner would then hide.
//     The only exception is the fallback below, where the reply is already
//     gone and there is nothing left to clear.
import React, { useEffect, useState } from 'react';
import { Mail, Paperclip } from 'lucide-react';
import { Rfi, acceptRfiPendingReply, dismissRfiPendingReply, setRfiResponse } from '../../../utils/store';
import { useToast } from '../../../components/Toast';
import { useConfirm } from '../../../components/ConfirmDialog';
import { Button } from '../../../components/ui';
import { formatMailDate } from '../../mail/mailFormat';
import { SaveAttachmentsModal, SavedAttachment } from '../../mail/SaveAttachmentsModal';

// Long enough that clamping earns its keep; short enough that a typical
// two-paragraph answer is shown whole. jsdom can't measure a line-clamp, so the
// toggle is offered on the content rather than on the rendered height.
const isLong = (text: string) => text.split('\n').length > 6 || text.length > 400;

export const PendingReplyBanner: React.FC<{
  rfi: Rfi;
  projectId: string;
  /** Hands the reply body to the editor's response draft. Accepting it is the
   *  editor's Save, not this button — one action, one confirmation. */
  onUseAsResponse: (text: string) => void;
  /** The editor's response draft when it came from THIS reply (i.e. after Use
   *  as response), else null. An attachment accepted from here carries it, so
   *  edits the user already made are not thrown away by the file path. */
  draftText?: string | null;
  /** The pending reply is gone (dismissed here, or already gone server-side) —
   *  reload the record. */
  onDismissed: () => void;
  /** The reply was accepted from here (a saved attachment became the response
   *  document) — reload the record and drop the editor's accept flag. */
  onAccepted?: () => void;
  onOpenThread?: () => void;
  /** False when the receiving mailbox belongs to another user. */
  canOpenThread: boolean;
  /** True only when the viewer owns `pendingReply.accountId` itself — the
   *  mailbox the attachment save route reads the message from. Strictly
   *  narrower than `canOpenThread`. */
  ownsMailbox: boolean;
}> = ({ rfi, projectId, onUseAsResponse, draftText, onDismissed, onAccepted, onOpenThread, canOpenThread, ownsMailbox }) => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [expanded, setExpanded] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Files that landed in Documents and still need the "use it as the response?"
  // question. Held rather than asked immediately because a PARTIAL save leaves
  // the save modal open on the failures — stacking a confirm on top of it would
  // ask about one file while the user is still retrying another.
  const [saved, setSaved] = useState<SavedAttachment[]>([]);

  const pending = rfi.pendingReply ?? null;
  // The status is the authority on whether an answer is still awaited: a
  // pending row can outlive an out-of-band status change (someone closed the
  // RFI by hand), and reviewing a reply on a closed RFI is nonsense.
  const live = pending && rfi.status === 'sent' ? pending : null;

  useEffect(() => {
    if (saveOpen || !saved.length || !live) return;
    const files = saved;
    setSaved([]);
    void (async () => {
      const file = files[0];
      if (!(await confirm({
        title: 'Response document',
        message: `Use ${file.name} as the RFI response document?`,
        confirmLabel: 'Use it',
      }))) return;
      // The text the user means to record: their edit if they already pressed
      // Use as response, otherwise the reply as it arrived. One accept call
      // records both halves and clears the pending row.
      const text = (draftText ?? '').trim() || live.text;
      try {
        await acceptRfiPendingReply(rfi.id, { text, fileId: file.fileId });
        toast('Response recorded from the email reply', { type: 'success' });
        onAccepted?.();
      } catch (e) {
        if (e instanceof Error && e.name === 'NoPendingReplyError') {
          // Someone else handled the reply while the file was uploading. There
          // is no pending row left to clear, so the plain response write is now
          // the right call — the user still gets the document they picked.
          try {
            await setRfiResponse(rfi.id, { fileId: file.fileId });
            toast('That reply was already handled — attached the document as the response', { type: 'warning' });
          } catch { toast('Failed to attach the response document', { type: 'error' }); }
          onAccepted?.();
        } else { toast('Failed to attach the response document', { type: 'error' }); }
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saveOpen, saved]);

  if (!live) return null;

  const who = live.from.name || live.from.addr;
  const when = formatMailDate(live.date);
  const attachments = live.attachments ?? [];

  const dismiss = async () => {
    setBusy(true);
    try {
      await dismissRfiPendingReply(rfi.id);
      onDismissed();
    } catch (e) {
      // A reply someone else already dealt with is not an error the user can
      // act on — the honest response is to reload and let the banner vanish.
      if (e instanceof Error && e.name === 'NoPendingReplyError') {
        toast('That reply was already handled', { type: 'info' });
        onDismissed();
      } else {
        toast('Failed to dismiss the reply', { type: 'error' });
      }
    } finally { setBusy(false); }
  };

  const useAsResponse = () => {
    onUseAsResponse(live.text);
    // The answer often IS the attachment, so offer to file it in the same
    // motion rather than making the user hunt for it in the mail page — but
    // only for the mailbox's owner. For anyone else the save 404s, so opening
    // the modal would turn a working text-only accept into a dead end.
    if (attachments.length && ownsMailbox) setSaveOpen(true);
  };

  return (
    <div
      data-testid="rfi-pending-reply"
      className="mb-4 rounded-lg border border-amber-300 bg-amber-50 p-3 dark:border-amber-500/40 dark:bg-amber-900/20"
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Mail size={15} className="shrink-0 text-amber-600 dark:text-amber-400" />
        <span className="text-sm font-semibold text-amber-900 dark:text-amber-200">Reply received from {who}</span>
        {when && <span className="text-xs text-amber-800/80 dark:text-amber-300/80">· {when}</span>}
      </div>
      <p className="mt-0.5 text-[11px] text-amber-800/80 dark:text-amber-300/80">
        Not recorded as the response yet — review it, then use it or dismiss it.
      </p>

      <div
        data-testid="rfi-pending-reply-text"
        className={`mt-2 whitespace-pre-wrap break-words text-sm text-ink ${expanded ? '' : 'line-clamp-6'}`}
      >
        {live.text}
      </div>
      {isLong(live.text) && (
        <button
          className="mt-1 text-xs font-medium text-amber-800 underline dark:text-amber-300"
          onClick={() => setExpanded(v => !v)}
        >
          {expanded ? 'Show less' : 'Show more'}
        </button>
      )}

      {attachments.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1">
          {attachments.map(a => (
            <span key={a.attId} className="inline-flex items-center gap-1 text-xs text-ink-soft">
              <Paperclip size={12} className="shrink-0" />
              <span className="break-all">{a.name}</span>
            </span>
          ))}
          {ownsMailbox ? (
            <Button size="sm" variant="ghost" onClick={() => setSaveOpen(true)}>Save to Documents…</Button>
          ) : (
            // Deliberately not a repeat of the Open-thread note below: for a
            // non-owner both are usually shown, and two identical sentences
            // stacked would read as a rendering bug rather than as two
            // controls each explaining itself.
            <span data-testid="rfi-pending-reply-attachments-foreign" className="text-xs text-ink-faint">
              Saving needs the receiving mailbox
            </span>
          )}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button size="sm" onClick={useAsResponse}>Use as response</Button>
        <Button size="sm" variant="secondary" onClick={dismiss} disabled={busy}>Dismiss</Button>
        <Button
          size="sm"
          variant="ghost"
          disabled={!canOpenThread}
          title={canOpenThread ? 'Open the email conversation' : "The reply is in another user's mailbox"}
          onClick={() => { if (canOpenThread) onOpenThread?.(); }}
        >
          Open thread
        </Button>
        {!canOpenThread && (
          <span data-testid="rfi-pending-reply-foreign" className="text-xs text-ink-faint">
            Received in another user's mailbox
          </span>
        )}
      </div>

      <SaveAttachmentsModal
        open={saveOpen && ownsMailbox}
        onClose={() => setSaveOpen(false)}
        messageId={live.mailMessageId}
        attachments={attachments}
        defaultProjectId={projectId}
        onSaved={setSaved}
      />
    </div>
  );
};
