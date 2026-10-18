// src/components/documents/DocumentActionsBar.tsx
// The one document strip every editor mounts (invoice, change order, issue,
// punch, proposal, daily report, RFI, AIA pay app) so Generate / Open /
// Download / Send all converge on ONE living document per record instead of
// each screen inventing its own "download a fresh PDF" button (spec
// docs/superpowers/specs/2026-08-29-document-actions-rollout).
//
// The invariants worth knowing before changing anything here:
//  - Generating from a dirty editor would produce a document that disagrees
//    with the record, so Generate AND Send both save first and abort if that
//    save fails (spec §2, "Dirty rule").
//  - Regenerating never replaces a document: the fresh bytes become a new
//    version and the old ones stay in its history (ONLYOFFICE decision
//    2026-09-25; unwanted versions are deleted from the Documents page).
//  - Send reuses the stored file only when it is genuinely current, no save was
//    needed on the way in, AND the header email wasn't overridden in the
//    composer; anything else rebuilds, so the recipient always gets bytes that
//    match the record.
//  - A record with no change clock (staleness="unknown") never claims to be
//    current, so Send always rebuilds rather than mailing a stale file.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Download, ExternalLink, FileText, Mail } from 'lucide-react';
import { fetchFileBlob, persistGeneratedDocument } from '../../utils/store';
import { useGeneratedDocument } from '../../hooks/useGeneratedDocument';
import { useItemThreadLinks } from '../../hooks/useItemThreadLinks';
import { useReplyFlags } from '../../hooks/useReplyFlags';
import { downloadBlob } from '../../utils/download';
import { parseAddresses, textToHtml } from '../../utils/email';
import { MailComposer, itemTypeFromSource } from '../../pages/mail/compose/MailComposer';
import { useMailAccounts } from '../../pages/mail/useMailAccounts';
import type { SendRequest, SendResult } from '../../pages/mail/types';
import { useToast } from '../Toast';
import { Button, Select } from '../ui';
import { DocFormat, DocumentStatusChip, FORMAT_WORD } from './DocumentStatusChip';
import { DocumentGenerationCancelled } from './errors';
import { ReplyFlagChip } from './ReplyFlagChip';
import { SentThreadChip } from './SentThreadChip';
import { useDocumentViewer } from './useDocumentViewer';

export type { DocFormat };

/** The editors' prefilled email, still expressed the way they have always built
 *  it: comma-separated recipients and a plain-text body. The bar converts it
 *  into the composer's structured `initial` so seven editors don't each have to
 *  learn about `Addr[]` and html. */
export interface MailComposerPrefill {
  title?: string;
  defaultTo?: string;
  defaultCc?: string;
  defaultBcc?: string;
  defaultSubject: string;
  defaultBody: string;
  /** Renders the "Document shows email" select above the recipients. */
  headerEmailOptions?: { label: string; value: string }[];
  defaultHeaderEmail?: string;
  /** Files already attached when the composer opens (the sender can remove
   *  them), e.g. a pay app's PDF next to its workbook. */
  extraAttachments?: { fileId: string; name: string; size?: number }[];
}

export interface DocumentActionsBarProps {
  /** sourceId may be absent while the record is still unsaved — the bar then
   *  shows Generate/Send as blocked ('Save first') instead of guessing an id.
   *  A dirty (but saved) record does NOT block: both actions save first. */
  source: { sourceType: string; sourceId?: string };
  /** Document kind for persistGeneratedDocument (invoice, issue-report, …). */
  kind: string;
  format: DocFormat;
  projectId: string;
  /** Display + stored name, e.g. `Invoice-12.pdf`. */
  fileName: string;
  build: (opts: { headerEmail?: string }) => Promise<Blob>;
  dirty: boolean;
  /** Commit the editor before generating; resolve false if the save failed. */
  save: () => Promise<boolean>;
  /** When the underlying record last changed — drives the up-to-date chip. */
  updatedAt: number | null | undefined;
  /** Set to 'unknown' when the record has no updatedAt to compare against (the
   *  project-level punch report is assembled from rows that carry only
   *  createdAt). The chip then makes no freshness claim and Send always
   *  regenerates — a missing clock must not read as "nothing has changed". */
  staleness?: 'unknown';
  readOnly?: boolean;
  onGenerated?: (fileId: string) => void | Promise<void>;
  send?: {
    /** Non-empty disables Send and explains why. */
    blockedReason?: string;
    composer: MailComposerPrefill;
    /** Runs the item's own send route with the document just settled on.
     *  Returning the route's result lets the composer report side effects the
     *  server skipped (a status that did not move). */
    sendFn: (fileId: string, req: SendRequest) => Promise<SendResult | void>;
  };
  size?: 'sm';
  testIdPrefix?: string;
}

