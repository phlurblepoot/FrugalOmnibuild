// src/pages/project/billing/LienReleaseEditor.tsx
// Editor for a Florida release of lien (spec docs/superpowers/specs/
// 2026-10-15-florida-lien-release-design.md §6.2). A Modal like the change
// order editor, with the shared document bar for Generate / Open / Send.
//
// A release that has not been saved yet (id '') is a draft built from the
// server's prefill: Save creates the record and hands back its id through
// `onCreated`; the document bar stays blocked ("Save first") until then.
import React, { useEffect, useMemo, useState } from 'react';
import {
  LienRelease, LienReleaseInput, LienReleasePrefill,
  saveLienRelease, createLienRelease, getLienRelease, getLienReleasePrefill, setLienReleaseStatus,
  makeLienReleaseUnconditional, sendLienRelease, getSettings, listSignatures, fetchFileBlob,
  type Signature,
} from '../../../utils/store';
import { formatMoney } from '../../../utils/money';
import { useToast } from '../../../components/Toast';
import { useConfirm } from '../../../components/ConfirmDialog';
import { Button, Checkbox, Field, Input, Modal, NumberInput, StatusPill, Textarea } from '../../../components/ui';
import { DocumentActionsBar } from '../../../components/documents/DocumentActionsBar';
import { DocumentGenerationCancelled } from '../../../components/documents/errors';
import { useCollabEditing } from '../../../hooks/useCollabEditing';
import { useItemEmailDefaults } from '../../../hooks/useItemEmailDefaults';
import { itemSendPayload } from '../../../utils/itemSend';
import { EditPresenceBanner } from '../../../components/EditPresenceBanner';
import { hexToRgb, invertImageDataUrl } from '../../../utils/documentLetterhead';
import { buildLienReleasePdf } from './lienReleasePdf';
import {
  lienReleaseTitle, lienReleaseParagraphs, lienReleaseSignatureLines, lienReleaseFileName,
  lienReleaseEmailDefaults, LIEN_ENTITY_LABELS, type LienEntityType, type Seg,
} from './lienReleaseWording';
import { useDiscardGuard } from '../../../components/ui/useDiscardGuard';

export const LIEN_STATUS_META: Record<string, { label: string; tone: 'slate' | 'blue' | 'red' }> = {
  draft: { label: 'Draft', tone: 'slate' },
  sent: { label: 'Sent', tone: 'blue' },
  void: { label: 'Void', tone: 'red' },
};

export const UNCONDITIONAL_WARNING =
  'An unconditional release takes effect when you sign and deliver it, paid or not. Send it only after the payment has cleared.';

/** A release that is not in the database yet, from the server's prefill. */
export function draftFromPrefill(projectId: string, p: LienReleasePrefill): LienRelease {
  return {
    id: '', projectId, number: null,
    paymentType: p.paymentType, conditional: p.conditional,
    sourceType: p.sourceType, sourceId: p.sourceId, supersedesId: null,
    lienorName: p.lienorName, lienorEntityType: p.lienorEntityType ?? null, lienorState: p.lienorState ?? null, customerName: p.customerName, ownerName: p.ownerName,
    propertyDescription: p.propertyDescription, amountCents: p.amountCents,
    throughDate: p.throughDate, releaseDate: p.releaseDate,
    signerName: p.signerName, signerTitle: p.signerTitle || null,
    conditionKind: p.conditionKind, checkNumber: null, checkMaker: p.checkMaker || null, checkBank: null,
    exceptions: p.exceptions || null, signatureFileId: null,
    status: 'draft', version: 0, createdAt: 0, updatedAt: 0,
  };
}

const centsOf = (dollars: string): number => Math.round((Number(dollars) || 0) * 100);
const dollarsOf = (cents: number): string => (cents ? String(cents / 100) : '');
const blank = (s: string | null | undefined) => (s ?? '').trim();

const blobToDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(reader.result as string);
  reader.onerror = reject;
  reader.readAsDataURL(blob);
});

const Runs: React.FC<{ segs: Seg[] }> = ({ segs }) => (
  <>
    {segs.map((s, i) => (
      <span key={i} className={`${s.fill ? 'underline decoration-dotted' : ''} ${s.bold ? 'font-bold' : ''}`}>{s.text}</span>
    ))}
  </>
);

