// src/pages/project/rfi/RfiEditor.tsx
import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Rfi, saveRfi, getRfi, setRfiStatus, addRfiPhoto, removeRfiPhoto, setRfiResponse, acceptRfiPendingReply, sendRfi, getSettings, fetchFileBlob, getAssignableUsers, type AssignableUser,
  addRfiAttachment, updateRfiAttachment, removeRfiAttachment,
} from '../../../utils/store';
import { useToast } from '../../../components/Toast';
import { Button, Field, Input, Modal, Select, Textarea } from '../../../components/ui';
import { DocumentActionsBar } from '../../../components/documents/DocumentActionsBar';
import { AddFilesButton } from '../../../components/documents/AddFilesButton';
import { PhotoDropCard } from '../../../components/documents/PhotoDropCard';
import { PdfAttachmentsCard } from '../../../components/documents/PdfAttachmentsCard';
import { useCollabEditing } from '../../../hooks/useCollabEditing';
import { useItemEmailDefaults } from '../../../hooks/useItemEmailDefaults';
import { itemSendPayload } from '../../../utils/itemSend';
import { EditPresenceBanner } from '../../../components/EditPresenceBanner';
import { RfiStatusPill, RFI_STATUS_META } from '../../../components/ui/RfiStatusPill';
import { PendingReplyBanner } from './PendingReplyBanner';
import { useMailAccounts } from '../../mail/useMailAccounts';
import { useItemThreadLinks } from '../../../hooks/useItemThreadLinks';
import { buildRfiPdf } from './rfiPdf';
import { appendAttachedPdfs } from '../../../utils/pdfAttachments';
import { hexToRgb, invertImageDataUrl } from '../../../utils/documentLetterhead';
import { useDiscardGuard } from '../../../components/ui/useDiscardGuard';

