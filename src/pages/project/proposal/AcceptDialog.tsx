// src/pages/project/proposal/AcceptDialog.tsx
// Accepting a proposal is the hand-off from estimating to billing, so the
// dialog does the two things that always follow: file the customer's signed
// copy, and seed the schedule of values from what was quoted.
import React, { useEffect, useRef, useState } from 'react';
import { Check, FileUp, FolderOpen, X } from 'lucide-react';
import { Button, Checkbox, Modal, Skeleton } from '../../../components/ui';
import { FilePickerModal } from '../../../components/FilePickerModal';
import { useToast } from '../../../components/Toast';
import type { DocumentRow, ProposalSummary } from '../../../utils/store';
import { getProposal, uploadProjectFile } from '../../../utils/store';
import { proposalLabel } from './proposalPresentation';

export const AcceptDialog: React.FC<{
  open: boolean;
  proposal: ProposalSummary | null;
  projectId: string;
  onClose: () => void;
  onConfirm: (o: { signedFileId: string | null; prefillSov: boolean }) => Promise<void>;
}> = ({ open, proposal, projectId, onClose, onConfirm }) => {
  const { toast } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const [signed, setSigned] = useState<{ id: string; name: string } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [picking, setPicking] = useState(false);
  const [lineCount, setLineCount] = useState<number | null>(null);
  const [prefillSov, setPrefillSov] = useState(true);
  const [busy, setBusy] = useState(false);

  // The count of billable (non-alternate) lines drives the SOV wording, so it
  // is fetched per open; a stale-response guard keeps a slow fetch for a
  // previously opened proposal from overwriting the current one's count.
  useEffect(() => {
    if (!open || !proposal) return;
    setSigned(null);
    setPrefillSov(true);
    setBusy(false);
    setLineCount(null);
    let live = true;
    getProposal(proposal.id)
      .then(full => { if (live) setLineCount(full.lines.filter(l => !l.isAlternate).length); })
      .catch(() => { if (live) setLineCount(0); });
    return () => { live = false; };
  }, [open, proposal?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !proposal) return;
    setUploading(true);
    try {
      const { fileId } = await uploadProjectFile(projectId, file, 'proposal-signed', {
        sourceType: 'proposal', sourceId: proposal.id,
      });
      setSigned({ id: fileId, name: file.name });
    } catch {
      toast('Upload failed', { type: 'error' });
    } finally {
      setUploading(false);
    }
  };

  const onPick = (rows: DocumentRow[]) => {
    const row = rows[0];
    if (row) setSigned({ id: row.id, name: row.name || 'Signed copy' });
    setPicking(false);
  };

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      await onConfirm({ signedFileId: signed?.id ?? null, prefillSov: prefillSov && !!lineCount });
    } finally {
      setBusy(false);
    }
  };

  const disabled = busy || uploading;

  return (
    <>
      <Modal
        open={open}
        onClose={disabled ? () => {} : onClose}
        title={`Mark ${proposal ? proposalLabel(proposal) : 'proposal'} accepted`}
        footer={
          <>
            <Button variant="secondary" onClick={onClose} disabled={disabled}>Cancel</Button>
            <Button onClick={confirm} disabled={disabled} data-testid="confirm-accept">
              <Check size={14} />{busy ? 'Saving…' : 'Mark accepted'}
            </Button>
          </>
        }
      >
        <section className="mb-5">
          <h4 className="mb-1 text-sm font-semibold text-ink">Signed copy</h4>
          <p className="mb-3 text-sm text-ink-faint">
            Optional. Attach the countersigned PDF the customer returned so it lives with the proposal.
          </p>
          {signed ? (
            <div className="flex items-center gap-2 rounded-lg border border-edge bg-sunken px-3 py-2 text-sm text-ink">
              <Check size={14} className="shrink-0 text-emerald-600" />
              <span className="min-w-0 flex-1 truncate">{signed.name}</span>
              <button
                type="button"
                onClick={() => setSigned(null)}
                aria-label="Remove signed copy"
                className="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-ink"
              >
                <X size={14} />
              </button>
            </div>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button variant="secondary" size="sm" disabled={disabled} onClick={() => fileInput.current?.click()}>
                <FileUp size={14} />{uploading ? 'Uploading…' : 'Upload signed PDF'}
              </Button>
              <Button variant="secondary" size="sm" disabled={disabled} onClick={() => setPicking(true)}>
                <FolderOpen size={14} />Choose existing
              </Button>
              <input
                ref={fileInput}
                type="file"
                accept="application/pdf"
                className="hidden"
                aria-label="Upload signed PDF"
                onChange={onUpload}
              />
            </div>
          )}
        </section>

        <section>
          <h4 className="mb-1 text-sm font-semibold text-ink">Schedule of values</h4>
          {lineCount === null ? (
            <Skeleton className="h-5 w-64" />
          ) : (
            <Checkbox
              label={`Prefill the schedule of values from this proposal's ${lineCount} ${lineCount === 1 ? 'line' : 'lines'}`}
              checked={prefillSov && lineCount > 0}
              disabled={lineCount === 0 || disabled}
              onChange={e => setPrefillSov(e.target.checked)}
            />
          )}
          <p className="mt-1 text-sm text-ink-faint">
            Alternates are left out — only the lines that make up the accepted price are carried over.
          </p>
        </section>
      </Modal>

      <FilePickerModal
        open={picking}
        onClose={() => setPicking(false)}
        onPick={onPick}
        accept="pdf"
        multi={false}
        initialProjectIds={[projectId]}
        title="Choose the signed copy"
      />
    </>
  );
};
