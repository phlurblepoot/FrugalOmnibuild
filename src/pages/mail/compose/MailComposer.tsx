// src/pages/mail/compose/MailComposer.tsx — the one compose surface in the app.
//
// It is used two ways and has to be honest about both:
//  - Standalone mail (MailPage / ThreadView): the composer owns the send, calls
//    `mailApi.send`, and autosaves a draft while the user types.
//  - Item sends (DocumentActionsBar): the caller passes `onSend`, because only
//    it knows how to generate + attach the item's document and which server
//    route applies the item's side effects. Those never autosave a draft — the
//    document doesn't exist yet, so a resumable draft would be a lie.
//
// Everything below follows from that split: the primary attachment is display
// only (the caller attaches the real bytes), `existingThread` is offered only
// when the caller knows of a thread to reply into, and `effectsSkipped` in the
// result is surfaced as a warning because a sent mail whose item status did not
// move is exactly the thing a user would otherwise never notice.
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, Maximize2, Minimize2, Paperclip, X } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { Button, Input, Modal, Select } from '../../../components/ui';
import { useToast } from '../../../components/Toast';
import { FilePickerModal } from '../../../components/FilePickerModal';
import { DocumentGenerationCancelled } from '../../../components/documents/errors';
import type { DocumentRow } from '../../../utils/store';
import { getAlwaysCc } from '../../../utils/store';
import { mailApi } from '../../../utils/mailApi';
import { itemTypeLabel } from '../mailFormat';
import { buildFrameDoc } from '../MessageBodyFrame';
import type { Addr, ItemType, MailAccount, MessageRow, SendRequest, SendResult } from '../types';
import { RecipientsField, mergeAddrs, parseAddr, type RecipientsFieldHandle } from './RecipientsField';
import { RichTextEditor } from './RichTextEditor';
import { useDraftAutosave, type DraftSnapshot } from './useDraftAutosave';
import { forwardSubject, quoteForForward, quoteForReply, replyAllRecipients, replySubject, splitDraftQuote } from './quote';

export type ComposerAttachment =
  | { kind: 'file'; fileId: string; name: string; size?: number; itemType?: ItemType; itemId?: string }
  | { kind: 'upload'; uploadId: string; name: string; size: number };

export interface MailComposerProps {
  open: boolean;
  onClose: () => void;
  variant: 'modal' | 'inline';
  accounts: MailAccount[];
  defaultAccountId?: string;
  mode?: 'new' | 'reply' | 'replyAll' | 'forward';
  /** The message being replied to / forwarded, with its rendered body. */
  replyTo?: { accountId: string; threadKey: string; message: MessageRow; bodyHtml: string };
  initial?: { to?: Addr[]; cc?: Addr[]; bcc?: Addr[]; subject?: string; html?: string; attachments?: ComposerAttachment[] };
  /** Called with the resolved SendRequest; the caller performs the send. Default: mailApi.send. */
  onSend?: (req: SendRequest) => Promise<SendResult | void>;
  onSent?: (r: SendResult | void) => void;
  /** Fixed, non-removable primary attachment (the item's document). Display
   *  only, and never stale: the one caller that sets it (DocumentActionsBar)
   *  regenerates the document during the send whenever the stored copy is
   *  behind the record, so a "this is out of date" warning here could only
   *  ever be wrong. */
  primaryAttachment?: { name: string; itemType?: ItemType; itemId?: string };
  /** Offers "Reply in existing thread" / "New thread" for item sends. */
  existingThread?: { accountId: string; threadKey: string; subject: string };
  title?: string;
  /** Rendered above the recipients — e.g. the "Document shows email" select. */
  extraHeader?: React.ReactNode;
  onOpenInModal?: () => void;
  /** Piece 1 (reply-discard confirm): fires whenever "has the user typed
   *  something since this composer opened" changes — reuses draft
   *  autosave's own baseline (see useDraftAutosave's `dirty`), so this stays
   *  false through the initial seed (including the async always-Cc merge)
   *  and only flips once something the user actually did would be lost. */
  onDirtyChange?: (dirty: boolean) => void;
  /** A draft reopened from the mailbox (spec §9). Its content arrives in
   *  `initial`; this says which provider draft to keep updating, in which
   *  account, and which thread it answers. A resumed draft gets no signature
   *  and no always-Cc (it already has whatever it was saved with). */
  resumeDraft?: { accountId: string; draftId: string; replyTo?: { accountId: string; threadKey: string } | null };
}