const Segmented: React.FC<{
  label: string; value: string; onChange: (v: string) => void; options: { value: string; label: string }[]; disabled?: boolean;
}> = ({ label, value, onChange, options, disabled }) => (
  <div role="group" aria-label={label} className="inline-flex rounded-lg border border-edge bg-sunken p-0.5">
    {options.map(o => (
      <button
        key={o.value} type="button" disabled={disabled}
        aria-pressed={value === o.value}
        onClick={() => onChange(o.value)}
        className={`rounded-md px-3 py-1 text-sm font-medium transition-colors disabled:opacity-60 ${
          value === o.value ? 'bg-raised text-ink shadow-sm' : 'text-ink-soft hover:text-ink'
        }`}
      >
        {o.label}
      </button>
    ))}
  </div>
);

export const LienReleaseEditor: React.FC<{
  release: LienRelease;
  onClose: () => void;
  /** keepMounted: refresh the record without re-keying this editor (the
   *  document bar's save-then-generate flow dies if the modal remounts). */
  onSaved: (opts?: { keepMounted?: boolean }) => void;
  /** A draft was saved for the first time: open the stored record. */
  onCreated: (id: string) => void;
  /** Make unconditional made another release: open it. */
  onOpenOther: (id: string) => void;
  projectName: string;
  projectId: string;
  /** The pay app or invoice it starts from, when the host already has it. */
  initialSource?: LienReleasePrefill['source'];
}> = ({ release, onClose, onSaved, onCreated, onOpenOther, projectName, projectId, initialSource }) => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const isNew = release.id === '';

  const [paymentType, setPaymentType] = useState(release.paymentType);
  const [conditional, setConditional] = useState(release.conditional);
  const [lienorName, setLienorName] = useState(release.lienorName);
  const [lienorEntityType, setLienorEntityType] = useState<string>(release.lienorEntityType ?? '');
  const [lienorState, setLienorState] = useState(release.lienorState ?? '');
  const [customerName, setCustomerName] = useState(release.customerName);
  const [ownerName, setOwnerName] = useState(release.ownerName);
  const [propertyDescription, setPropertyDescription] = useState(release.propertyDescription);
  const [amount, setAmount] = useState(dollarsOf(release.amountCents));
  const [throughDate, setThroughDate] = useState(release.throughDate ?? '');
  const [releaseDate, setReleaseDate] = useState(release.releaseDate);
  const [signerName, setSignerName] = useState(release.signerName);
  const [signerTitle, setSignerTitle] = useState(release.signerTitle ?? '');
  const [checkNumber, setCheckNumber] = useState(release.checkNumber ?? '');
  const [checkMaker, setCheckMaker] = useState(release.checkMaker ?? '');
  const [checkBank, setCheckBank] = useState(release.checkBank ?? '');
  const [exceptions, setExceptions] = useState(release.exceptions ?? '');
  const [signatureFileId, setSignatureFileId] = useState(release.signatureFileId ?? '');
  const [saving, setSaving] = useState(false);

  // The pay app or invoice behind it: its label for the PDF's reference line,
  // its numbers beside the amount, and what has been paid for the safety check.
  const [source, setSource] = useState<LienReleasePrefill['source']>(initialSource ?? null);
  useEffect(() => {
    if (initialSource || !release.sourceType || !release.sourceId) return;
    let live = true;
    getLienReleasePrefill(projectId, { sourceType: release.sourceType, sourceId: release.sourceId })
      .then(p => { if (live) setSource(p.source); }).catch(() => {});
    return () => { live = false; };
  }, [initialSource, release.sourceType, release.sourceId, projectId]);

  // Offered only when the user has a saved signature (default first); off by default.
  const [signature, setSignature] = useState<Signature | null>(null);
  useEffect(() => {
    let live = true;
    listSignatures()
      .then(list => { if (live) setSignature(list.find(s => s.isDefault) ?? list[0] ?? null); })
      .catch(() => {});
    return () => { live = false; };
  }, []);

  const amountCents = centsOf(amount);
  const conditionKind: 'check' | 'funds' | null = conditional ? (blank(checkNumber) ? 'check' : 'funds') : null;

  const fields = (): LienReleaseInput => ({
    paymentType, conditional,
    sourceType: release.sourceType, sourceId: release.sourceId, supersedesId: release.supersedesId,
    lienorName: lienorName.trim(), lienorEntityType: (lienorEntityType || null) as LienEntityType | null, lienorState: blank(lienorState) || null,
    customerName: customerName.trim(), ownerName: ownerName.trim(),
    propertyDescription: propertyDescription.trim(),
    amountCents,
    throughDate: paymentType === 'progress' ? (throughDate || null) : null,
    releaseDate,
    signerName: signerName.trim(), signerTitle: blank(signerTitle) || null,
    conditionKind,
    checkNumber: conditional && blank(checkNumber) ? blank(checkNumber) : null,
    checkMaker: conditional && blank(checkNumber) ? blank(checkMaker) || null : null,
    checkBank: conditional && blank(checkNumber) ? blank(checkBank) || null : null,
    exceptions: blank(exceptions) || null,
    signatureFileId: signatureFileId || null,
  });

  // Compared as the values that get stored, so a typed "500.50" the server
  // hands back as 500.5 never reads as an edit that cannot go away.
  const asStored = (r: LienRelease): string => JSON.stringify({
    paymentType: r.paymentType, conditional: r.conditional,
    lienorName: blank(r.lienorName), lienorEntityType: r.lienorEntityType || null, lienorState: blank(r.lienorState) || null,
    customerName: blank(r.customerName), ownerName: blank(r.ownerName),
    propertyDescription: blank(r.propertyDescription), amountCents: r.amountCents,
    throughDate: r.paymentType === 'progress' ? (r.throughDate || null) : null,
    releaseDate: r.releaseDate, signerName: blank(r.signerName), signerTitle: blank(r.signerTitle) || null,
    check: r.conditional && blank(r.checkNumber) ? [blank(r.checkNumber), blank(r.checkMaker), blank(r.checkBank)] : null,
    exceptions: blank(r.exceptions) || null, signatureFileId: r.signatureFileId || null,
  });
  const current: LienRelease = {
    ...release, ...(fields() as Partial<LienRelease>),
    amountCents, conditional, paymentType,
    conditionKind,
    checkNumber: fields().checkNumber ?? null, checkMaker: fields().checkMaker ?? null, checkBank: fields().checkBank ?? null,
  } as LienRelease;
  const dirty = isNew || asStored(current) !== asStored(release);
  const requestClose = useDiscardGuard(dirty, onClose);

  const collab = useCollabEditing({
    type: 'lienRelease', id: release.id, isDirty: () => dirty, onFresh: onSaved, enabled: !isNew,
  });
  const emailDefaults = useItemEmailDefaults('invoice', projectId);
  const sendDefaults = lienReleaseEmailDefaults(current, projectName);
  const pdfFileName = lienReleaseFileName(current);

  const preview = useMemo(() => ({
    title: lienReleaseTitle(current),
    paras: lienReleaseParagraphs(current),
    sig: lienReleaseSignatureLines(current),
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [paymentType, conditional, lienorName, lienorEntityType, lienorState, customerName, ownerName, propertyDescription, amount, throughDate,
    releaseDate, signerName, signerTitle, checkNumber, checkMaker, checkBank, exceptions]);

  const handleSave = async (opts?: { keepMounted?: boolean }) => {
    setSaving(true);
    try {
      if (isNew) {
        const made = await createLienRelease(projectId, fields());
        toast(`Release LR-${made.number} saved`, { type: 'success' });
        onCreated(made.id);
        return;
      }
      await saveLienRelease(release.id, {
        ...fields(),
        version: collab.keepMineVersion !== null ? collab.keepMineVersion : release.version,
      });
      toast('Release saved', { type: 'success' });
      onSaved({ keepMounted: opts?.keepMounted === true && collab.keepMineVersion === null });
    } catch (e) {
      const conflict = e instanceof Error && e.name === 'ConflictError';
      toast(conflict ? 'Release changed elsewhere — reopen it' : (e instanceof Error && e.message) || 'Save failed', { type: 'error' });
      throw e;
    } finally {
      setSaving(false);
    }
  };
  const saveForDocument = async (): Promise<boolean> => {
    try { await handleSave({ keepMounted: true }); return true; } catch { return false; }
  };

  // Spec §6.3: giving up lien rights before the money is recorded is the one
  // mistake this form can make that cannot be taken back.
  const confirmUnconditional = async (saved: LienRelease): Promise<boolean> => {
    if (saved.conditional) return true;
    const covered = source ? source.paidCents >= saved.amountCents : false;
    if (covered) return true;
    const where = source ? source.label : 'this release';
    return confirm({
      title: 'No payment recorded',
      message: `No payment covering ${formatMoney(saved.amountCents)} is recorded for ${where}. Send an unconditional release anyway?`,
      confirmLabel: 'Send anyway', tone: 'danger',
    });
  };

  // Built from the SAVED record, never the typed-in draft (the bar commits
  // first), so the PDF and the record it represents cannot drift apart.
  const buildBytes = async (headerEmail?: string): Promise<Uint8Array | ArrayBuffer> => {
    const saved = await getLienRelease(release.id);
    if (!saved) throw new Error('Lien release not found');
    if (!(await confirmUnconditional(saved))) throw new DocumentGenerationCancelled();
    const settings = await getSettings();
    let logoDataUrl: string | undefined;
    const logoUrl = settings.logoUrl;
    if (logoUrl) {
      if (logoUrl.startsWith('data:')) logoDataUrl = logoUrl;
      else {
        try { logoDataUrl = await blobToDataUrl(await (await fetch(logoUrl)).blob()); } catch { /* skip logo on fetch error */ }
      }
    }
    if (logoDataUrl && settings.invertLogoOnDocuments === 'true') logoDataUrl = await invertImageDataUrl(logoDataUrl);
    let signatureDataUrl: string | undefined;
    if (saved.signatureFileId) {
      try { signatureDataUrl = await blobToDataUrl(await fetchFileBlob(saved.signatureFileId)); } catch { /* print the blank line */ }
    }
    return buildLienReleasePdf({
      release: saved,
      projectName,
      sourceLabel: source?.label ?? null,
      letterhead: {
        brandRgb: hexToRgb(settings.companyBrandColor || '#99CB38'),
        company: {
          name: settings.companyName || settings.appName,
          phone: settings.companyPhone, email: settings.companyEmail, address: settings.companyAddress,
        },
        logoDataUrl,
      },
      signatureDataUrl,
      headerEmail: headerEmail || undefined,
    });
  };

  const changeStatus = async (status: 'void' | 'draft') => {
    if (status === 'void' && !(await confirm({
      title: 'Void this release?',
      message: 'The record and its document are kept. Mark it void so nobody relies on it.',
      confirmLabel: 'Void', tone: 'danger',
    }))) return;
    try { await setLienReleaseStatus(release.id, status); onSaved(); } catch (e) { toast((e instanceof Error && e.message) || 'Status update failed', { type: 'error' }); }
  };

  const makeUnconditional = async () => {
    if (dirty && !(await saveForDocument())) return;
    try {
      const made = await makeLienReleaseUnconditional(release.id);
      toast(`Unconditional release LR-${made.number} made`, { type: 'success' });
      onOpenOther(made.id);
    } catch (e) { toast((e instanceof Error && e.message) || 'Could not make the release unconditional', { type: 'error' }); }
  };

  const statusMeta = LIEN_STATUS_META[release.status] ?? LIEN_STATUS_META.draft;
  const title = isNew ? 'New release of lien' : `Release of lien LR-${release.number ?? ''}`;

  return (
    <Modal open onClose={onClose} dirty={dirty} title={title} width="lg"
      footer={<>
        <div className="mr-auto">
          <DocumentActionsBar
            source={{ sourceType: 'lien-release', sourceId: isNew ? undefined : release.id }}
            kind="lien-release"
            format="pdf"
            projectId={projectId}
            fileName={pdfFileName}
            build={async ({ headerEmail }) => new Blob([await buildBytes(headerEmail)], { type: 'application/pdf' })}
            dirty={dirty}
            save={saveForDocument}
            updatedAt={release.updatedAt}
            size="sm"
            send={{
              blockedReason: emailDefaults.sendBlockedReason,
              composer: {
                title: 'Send release of lien',
                defaultTo: emailDefaults.defaultTo || undefined,
                defaultCc: emailDefaults.defaultCc || undefined,
                defaultBcc: emailDefaults.defaultBcc || undefined,
                defaultSubject: sendDefaults.subject,
                defaultBody: `Hello,\n\n${sendDefaults.body}\n\nThank you.`,
                headerEmailOptions: emailDefaults.headerEmailOptions.length ? emailDefaults.headerEmailOptions : undefined,
                defaultHeaderEmail: emailDefaults.companyEmail || undefined,
              },
              sendFn: async (fileId, req) => {
                const result = await sendLienRelease(release.id, { ...itemSendPayload(req), fileId });
                // The send moves a draft to 'sent' server-side.
                onSaved({ keepMounted: true });
                return result;
              },
            }}
          />
        </div>
        <Button variant="secondary" onClick={() => void requestClose()}>Close</Button>
        <Button onClick={() => { void handleSave().catch(() => {}); }} disabled={saving}>{saving ? 'Saving…' : 'Save release'}</Button>
      </>}
    >
      {!isNew && <EditPresenceBanner state={collab} />}

      <div className="mb-3 flex flex-wrap items-center gap-2">
        {!isNew && <StatusPill tone={statusMeta.tone}>{statusMeta.label}</StatusPill>}
        {!isNew && release.status !== 'void' && (
          <Button variant="ghost" size="sm" onClick={() => void changeStatus('void')}>Void</Button>
        )}
        {!isNew && release.status === 'void' && (
          <Button variant="ghost" size="sm" onClick={() => void changeStatus('draft')}>Restore to draft</Button>
        )}
        {!isNew && release.conditional && (
          <Button variant="ghost" size="sm" onClick={() => void makeUnconditional()}>Make unconditional</Button>
        )}
        {source && <span className="text-xs text-ink-faint">From {source.label}</span>}
      </div>

      <div className="mb-3 flex flex-wrap gap-3">
        <Segmented label="Payment" value={paymentType} onChange={v => setPaymentType(v as 'progress' | 'final')}
          options={[{ value: 'progress', label: 'Progress' }, { value: 'final', label: 'Final' }]} />
        <Segmented label="Condition" value={conditional ? 'conditional' : 'unconditional'} onChange={v => setConditional(v === 'conditional')}
          options={[{ value: 'conditional', label: 'Conditional' }, { value: 'unconditional', label: 'Unconditional' }]} />
      </div>

      {!conditional && (
        <div role="alert" data-testid="lien-unconditional-warning"
          className="mb-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-400/20 dark:bg-amber-400/10 dark:text-amber-300">
          {UNCONDITIONAL_WARNING}
        </div>
      )}

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Lienor (your company)" htmlFor="lr-lienor"><Input id="lr-lienor" value={lienorName} onChange={e => setLienorName(e.target.value)} /></Field>
        <Field label="Entity type" htmlFor="lr-entity" hint="Printed in the notary sentence.">
          <select id="lr-entity" value={lienorEntityType} onChange={e => setLienorEntityType(e.target.value)}
            className="w-full rounded-lg border border-edge bg-raised px-3 py-2 text-sm text-ink">
            <option value="">(leave blank)</option>
            {(Object.keys(LIEN_ENTITY_LABELS) as LienEntityType[]).map(k => <option key={k} value={k}>{LIEN_ENTITY_LABELS[k]}</option>)}
          </select>
        </Field>
        <Field label="State of formation" htmlFor="lr-state"><Input id="lr-state" value={lienorState} onChange={e => setLienorState(e.target.value)} placeholder="e.g. Florida" /></Field>
        <Field label="Customer" htmlFor="lr-customer"><Input id="lr-customer" value={customerName} onChange={e => setCustomerName(e.target.value)} /></Field>
        <Field label="Property owner" htmlFor="lr-owner"><Input id="lr-owner" value={ownerName} onChange={e => setOwnerName(e.target.value)} /></Field>
        <Field label="Amount"
          htmlFor="lr-amount"
          hint={source ? `${source.label}: billed ${formatMoney(source.totalCents)}, paid ${formatMoney(source.paidCents)}, balance ${formatMoney(source.balanceCents)}${source.contractSumToDateCents !== undefined ? `, contract sum to date ${formatMoney(source.contractSumToDateCents)}` : ''}` : undefined}>
          <NumberInput id="lr-amount" value={amount} onChange={e => setAmount(e.target.value)} placeholder="0.00" />
        </Field>
      </div>

      <div className="mt-3">
        <Field label="Property" htmlFor="lr-property"><Textarea id="lr-property" rows={3} value={propertyDescription} onChange={e => setPropertyDescription(e.target.value)} /></Field>
      </div>

      <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-2">
        {paymentType === 'progress' && (
          <Field label="Through date" htmlFor="lr-through" hint="Work up to this date. Retainage is never covered by a progress release.">
            <Input id="lr-through" type="date" value={throughDate} onChange={e => setThroughDate(e.target.value)} />
          </Field>
        )}
        <Field label="Release date" htmlFor="lr-date"><Input id="lr-date" type="date" value={releaseDate} onChange={e => setReleaseDate(e.target.value)} /></Field>
        <Field label="Signer name" htmlFor="lr-signer"><Input id="lr-signer" value={signerName} onChange={e => setSignerName(e.target.value)} /></Field>
        <Field label="Signer title" htmlFor="lr-title"><Input id="lr-title" value={signerTitle} onChange={e => setSignerTitle(e.target.value)} placeholder="e.g. Owner" /></Field>
      </div>

      {conditional && (
        <div className="mt-3 rounded-lg border border-edge p-3" data-testid="lien-condition-box">
          <div className="mb-2 text-sm font-semibold text-ink">Paid by check?</div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Field label="Check number" htmlFor="lr-check-no" hint="Leave empty for the receipt-of-funds wording.">
              <Input id="lr-check-no" value={checkNumber} onChange={e => setCheckNumber(e.target.value)} />
            </Field>
            <Field label="Drawn by" htmlFor="lr-check-maker"><Input id="lr-check-maker" value={checkMaker} onChange={e => setCheckMaker(e.target.value)} disabled={!blank(checkNumber)} /></Field>
            <Field label="Bank (optional)" htmlFor="lr-check-bank"><Input id="lr-check-bank" value={checkBank} onChange={e => setCheckBank(e.target.value)} disabled={!blank(checkNumber)} /></Field>
          </div>
        </div>
      )}

      <div className="mt-3">
        <Field label="Exceptions (optional)" htmlFor="lr-exceptions"
          hint="Optional. Adding exceptions changes the statutory form; your customer may ask for the standard form.">
          <Textarea id="lr-exceptions" rows={2} value={exceptions} onChange={e => setExceptions(e.target.value)} />
        </Field>
      </div>

      {signature && (
        <div className="mt-3">
          <Checkbox label="Sign with my signature" checked={!!signatureFileId}
            onChange={e => setSignatureFileId(e.target.checked ? signature.id : '')} />
        </div>
      )}

      <div className="mt-4 rounded-lg border border-edge bg-sunken p-4 text-sm text-ink" data-testid="lien-preview">
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">Preview</div>
        <div className="mb-3 text-center font-bold">
          {preview.title.map((t, i) => <div key={i}>{t}</div>)}
        </div>
        <div className="space-y-3">
          {preview.paras.map((p, i) => (
            <p key={i} className="whitespace-pre-line"><Runs segs={p.segs} /></p>
          ))}
        </div>
        <div className="mt-4">
          <div>{preview.sig.company}</div>
          <div className="mt-3">{preview.sig.by} ______________________________</div>
          <div>{preview.sig.signer}</div>
        </div>
        <p className="mt-3 text-xs text-ink-faint">A notary acknowledgment prints below the signature.</p>
      </div>
    </Modal>
  );
};