export const RfiEditor: React.FC<{
  rfi: Rfi;
  projectId: string;
  projectName: string;
  contractor?: string | null;
  onClose: () => void;
  /** keepMounted: refresh the record without re-keying this editor — the
   *  document bar's save-then-generate flow dies if the modal remounts
   *  underneath it. */
  onSaved: (opts?: { keepMounted?: boolean }) => void;
}> = ({ rfi, projectId, projectName, contractor, onClose, onSaved }) => {
  const { toast } = useToast();
  const [title, setTitle] = useState(rfi.title ?? '');
  const [question, setQuestion] = useState(rfi.question ?? '');
  const [specRef, setSpecRef] = useState(rfi.specRef ?? '');
  const [drawingRef, setDrawingRef] = useState(rfi.drawingRef ?? '');
  const [attention, setAttention] = useState(rfi.attention ?? '');
  const [responseNeededBy, setResponseNeededBy] = useState(rfi.responseNeededBy ?? '');
  const [responseDraft, setResponseDraft] = useState(rfi.responseText ?? '');
  // Internal only (never on the RFI document): who on the team owns it. They
  // hear about it in the bell, and again when the GC answers.
  const [assigneeUserId, setAssigneeUserId] = useState<string | null>(rfi.assigneeUserId ?? null);
  const [users, setUsers] = useState<AssignableUser[]>([]);
  useEffect(() => {
    getAssignableUsers().then(setUsers).catch(() => setUsers([]));
  }, []);
  const [saving, setSaving] = useState(false);
  // Set when the draft below came from the emailed reply: the same Save then
  // routes to the accept endpoint, so accepting the reply and editing its text
  // stay one action (and the pending reply is never left behind).
  const [acceptFromEmail, setAcceptFromEmail] = useState(false);
  const navigate = useNavigate();

  // An emailed reply waiting for review. Gated on the status as well as the
  // row: a pendingReply can outlive an out-of-band status change.
  const pending = rfi.status === 'sent' ? rfi.pendingReply ?? null : null;

  // Can THIS user open the conversation? pendingReply.accountId is the
  // receiving user's mailbox, and the mail routes 403/404 for anyone else. The
  // cheap exact answer is "do I own that mailbox"; useItemThreadLinks.myThread
  // (GET /api/mail/resolve-thread) is the fallback for a thread that also sits
  // in another of my mailboxes, or under a different threadKey there.
  const { accounts } = useMailAccounts({ enabled: !!pending });
  const threads = useItemThreadLinks(pending ? 'rfi' : undefined, pending ? rfi.id : undefined);
  const ownedAccountId = pending && accounts.some(a => a.id === pending.accountId) ? pending.accountId : null;
  const threadAccountId = ownedAccountId
    ?? (pending && threads.myThread?.threadKey === pending.threadKey ? threads.myThread.accountId : null);
  const openPendingThread = () => {
    if (!pending || !threadAccountId) return;
    // `_` is the mail page's "no folder filter" — a link records the thread,
    // not the folder it was filed in.
    navigate(`/mail/${encodeURIComponent(threadAccountId)}/_/${encodeURIComponent(pending.threadKey)}`);
  };

  const padded = String(rfi.number).padStart(3, '0');
  // One name for the stored document and the email attachment — they upsert
  // onto the same document row, so a differing name would flip the stored name
  // depending on which ran last.
  const pdfFileName = `RFI-${padded}.pdf`;

  // A typed-but-unsaved response counts as dirty too, so a remount-triggering
  // action (status change, photo upload, response-file attach) never silently
  // discards it.
  const responseDirty = responseDraft.trim() !== (rfi.responseText ?? '');

  const isDirty = () =>
    title.trim() !== (rfi.title ?? '') ||
    question !== (rfi.question ?? '') ||
    specRef !== (rfi.specRef ?? '') ||
    drawingRef !== (rfi.drawingRef ?? '') ||
    attention !== (rfi.attention ?? '') ||
    (responseNeededBy || '') !== (rfi.responseNeededBy ?? '') ||
    assigneeUserId !== (rfi.assigneeUserId ?? null) ||
    responseDirty;

  const dirty = isDirty();
  const requestClose = useDiscardGuard(dirty, onClose);

  const collab = useCollabEditing({
    type: 'rfi',
    id: rfi.id,
    isDirty,
    onFresh: onSaved,
  });

  // Email defaults: resolved recipient, always-CC, header-email options.
  const emailDefaults = useItemEmailDefaults('rfi', projectId);

  const dropPhoto = async (fileId: string) => {
    try { await removeRfiPhoto(rfi.id, fileId); onSaved(); } catch { toast('Failed to remove photo', { type: 'error' }); }
  };

  // The answer can be a document that already lives in the app (the architect
  // emailed a sketch that was filed elsewhere) as much as a fresh upload, so
  // this is the shared picker rather than a bare file input. Attaching bumps
  // the RFI's version, which re-keys this editor — hence the save-first gate.
  const attachResponse = async (fileId: string) => {
    try {
      await setRfiResponse(rfi.id, { fileId });
      toast('Response attached', { type: 'success' });
      onSaved();
    } catch { toast('Failed to attach response', { type: 'error' }); }
  };

  // One writer for the response text so every path (this button, the main
  // Save) agrees on WHICH endpoint records it: accepting the emailed reply also
  // clears the pending row and stamps the response as email-sourced, so a
  // plain setRfiResponse here would leave the banner up over a recorded answer.
  const persistResponseText = async (text: string) => {
    if (!acceptFromEmail) { await setRfiResponse(rfi.id, { text }); return; }
    try {
      await acceptRfiPendingReply(rfi.id, { text });
    } catch (e) {
      if (!(e instanceof Error && e.name === 'NoPendingReplyError')) throw e;
      // Someone else accepted or dismissed the reply while this draft was open.
      // The text on screen is still what the user means to record, and there is
      // no pending row left to clear — so record it the ordinary way rather
      // than making them retype it into a failed save.
      toast('That email reply was already handled — saving your text as the response', { type: 'warning' });
      await setRfiResponse(rfi.id, { text });
    }
    setAcceptFromEmail(false);
  };

  const saveResponseText = async () => {
    try { await persistResponseText(responseDraft.trim()); toast('Response saved', { type: 'success' }); onSaved(); }
    catch {
      toast('Failed to save response', { type: 'error' });
      // Refresh the record without remounting: the typed draft is the only copy
      // of the user's work, and a re-key would reinitialise it from the server.
      onSaved({ keepMounted: true });
    }
  };
  const downloadResponseFile = async () => {
    if (!rfi.responseFileId) return;
    try {
      const blob = await fetchFileBlob(rfi.responseFileId);
      const ext = blob.type === 'application/pdf' ? '.pdf' : blob.type === 'image/jpeg' ? '.jpg' : blob.type === 'image/png' ? '.png' : '';
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a'); a.href = url; a.download = `RFI-${padded}-response${ext}`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch { toast('Failed to download response', { type: 'error' }); }
  };

  // Built from the SAVED RFI, never the typed-in draft: the bar commits first,
  // so re-reading the record here is what keeps a generated PDF and the RFI it
  // claims to represent from drifting apart (photos included). A failed
  // re-read throws on purpose — the bar then reports the failure and keeps the
  // existing document, rather than quietly storing pre-save bytes and marking
  // them current.
  const buildRfiBytes = async (headerEmail?: string): Promise<Uint8Array | ArrayBuffer> => {
    const saved = await getRfi(rfi.id);
    if (!saved) throw new Error('RFI not found');
    const settings = await getSettings();
    let logoDataUrl: string | undefined = settings.logoUrl || undefined;
    if (logoDataUrl && !logoDataUrl.startsWith('data:')) {
      const blob = await (await fetch(logoDataUrl)).blob();
      logoDataUrl = await new Promise<string>(r => { const fr = new FileReader(); fr.onload = () => r(fr.result as string); fr.readAsDataURL(blob); });
    }
    if (logoDataUrl && settings.invertLogoOnDocuments === 'true') {
      logoDataUrl = await invertImageDataUrl(logoDataUrl);
    }
    // fetch each photo as a dataURL (authenticated content endpoint)
    const photoDataUrls: string[] = [];
    for (const p of saved.photos) {
      try {
        const blob = await fetchFileBlob(p.fileId);
        photoDataUrls.push(await new Promise<string>(r => { const fr = new FileReader(); fr.onload = () => r(fr.result as string); fr.readAsDataURL(blob); }));
      } catch { /* skip */ }
    }
    const bytes = buildRfiPdf({
      rfi: saved,
      projectName: projectName,
      contractor: contractor,
      photoDataUrls,
      letterhead: {
        brandRgb: hexToRgb(settings.companyBrandColor || '#99CB38'),
        company: {
          name: settings.companyName || settings.appName,
          phone: settings.companyPhone,
          email: settings.companyEmail,
          address: settings.companyAddress,
        },
        logoDataUrl,
      },
      headerEmail: headerEmail || undefined,
    });
    // Attached PDFs go last, after the photo pages, in attachment order.
    return appendAttachedPdfs(bytes, saved.attachments);
  };

  const handleSave = async (opts?: { keepMounted?: boolean }) => {
    // Thrown rather than returned so the document bar's save-first step can
    // tell a refused save from a successful one.
    if (!title.trim()) { toast('A title is required', { type: 'warning' }); throw new Error('A title is required'); }
    setSaving(true);
    // Set when the response text could not be stored: the draft is then the
    // only copy of it, so the refresh below must not re-key this editor.
    let keepDraft = false;
    try {
      await saveRfi(rfi.id, {
        ...rfi,
        ...(collab.keepMineVersion !== null ? { version: collab.keepMineVersion } : {}),
        title: title.trim(), question: question || null, specRef: specRef || null, drawingRef: drawingRef || null, attention: attention || null, responseNeededBy: responseNeededBy || null,
        assigneeUserId,
      });
      // Save also persists a typed-but-unsaved response, so switching status,
      // uploading a photo, etc. right after Save never loses the draft.
      if (responseDirty && responseDraft.trim()) {
        try {
          await persistResponseText(responseDraft.trim());
        } catch {
          // The RFI itself saved — only the response write failed. Calling the
          // whole thing a failure would send the user back to redo work that is
          // already stored, so report the part that didn't land and keep the
          // draft on screen.
          toast('The RFI saved, but the response text did not', { type: 'warning' });
          keepDraft = true;
        }
      }
      toast('RFI saved', { type: 'success' });
      // A "Keep mine" save adopted a foreign version number; only a remount
      // clears it, otherwise the next save would post a stale version.
      onSaved({ keepMounted: (opts?.keepMounted === true || keepDraft) && collab.keepMineVersion === null });
    } catch (e) {
      toast(e instanceof Error && e.name === 'ConflictError' ? 'RFI changed elsewhere — reopen it' : 'Save failed', { type: 'error' });
      throw e;
    } finally { setSaving(false); }
  };

  // The bar saves before it generates, so `false` here means "don't build".
  const saveForDocument = async (): Promise<boolean> => {
    try { await handleSave({ keepMounted: true }); return true; } catch { return false; }
  };

  const cycleStatus = async () => {
    if (isDirty()) {
      toast('Save your changes before changing status', { type: 'warning' });
      return;
    }
    const next = rfi.status === 'open' ? 'sent' : rfi.status === 'sent' ? 'answered' : rfi.status === 'answered' ? 'closed' : 'open';
    try { await setRfiStatus(rfi.id, next); onSaved(); } catch { toast('Status update failed', { type: 'error' }); }
  };

  return (
    <Modal open onClose={onClose} dirty={dirty} title={`RFI-${padded}`} width="lg"
      footer={<>
        <div className="mr-auto">
          <DocumentActionsBar
            source={{ sourceType: 'rfi', sourceId: rfi.id }}
            kind="rfi"
            format="pdf"
            projectId={projectId}
            fileName={pdfFileName}
            build={async ({ headerEmail }) => new Blob([await buildRfiBytes(headerEmail)], { type: 'application/pdf' })}
            dirty={dirty}
            save={saveForDocument}
            updatedAt={rfi.updatedAt}
            size="sm"
            send={{
              blockedReason: emailDefaults.sendBlockedReason,
              composer: {
                title: 'Send RFI',
                defaultTo: emailDefaults.defaultTo || undefined,
                defaultCc: emailDefaults.defaultCc || undefined,
                defaultBcc: emailDefaults.defaultBcc || undefined,
                defaultSubject: `RFI RFI-${padded} — ${projectName}`,
                defaultBody: `Hello,\n\nPlease find attached RFI-${padded}${rfi.title ? ' — ' + rfi.title : ''} for ${projectName}.\n\nPlease respond${rfi.responseNeededBy ? ` by ${rfi.responseNeededBy}` : ' at your earliest convenience'}.\n\nThank you.`,
                headerEmailOptions: emailDefaults.headerEmailOptions.length ? emailDefaults.headerEmailOptions : undefined,
                defaultHeaderEmail: emailDefaults.companyEmail || undefined,
              },
              sendFn: async (fileId, req) => {
                const result = await sendRfi(rfi.id, { ...itemSendPayload(req), fileId });
                // The send stamps the RFI 'sent' server-side.
                onSaved({ keepMounted: true });
                return result;
              },
            }}
          />
        </div>
        <Button variant="secondary" onClick={() => void requestClose()}>Close</Button>
        <Button onClick={() => { void handleSave().catch(() => {}); }} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
      </>}
    >
      <EditPresenceBanner state={collab} />
      {pending && (
        <PendingReplyBanner
          rfi={rfi}
          projectId={projectId}
          canOpenThread={!!threadAccountId}
          // Narrower than canOpenThread on purpose: the attachment save reads
          // the message out of pendingReply.accountId specifically, so the
          // thread-link fallback mailbox above does not qualify.
          ownsMailbox={!!ownedAccountId}
          onOpenThread={openPendingThread}
          onUseAsResponse={text => { setResponseDraft(text); setAcceptFromEmail(true); }}
          // The draft only counts as "this reply's text" once Use as response
          // put it there — otherwise the banner would attribute a hand-typed
          // note to the email.
          draftText={acceptFromEmail ? responseDraft : null}
          // keepMounted: both refreshes only change fields this editor reads
          // from props (pendingReply, responseFileId, status) — remounting
          // would throw away anything typed into the form first.
          onDismissed={() => onSaved({ keepMounted: true })}
          // The banner accepted on our behalf (text + file in one call), so the
          // pending row is gone and this editor must stop trying to accept.
          onAccepted={() => { setAcceptFromEmail(false); onSaved({ keepMounted: true }); }}
        />
      )}
      <div className="mb-3 flex items-center gap-2">
        <button onClick={cycleStatus} title="Click to advance status"><RfiStatusPill status={rfi.status} /></button>
        <span className="text-xs text-ink-faint">{Object.values(RFI_STATUS_META).map(m => m.label).join(' → ')}</span>
      </div>
      <Field label="Title" htmlFor="rfi-title"><Input id="rfi-title" value={title} onChange={e => setTitle(e.target.value)} /></Field>
      <div className="mt-3">
        <Field label="Question" htmlFor="rfi-question"><Textarea id="rfi-question" value={question} onChange={e => setQuestion(e.target.value)} rows={4} /></Field>
      </div>
      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Attention" htmlFor="rfi-att"><Input id="rfi-att" value={attention} onChange={e => setAttention(e.target.value)} placeholder="e.g. GC project manager" /></Field>
        <Field label="Response needed by" htmlFor="rfi-due"><Input id="rfi-due" type="date" value={responseNeededBy} onChange={e => setResponseNeededBy(e.target.value)} /></Field>
        <Field label="Spec reference" htmlFor="rfi-spec"><Input id="rfi-spec" value={specRef} onChange={e => setSpecRef(e.target.value)} placeholder="e.g. 09 24 00" /></Field>
        <Field label="Drawing reference" htmlFor="rfi-dwg"><Input id="rfi-dwg" value={drawingRef} onChange={e => setDrawingRef(e.target.value)} placeholder="e.g. A-501" /></Field>
        <Field label="Assigned to" htmlFor="rfi-assignee" hint="Internal, not on the RFI. Notified when assigned and when the GC answers.">
          <Select id="rfi-assignee" value={assigneeUserId ?? ''} onChange={e => setAssigneeUserId(e.target.value || null)}>
            <option value="">Unassigned</option>
            {/* Keep a since-deleted or unlisted assignee selectable rather than silently clearing it. */}
            {assigneeUserId && !users.some(u => u.id === assigneeUserId) && <option value={assigneeUserId}>Former user</option>}
            {users.map(u => <option key={u.id} value={u.id}>{u.username}</option>)}
          </Select>
        </Field>
      </div>
      {/* Adding a photo bumps the RFI's version, which re-keys this editor —
          hence the same save-first gate the response attachment uses. */}
      <PhotoDropCard
        title="Photos"
        emptyText="No photos. Add before/during/after shots from the field."
        testId="rfi"
        photos={rfi.photos}
        upload={{ kind: 'rfi-photo', projectId, sourceType: 'rfi', sourceId: rfi.id }}
        initialProjectIds={[projectId]}
        link={fileId => addRfiPhoto(rfi.id, fileId)}
        onRemove={dropPhoto}
        onDone={onSaved}
        disabled={dirty}
        disabledMessage="Save your changes first"
      />
      {/* PDFs appended to the RFI document — not the GC's answer, which is
          the Response below. Same save-first gate as the photos. */}
      <PdfAttachmentsCard
        attachments={rfi.attachments}
        projectId={projectId}
        documentName="RFI"
        testId="rfi"
        link={fileId => addRfiAttachment(rfi.id, fileId)}
        update={(fileId, patch) => updateRfiAttachment(rfi.id, fileId, patch)}
        remove={fileId => removeRfiAttachment(rfi.id, fileId)}
        onChanged={onSaved}
        disabled={dirty}
        disabledMessage="Save your changes first"
      />
      <div className="mt-4 border-t border-edge pt-3">
        <div className="mb-2 flex items-center justify-between">
          <h4 className="text-sm font-semibold text-ink">Response</h4>
          <AddFilesButton
            label="Attach response"
            accept="any"
            multi={false}
            defaultTab="upload"
            size="sm"
            disabled={dirty}
            title={dirty ? 'Save your changes first' : undefined}
            upload={{ kind: 'rfi-response', projectId, sourceType: 'rfi', sourceId: rfi.id }}
            onPick={rows => { if (rows.length) void attachResponse(rows[0].id); }}
          />
        </div>
        {rfi.answeredAt && <p className="mb-2 text-xs text-ink-faint">Answered {new Date(rfi.answeredAt).toLocaleDateString()}</p>}
        {rfi.responseFileId && (
          <p className="mb-2 text-xs">
            <button className="text-accent underline" onClick={downloadResponseFile}>Download response document</button>
          </p>
        )}
        <Field label="Response text (for non-PDF answers)" htmlFor="rfi-resp">
          <Textarea id="rfi-resp" value={responseDraft} onChange={e => setResponseDraft(e.target.value)} rows={3} />
        </Field>
        <div className="mt-2">
          <Button variant="secondary" size="sm" onClick={saveResponseText} disabled={!responseDraft.trim() || responseDraft.trim() === (rfi.responseText ?? '')}>Save response text</Button>
        </div>
      </div>
    </Modal>
  );
};