/**
 * The `sourceType` strings the document editors actually write (see the
 * `source` prop each DocumentActionsBar passes) mapped onto the server's
 * closed ItemType set. Both the hyphenated and camelCase spellings are
 * accepted because the editors are not consistent about it.
 */
export function itemTypeFromSource(sourceType?: string | null): ItemType | undefined {
  switch (sourceType) {
    case 'proposal': return 'proposal';
    case 'invoice': return 'invoice';
    case 'change-order':
    case 'changeOrder': return 'changeOrder';
    case 'lien-release':
    case 'lienRelease': return 'lienRelease';
    case 'issue': return 'issue';
    case 'rfi': return 'rfi';
    case 'daily-report':
    case 'dailyReport': return 'dailyReport';
    case 'payapp':
    case 'payApp':
    case 'aiaPayApp': return 'payApp';
    case 'punch': return 'punch';
    case 'task': return 'task';
    default: return undefined;
  }
}

const SENDABLE: MailAccount['status'][] = ['ok', 'syncing'];
const isSendable = (a: MailAccount): boolean => SENDABLE.includes(a.status);

const STATUS_REASON: Record<string, string> = {
  auth_error: 'Sign in again',
  needs_review: 'Needs review',
  disabled: 'Disabled',
};

const accountLabel = (a: MailAccount): string => {
  const base = a.displayName ? `${a.displayName} <${a.emailAddress}>` : a.emailAddress;
  if (isSendable(a)) return base;
  return `${base} — ${a.lastError || STATUS_REASON[a.status] || 'Unavailable'}`;
};

const attachmentKey = (a: ComposerAttachment): string => (a.kind === 'file' ? `f:${a.fileId}` : `u:${a.uploadId}`);

/** "just now" / "12s ago" / "3m ago" — the draft status line. */
export function agoLabel(then: Date, now: Date = new Date()): string {
  const secs = Math.max(0, Math.round((now.getTime() - then.getTime()) / 1000));
  if (secs < 5) return 'just now';
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  return `${Math.round(mins / 60)}h ago`;
}

const CHIP = 'inline-flex max-w-full items-center gap-1.5 rounded-lg border border-edge bg-raised px-2 py-1 text-xs text-ink';