export const DocumentActionsBar: React.FC<DocumentActionsBarProps> = ({
  source, kind, format, projectId, fileName, build, dirty, save, updatedAt,
  staleness, readOnly = false, onGenerated, send, size, testIdPrefix = 'doc',
}) => {
  const { toast } = useToast();
  // Same peek-then-decide viewer the list rows open; it owns the modal, the
  // custom-type labels and the open-in-editor routing.
  const viewer = useDocumentViewer();
  const { file, upToDate, refresh } = useGeneratedDocument({
    sourceType: source.sourceType, sourceId: source.sourceId, kind, updatedAt,
    enabled: !!source.sourceId,
  });

  // Nothing to attach a document to yet.
  const unsaved = !source.sourceId;

  const [busy, setBusy] = useState<string | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  // Which address the LETTERHEAD shows — not who the mail is from. It lived in
  // the old composer; the shared mail composer has no idea about documents, so
  // the bar owns it and renders it through `extraHeader`.
  const [headerEmail, setHeaderEmail] = useState('');

  // "Has this been emailed before?" — the chip beside the freshness pill, and
  // the thread the composer offers to reply into.
  const itemType = itemTypeFromSource(source.sourceType);

  // The composer needs the user's mailboxes for its From select (and its
  // signature) — the chip and its "Reply in existing thread" option resolve
  // through GET /api/mail/resolve-thread instead, which the server answers
  // against this user's accounts itself, so a bar with no Send button asks for
  // no account list at all.
  const { accounts } = useMailAccounts({ enabled: !!send });
  const threads = useItemThreadLinks(itemType, source.sourceId);

  // "The linked thread got a reply nobody has acted on yet" — spec Goal 4.
  // A single-id batch: useReplyFlags already no-ops on an empty/undefined id.
  const replyFlagIds = source.sourceId ? [source.sourceId] : [];
  const replyFlags = useReplyFlags(itemType, replyFlagIds);
  const hasReplyFlag = !!source.sourceId && replyFlags.has(source.sourceId);

  // The flows below are async; a bar unmounted mid-flow must not set state.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);
  const set = useCallback(<T,>(fn: (v: T) => void, v: T) => { if (mountedRef.current) fn(v); }, []);

  const word = FORMAT_WORD[format];
  const btnSize = size === 'sm' ? 'sm' : 'md';
  const p = testIdPrefix;

  const buildAndPersist = async (headerEmail?: string): Promise<string> => {
    const blob = await build(headerEmail ? { headerEmail } : {});
    const { fileId } = await persistGeneratedDocument(blob, {
      projectId,
      kind,
      name: fileName,
      sourceType: source.sourceType,
      sourceId: source.sourceId,
    });
    // The bytes are stored by this point. If the editor's own bookkeeping
    // (proposal fileId, a parent refresh) then fails, saying "failed to
    // generate" would be a lie that sends the user off regenerating a document
    // that already exists — report the linking failure for what it is.
    if (onGenerated) {
      try {
        await onGenerated(fileId);
      } catch {
        toast(`${word} generated, but linking it to the record failed`, { type: 'warning' });
      }
    }
    await refresh();
    return fileId;
  };

  // Generate and Send share one rule: a dirty editor is committed before any
  // bytes are built, and a failed save stops the flow (spec §2).
  const saveFirst = async (): Promise<boolean> => {
    if (!dirty) return true;
    set(setBusy, 'Saving…');
    try {
      return await save();
    } catch {
      return false;
    } finally {
      set(setBusy, null);
    }
  };

  const handleGenerate = async () => {
    // Guarded by the disabled button too; belt and braces, since persisting
    // against a missing sourceId would orphan the document.
    if (busy || unsaved) return;
    if (!(await saveFirst())) {
      toast('Save failed — nothing generated', { type: 'error' });
      return;
    }

    const regenerating = !!file;
    set(setBusy, `Generating ${word}…`);
    try {
      await buildAndPersist();
      toast(regenerating ? `${word} regenerated. The previous version is kept in its history.` : `${word} generated`, { type: 'success' });
    } catch {
      toast(`Failed to generate the ${word}`, { type: 'error' });
    } finally {
      set(setBusy, null);
    }
  };

  const handleDownload = async () => {
    if (!file) return;
    set(setBusy, 'Downloading…');
    try {
      downloadBlob(await fetchFileBlob(file.id), file.name ?? fileName);
    } catch {
      toast('Download failed', { type: 'error' });
    } finally {
      set(setBusy, null);
    }
  };

  const handleOpen = () => {
    if (!file) return;
    viewer.open(file, kind, projectId);
  };

  const handleSend = async (req: SendRequest): Promise<SendResult | void> => {
    if (!send) return;
    // Read BEFORE the save: `upToDate` below is this render's value, captured
    // when the composer's onSend fired. saveFirst() moves the record past the
    // stored file, but the closure still holds the pre-save "current" — trusting
    // it would email the pre-edit PDF. A save having been needed at all is
    // enough to know the stored copy is behind.
    const wasDirty = dirty;
    // Emailing from a dirty editor would attach bytes that disagree with the
    // record, so Send commits first exactly like Generate. A failed save throws
    // the cancel sentinel, so the composer keeps the typed message on screen
    // instead of reporting a send failure.
    if (!(await saveFirst())) {
      toast('Save failed — nothing sent', { type: 'error' });
      throw new DocumentGenerationCancelled();
    }
    // Picking a different "document shows email" in the composer changes the
    // document itself, so a stored copy can't be reused even if it's current.
    const headerOverride =
      headerEmail && headerEmail !== send.composer.defaultHeaderEmail ? headerEmail : undefined;

    const reusable = !!file && upToDate && !wasDirty && staleness !== 'unknown' && !headerOverride;

    let fileId: string;
    if (reusable && file) {
      fileId = file.id;
    } else {
      set(setBusy, `Generating ${word}…`);
      try {
        fileId = await buildAndPersist(headerOverride);
      } catch (e) {
        // The composer shows whatever this rejects with, so it has to be a
        // sentence a sender can act on — a renderer's internal message
        // ("Cannot read properties of undefined") is not one.
        console.error(`Failed to build the ${kind} document for a send`, e);
        throw new Error(`Failed to generate the ${word} — nothing sent`);
      } finally {
        set(setBusy, null);
      }
    }

    set(setBusy, 'Sending…');
    let result: SendResult | void;
    try {
      result = await send.sendFn(fileId, req);
    } finally {
      set(setBusy, null);
    }
    // The send just created (or extended) a thread link — reload so the chip
    // appears without a page refresh, and so a second send is offered the
    // thread this one started.
    threads.reload();
    // The composer raises its own "Sent" toast (and warns about any item status
    // the server could not move), so the bar stays quiet here.
    return result;
  };

  // The letterhead's "from" address. The shared composer knows nothing about
  // documents, so the bar renders this select into its `extraHeader` slot and
  // keeps reading the choice from its own state.
  const headerOptions = send?.composer.headerEmailOptions ?? [];
  const headerSelect = headerOptions.length > 0 ? (
    <label className="flex flex-wrap items-center gap-2 text-xs text-ink-faint" data-testid={`${p}-header-email`}>
      <span>Document shows email:</span>
      <Select
        value={headerEmail}
        onChange={e => setHeaderEmail(e.target.value)}
        className="h-8 max-w-[18rem] text-xs"
      >
        {headerOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
      </Select>
    </label>
  ) : undefined;

  const openComposer = () => {
    setHeaderEmail(send?.composer.defaultHeaderEmail ?? '');
    setComposerOpen(true);
  };

  // Dirty is no longer a blocker — Send saves first. Only a caller-supplied
  // reason or a record with no id (nothing to attach a document to) stops it.
  const sendBlocked = send
    ? (send.blockedReason ?? (unsaved ? 'Save first' : undefined))
    : undefined;
  const generateBlocked = unsaved ? 'Save first' : undefined;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2" data-testid={`${p}-actions`}>
        <span data-testid={`${p}-status`}>
          <DocumentStatusChip file={file} upToDate={upToDate} format={format} size={size} staleness={staleness} />
        </span>

        <SentThreadChip
          link={threads.newest}
          myThread={threads.myThread}
          resolving={threads.resolving}
          data-testid={`${p}-sent-thread`}
        />

        {hasReplyFlag && <ReplyFlagChip data-testid={`${p}-reply-flag`} />}

        {!readOnly && (
          <Button
            size={btnSize}
            data-testid={`${p}-generate`}
            disabled={!!busy || !!generateBlocked}
            title={generateBlocked}
            onClick={() => { void handleGenerate(); }}
          >
            <FileText size={15} />{file ? `Regenerate ${word}` : `Generate ${word}`}
          </Button>
        )}

        {file && (
          <Button
            variant="secondary"
            size={btnSize}
            data-testid={`${p}-open`}
            disabled={!!busy}
            onClick={handleOpen}
          >
            <ExternalLink size={15} />Open
          </Button>
        )}

        {file && (
          <Button
            variant="secondary"
            size={btnSize}
            data-testid={`${p}-download`}
            disabled={!!busy}
            onClick={() => { void handleDownload(); }}
          >
            <Download size={15} />Download
          </Button>
        )}

        {!readOnly && send && (
          <Button
            variant="secondary"
            size={btnSize}
            data-testid={`${p}-send`}
            disabled={!!busy || !!sendBlocked}
            title={sendBlocked}
            onClick={openComposer}
          >
            <Mail size={15} />Email
          </Button>
        )}

        {busy && <span className="text-xs text-ink-faint" data-testid={`${p}-busy`}>{busy}</span>}
      </div>

      {send && composerOpen && (
        // Mounted only while open, so every Email click starts from the
        // editor's current defaults rather than whatever was typed and
        // abandoned last time.
        <MailComposer
          open
          variant="modal"
          accounts={accounts}
          title={send.composer.title ?? 'Send email'}
          initial={{
            to: parseAddresses(send.composer.defaultTo ?? ''),
            cc: parseAddresses(send.composer.defaultCc ?? ''),
            bcc: parseAddresses(send.composer.defaultBcc ?? ''),
            subject: send.composer.defaultSubject,
            html: textToHtml(send.composer.defaultBody),
            attachments: (send.composer.extraAttachments ?? []).map(a => ({ kind: 'file' as const, ...a })),
          }}
          // Display only: the document may not exist yet, and the bar attaches
          // the real bytes itself once it has settled which file to send.
          primaryAttachment={{ name: fileName, itemType, itemId: source.sourceId }}
          // Offered only when one of this user's own mailboxes holds the
          // thread — replying into someone else's would 404 at the server.
          existingThread={threads.myThread ? { ...threads.myThread, subject: threads.myThread.subject || fileName } : undefined}
          extraHeader={headerSelect}
          onClose={() => setComposerOpen(false)}
          onSend={handleSend}
        />
      )}

      {viewer.modal}
    </>
  );
};