export const MailComposer: React.FC<MailComposerProps> = ({
  open, onClose, variant, accounts, defaultAccountId, mode = 'new', replyTo, initial,
  onSend, onSent, primaryAttachment, existingThread, title, extraHeader, onOpenInModal, onDirtyChange, resumeDraft,
}) => {
  const { toast } = useToast();

  const [accountId, setAccountId] = useState('');
  const [to, setTo] = useState<Addr[]>([]);
  const [cc, setCc] = useState<Addr[]>([]);
  const [bcc, setBcc] = useState<Addr[]>([]);
  const [showCcBcc, setShowCcBcc] = useState(false);
  const [subject, setSubject] = useState('');
  const [html, setHtml] = useState('');
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  // The quote is deliberately NOT part of the editor document. TipTap's schema
  // drops what it has no node for (images, tables, most inline styling) the
  // moment the user types, so a quote parsed into the editor would be silently
  // rewritten — and an untouched reply would transmit different markup from an
  // edited one. It lives beside the editor as opaque html and is concatenated
  // at send time, which is also how every real mail client behaves.
  const [quoteHtml, setQuoteHtml] = useState('');
  const [quoteRemoved, setQuoteRemoved] = useState(false);
  const [quoteOpen, setQuoteOpen] = useState(false);
  const [useExistingThread, setUseExistingThread] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [uploading, setUploading] = useState(0);
  const [sending, setSending] = useState(false);
  const [expanded, setExpanded] = useState(false);
  // Autosave stays parked until seeding (including the async always-Cc merge)
  // has finished, so simply opening a composer never creates a draft.
  const [seeded, setSeeded] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // Text typed into a recipients row but never confirmed with Enter/comma.
  // Send counts it and commits it rather than dropping the user's address.
  const [toPending, setToPending] = useState('');
  const toRef = useRef<RecipientsFieldHandle>(null);
  const ccRef = useRef<RecipientsFieldHandle>(null);
  const bccRef = useRef<RecipientsFieldHandle>(null);

  // Re-seed on every open so each open starts from the caller's defaults.
  useEffect(() => {
    if (!open) return;

    const acct = (resumeDraft ? accounts.find(a => a.id === resumeDraft.accountId) : undefined)
      ?? accounts.find(a => a.id === defaultAccountId)
      ?? accounts.find(isSendable)
      ?? accounts[0]
      ?? null;

    let seedTo = initial?.to ?? [];
    let seedCc = initial?.cc ?? [];
    let seedSubject = initial?.subject ?? '';
    let quote = '';

    const source = replyTo?.message;
    if (source) {
      const body = replyTo?.bodyHtml ?? '';
      if (mode === 'forward') {
        seedSubject = initial?.subject ?? forwardSubject(source.subject);
        quote = quoteForForward(source, body);
      } else if (mode === 'reply' || mode === 'replyAll') {
        if (mode === 'replyAll') {
          const all = replyAllRecipients(source, accounts.map(a => a.emailAddress));
          seedTo = initial?.to ?? all.to;
          seedCc = initial?.cc ?? all.cc;
        } else {
          seedTo = initial?.to ?? (source.from ? [source.from] : []);
        }
        seedSubject = initial?.subject ?? replySubject(source.subject);
        quote = quoteForReply(source, body);
      }
    }

    // The signature is stamped once, here — not re-applied when the From
    // select changes, which would silently rewrite text the user may have
    // already edited around.
    const sig = !resumeDraft && acct?.signatureHtml?.trim() ? `<br><br>--<br>${acct.signatureHtml}` : '';
    // A resumed draft's quote goes back beside the editor, where it was.
    let seedHtml = initial?.html ?? '';
    if (resumeDraft) {
      const split = splitDraftQuote(seedHtml);
      seedHtml = split.body;
      quote = split.quote;
    }

    setAccountId(acct?.id ?? '');
    setTo(seedTo);
    setCc(seedCc);
    setBcc(initial?.bcc ?? []);
    setShowCcBcc(seedCc.length > 0 || (initial?.bcc?.length ?? 0) > 0);
    setSubject(seedSubject);
    setHtml(`${seedHtml}${sig}`);
    setQuoteHtml(quote);
    setQuoteRemoved(false);
    setQuoteOpen(false);
    setAttachments(initial?.attachments ?? []);
    setUseExistingThread(true);
    setSending(false);
    setExpanded(false);
    setSeeded(false);

    let cancelled = false;
    if (resumeDraft) {
      setSeeded(true);
      return () => { cancelled = true; };
    }
    void (async () => {
      try {
        const raw = await getAlwaysCc();
        if (cancelled) return;
        const extra = raw.split(/[,;]/).map(s => parseAddr(s)).filter((a): a is Addr => a !== null);
        if (!extra.length) return;
        setCc(prev => mergeAddrs(prev, extra));
        setShowCcBcc(true);
      } finally {
        if (!cancelled) setSeeded(true);
      }
    })();
    return () => { cancelled = true; };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Accounts can land after the composer opens (the list is loaded live).
  useEffect(() => {
    if (!open || accountId || accounts.length === 0) return;
    setAccountId((accounts.find(isSendable) ?? accounts[0]).id);
  }, [open, accountId, accounts]);

  /** What actually gets sent (and saved as a draft): the user's text, then the quote. */
  const composedHtml = html + (quoteRemoved ? '' : quoteHtml);

  // Reuses the thread view's frame document: an opaque-origin iframe whose CSP
  // allows no remote images (no tracking pixel fires while composing) and no
  // scripts — the sandbox here grants neither allow-scripts nor
  // allow-same-origin, so the sender's markup is inert.
  // Memoized on the quote itself: rebuilding the srcDoc string every render
  // would reload the frame on every keystroke, and a nonce that repeats across
  // documents would outlive the document it was minted for.
  const quoteDoc = useMemo(
    () => (quoteHtml ? buildFrameDoc(quoteHtml, uuidv4(), window.location.origin) : ''),
    [quoteHtml],
  );

  // The thread this message answers: the message being replied to, or the
  // thread a resumed reply draft was saved against. Forwards start a thread.
  const replyThread = useMemo(() => {
    if (replyTo && (mode === 'reply' || mode === 'replyAll')) return { accountId: replyTo.accountId, threadKey: replyTo.threadKey };
    if (resumeDraft?.replyTo) return { accountId: resumeDraft.replyTo.accountId, threadKey: resumeDraft.replyTo.threadKey };
    return null;
  }, [replyTo, mode, resumeDraft]);

  const snapshot = useMemo<DraftSnapshot>(
    () => ({
      to, cc, bcc, subject, html: composedHtml,
      attachments: attachments.map(a => (a.kind === 'upload' ? { uploadId: a.uploadId } : { fileId: a.fileId, name: a.name })),
      ...(replyThread ? { replyTo: replyThread } : {}),
    }),
    [to, cc, bcc, subject, composedHtml, attachments, replyThread],
  );
  const draft = useDraftAutosave({
    accountId: accountId || null,
    // Item sends go through the caller's route, so there is no draft to resume.
    // Parked during a send too: the server deletes the draft as part of the
    // send, so a debounce firing afterwards would recreate it as a ghost.
    enabled: open && seeded && !onSend && !sending,
    // `dirty` must NOT reset just because a send attempt is in flight — a
    // failed send (composer stays open, `sending` goes back to false) would
    // otherwise re-baseline to the still-unsent text and silently defeat the
    // discard-confirm on the next navigation. Deliberately excludes
    // `!sending` that `enabled` above includes.
    dirtyEnabled: open && seeded && !onSend,
    initialDraft: resumeDraft ? { accountId: resumeDraft.accountId, draftId: resumeDraft.draftId } : null,
    get: () => snapshot,
  });

  // Re-render the "saved 12s ago" line without re-rendering on every tick.
  const [, forceTick] = useState(0);
  useEffect(() => {
    if (!draft.savedAt) return;
    const i = setInterval(() => forceTick(n => n + 1), 5000);
    return () => clearInterval(i);
  }, [draft.savedAt]);

  useEffect(() => {
    onDirtyChange?.(draft.dirty);
  }, [draft.dirty, onDirtyChange]);
  // A composer that unmounts mid-edit (thread switch, tab close) never runs
  // its own close handler, so the caller would otherwise be stuck believing a
  // reply is still in progress.
  useEffect(() => () => onDirtyChange?.(false), []); // eslint-disable-line react-hooks/exhaustive-deps

  const addAttachments = useCallback((next: ComposerAttachment[]) => {
    setAttachments(prev => {
      const seen = new Set(prev.map(attachmentKey));
      return [...prev, ...next.filter(a => !seen.has(attachmentKey(a)))];
    });
  }, []);

  const onPickDocuments = useCallback((rows: DocumentRow[]) => {
    addAttachments(rows.map(row => ({
      kind: 'file' as const,
      fileId: row.id,
      name: row.name ?? 'Attachment',
      size: row.size,
      itemType: itemTypeFromSource(row.source?.type),
      itemId: row.source?.id,
    })));
  }, [addAttachments]);

  const onFilesChosen = useCallback(async (files: FileList | null) => {
    const list = Array.from(files ?? []);
    if (!list.length) return;
    setUploading(n => n + list.length);
    for (const file of list) {
      try {
        const { uploadId } = await mailApi.stageUpload(file);
        addAttachments([{ kind: 'upload', uploadId, name: file.name, size: file.size }]);
      } catch (err) {
        toast(err instanceof Error ? err.message : `Could not attach ${file.name}`, { type: 'error' });
      } finally {
        setUploading(n => n - 1);
      }
    }
  }, [addAttachments, toast]);

  const buildRequest = useCallback((final: { to: Addr[]; cc: Addr[]; bcc: Addr[] }): SendRequest => {
    const req: SendRequest = {
      accountId: accountId || undefined,
      to: final.to,
      subject,
      html: composedHtml,
      attachments: attachments.map(a => {
        if (a.kind === 'upload') return { uploadId: a.uploadId };
        const file: { fileId: string; name?: string; itemType?: ItemType; itemId?: string } =
          { fileId: a.fileId, name: a.name };
        if (a.itemType) file.itemType = a.itemType;
        if (a.itemId) file.itemId = a.itemId;
        return file;
      }),
    };
    if (final.cc.length) req.cc = final.cc;
    if (final.bcc.length) req.bcc = final.bcc;
    // Let the send route drop the draft in the same transaction — a separate
    // DELETE afterwards is a round trip that can fail on its own.
    if (draft.draftId) req.draftProviderId = draft.draftId;

    if (replyTo) req.replyTo = { accountId: replyTo.accountId, threadKey: replyTo.threadKey };
    else if (resumeDraft?.replyTo) req.replyTo = { accountId: resumeDraft.replyTo.accountId, threadKey: resumeDraft.replyTo.threadKey };
    else if (existingThread && useExistingThread) {
      req.replyTo = { accountId: existingThread.accountId, threadKey: existingThread.threadKey };
    }
    return req;
  }, [accountId, subject, composedHtml, attachments, replyTo, resumeDraft, existingThread, useExistingThread, draft.draftId]);

  const canSend = (to.length > 0 || parseAddr(toPending) !== null) && !sending && uploading === 0;

  const handleSend = async () => {
    if (!canSend) return;
    // Sweep up anything typed but not yet confirmed in each row.
    const final = {
      to: mergeAddrs(to, toRef.current?.commitPending() ?? []),
      cc: mergeAddrs(cc, ccRef.current?.commitPending() ?? []),
      bcc: mergeAddrs(bcc, bccRef.current?.commitPending() ?? []),
    };
    if (final.to.length === 0) return;

    setSending(true);
    try {
      const result = await (onSend ?? mailApi.send)(buildRequest(final));
      toast('Sent', { type: 'success' });

      const skipped = (result as SendResult | undefined)?.effectsSkipped ?? [];
      if (skipped.length) {
        toast(`Sent — status not updated for: ${skipped.map(itemTypeLabel).join(', ')}`, { type: 'warning' });
      }

      onSent?.(result);
      onClose();
    } catch (err) {
      // Stay open: the body is the user's work, and a transport failure is
      // usually something they can retry or fix (a bad address, SMTP asleep).
      // An item send that was cancelled on the way (a failed pre-send save
      // that has already said so) is not a failure and gets no second message.
      if (!(err instanceof DocumentGenerationCancelled)) {
        toast(err instanceof Error ? err.message : 'Could not send the message', { type: 'error' });
      }
      setSending(false);
    }
  };

  const handleDiscard = async () => {
    await draft.discard();
    onClose();
  };

  if (!open) return null;

  const draftStatus = (() => {
    if (onSend) return null;
    if (draft.status === 'saving') return 'Saving draft…';
    if (draft.status === 'error') return 'Draft not saved';
    if (draft.status === 'saved' && draft.savedAt) return `Draft saved ${agoLabel(draft.savedAt)}`;
    return null;
  })();

  const fromSelect = (
    <Select
      aria-label="From"
      value={accountId}
      onChange={e => setAccountId(e.target.value)}
      className="h-8 max-w-[18rem] text-xs"
    >
      {accounts.length === 0 && <option value="">No mailbox connected</option>}
      {accounts.map(a => (
        <option key={a.id} value={a.id} disabled={!isSendable(a)}>{accountLabel(a)}</option>
      ))}
    </Select>
  );

  const quoteBlock = quoteHtml && !quoteRemoved ? (
    <div className="border-l-2 border-edge-strong pl-3" data-testid="composer-quote">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setQuoteOpen(v => !v)}
          className="text-xs font-medium text-ink-faint hover:text-ink"
        >
          {quoteOpen ? 'Hide quoted message' : 'Show quoted message'}
        </button>
        <button
          type="button"
          aria-label="Remove quoted message"
          onClick={() => { setQuoteRemoved(true); setQuoteOpen(false); }}
          className="text-ink-faint hover:text-ink"
        >
          <X size={13} />
        </button>
      </div>
      {quoteOpen && (
        <iframe
          data-testid="quote-preview"
          title="Quoted message"
          sandbox="allow-popups allow-popups-to-escape-sandbox"
          srcDoc={quoteDoc}
          className="mt-2 h-56 w-full rounded-lg border border-edge bg-white"
        />
      )}
    </div>
  ) : null;

  const attachmentRow = (
    <div className="flex flex-wrap items-center gap-2">
      {primaryAttachment && (
        <span className={`${CHIP} border-accent-500/50`} data-testid="primary-attachment-chip">
          <Paperclip size={13} className="shrink-0 text-ink-faint" />
          <span className="min-w-0 truncate">{primaryAttachment.name}</span>
          {primaryAttachment.itemType && (
            <span className="shrink-0 rounded bg-sunken px-1 text-[10px] text-ink-faint">
              {itemTypeLabel(primaryAttachment.itemType)}
            </span>
          )}
        </span>
      )}

      {attachments.map(a => (
        <span key={attachmentKey(a)} className={CHIP} data-testid="attachment-chip">
          <Paperclip size={13} className="shrink-0 text-ink-faint" />
          <span className="min-w-0 truncate">{a.name}</span>
          {a.kind === 'file' && a.itemType && (
            <span className="shrink-0 rounded bg-sunken px-1 text-[10px] text-ink-faint">{itemTypeLabel(a.itemType)}</span>
          )}
          <button
            type="button"
            aria-label={`Remove ${a.name}`}
            className="shrink-0 opacity-60 hover:opacity-100"
            onClick={() => setAttachments(prev => prev.filter(x => attachmentKey(x) !== attachmentKey(a)))}
          >
            <X size={12} />
          </button>
        </span>
      ))}

      {uploading > 0 && (
        <span className={CHIP}>
          <Loader2 size={13} className="animate-spin" />
          Uploading {uploading}…
        </span>
      )}

      <input
        ref={fileInput}
        type="file"
        multiple
        data-testid="composer-file-input"
        className="hidden"
        onChange={e => { void onFilesChosen(e.target.files); e.target.value = ''; }}
      />
      <Button variant="ghost" size="sm" onClick={() => fileInput.current?.click()}>📎 Attach file</Button>
      <Button variant="ghost" size="sm" onClick={() => setPickerOpen(true)}>📁 From Documents</Button>
    </div>
  );

  const form = (
    <div className="space-y-3">
      {extraHeader}

      {existingThread && (
        <div className="flex flex-wrap items-center gap-4 rounded-lg bg-sunken px-3 py-2 text-xs text-ink">
          <label className="inline-flex items-center gap-1.5">
            <input
              type="radio"
              className="accent-accent-600"
              checked={useExistingThread}
              onChange={() => setUseExistingThread(true)}
            />
            Reply in existing thread ({existingThread.subject})
          </label>
          <label className="inline-flex items-center gap-1.5">
            <input
              type="radio"
              className="accent-accent-600"
              checked={!useExistingThread}
              onChange={() => setUseExistingThread(false)}
            />
            New thread
          </label>
        </div>
      )}

      <div data-testid="composer-recipients">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <RecipientsField
              ref={toRef}
              label="To"
              value={to}
              onChange={setTo}
              onPendingChange={setToPending}
              autoFocus={mode !== 'forward'}
            />
          </div>
          {!showCcBcc && (
            <button
              type="button"
              onClick={() => setShowCcBcc(true)}
              className="shrink-0 pt-2 text-xs font-medium text-ink-faint hover:text-ink"
            >
              Cc Bcc
            </button>
          )}
        </div>
        {showCcBcc && (
          <>
            <RecipientsField ref={ccRef} label="Cc" value={cc} onChange={setCc} />
            <RecipientsField ref={bccRef} label="Bcc" value={bcc} onChange={setBcc} />
          </>
        )}
      </div>

      <Input
        aria-label="Subject"
        placeholder="Subject"
        value={subject}
        onChange={e => setSubject(e.target.value)}
      />

      <RichTextEditor
        value={html}
        onChange={setHtml}
        placeholder="Write your message…"
        minHeight={variant === 'inline' ? 140 : 220}
      />

      {quoteBlock}

      {attachmentRow}

      {pickerOpen && (
        <FilePickerModal
          open
          onClose={() => setPickerOpen(false)}
          onPick={onPickDocuments}
          accept="any"
          multi
          title="Attach files"
          excludeFileIds={attachments.flatMap(a => (a.kind === 'file' ? [a.fileId] : []))}
        />
      )}
    </div>
  );

  const footer = (
    <div className="flex w-full flex-wrap items-center gap-3">
      <Button data-testid="mail-composer-send" onClick={handleSend} disabled={!canSend}>
        {sending && <Loader2 size={14} className="mr-1.5 animate-spin" />}
        Send
      </Button>
      <span className="text-xs text-ink-faint" data-testid="draft-status">{draftStatus}</span>
      <Button variant="ghost" className="ml-auto" onClick={handleDiscard} disabled={sending}>
        Discard
      </Button>
    </div>
  );

  if (variant === 'inline') {
    return (
      <div className="rounded-xl border border-edge bg-raised p-3" data-testid="mail-composer-inline">
        <div className="mb-3 flex flex-wrap items-center gap-2">
          {fromSelect}
          {onOpenInModal && (
            <Button variant="ghost" size="sm" className="ml-auto" onClick={onOpenInModal}>
              <Maximize2 size={14} className="mr-1.5" />Open in composer
            </Button>
          )}
        </div>
        {form}
        <div className="mt-3">{footer}</div>
      </div>
    );
  }

  return (
    <Modal
      open
      onClose={onClose}
      width={expanded ? 'full' : 'lg'}
      title={
        <span className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="shrink-0">{title ?? (resumeDraft ? 'Edit draft' : mode === 'forward' ? 'Forward' : mode === 'new' ? 'New message' : 'Reply')}</span>
          {fromSelect}
          <button
            type="button"
            aria-label={expanded ? 'Shrink composer' : 'Expand composer'}
            onClick={() => setExpanded(v => !v)}
            className="ml-auto shrink-0 rounded-lg p-1.5 text-ink-faint hover:bg-hover hover:text-ink"
          >
            {expanded ? <Minimize2 size={16} /> : <Maximize2 size={16} />}
          </button>
        </span>
      }
      footer={footer}
    >
      <div data-testid="mail-composer">{form}</div>
    </Modal>
  );
};
