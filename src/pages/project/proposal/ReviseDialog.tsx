// src/pages/project/proposal/ReviseDialog.tsx
// "Revise" clones a proposal into a fresh draft that keeps the lineage
// (#N (rev. of #M)). The only choice at clone time is what rides along:
// photos and attachments are opt-out, so the common case is one click.
import React, { useEffect, useState } from 'react';
import { Copy } from 'lucide-react';
import { Button, Checkbox, Modal } from '../../../components/ui';
import type { ProposalSummary } from '../../../utils/store';
import { proposalLabel } from './proposalPresentation';

export const ReviseDialog: React.FC<{
  open: boolean;
  source: ProposalSummary | null;
  onClose: () => void;
  onConfirm: (o: { carryPhotos: boolean; carryAttachments: boolean }) => Promise<void>;
}> = ({ open, source, onClose, onConfirm }) => {
  const photoCount = source?.photoCount ?? 0;
  const attachmentCount = source?.attachmentCount ?? 0;
  const [carryPhotos, setCarryPhotos] = useState(true);
  const [carryAttachments, setCarryAttachments] = useState(true);
  const [busy, setBusy] = useState(false);

  // Re-arm the defaults for each source the dialog is opened on — otherwise a
  // choice made for one proposal would leak into the next one revised.
  useEffect(() => {
    if (!open) return;
    setCarryPhotos(true);
    setCarryAttachments(true);
    setBusy(false);
  }, [open, source?.id]);

  const confirm = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // An empty set carries nothing regardless of the (disabled) checkbox.
      await onConfirm({
        carryPhotos: carryPhotos && photoCount > 0,
        carryAttachments: carryAttachments && attachmentCount > 0,
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title="Create a revision"
      width="sm"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={confirm} disabled={busy} data-testid="confirm-revise">
            <Copy size={14} />{busy ? 'Creating…' : 'Create revision'}
          </Button>
        </>
      }
    >
      <p className="mb-4 text-sm text-ink-soft">
        A new draft is copied from {source ? proposalLabel(source) : 'this proposal'} — its lines,
        wording and settings come along, and the original stays exactly as it was sent.
      </p>
      <div className="flex flex-col gap-3">
        <Checkbox
          label={`Bring over photos (${photoCount})`}
          checked={carryPhotos && photoCount > 0}
          disabled={photoCount === 0 || busy}
          onChange={e => setCarryPhotos(e.target.checked)}
        />
        <Checkbox
          label={`Bring over attachments (${attachmentCount})`}
          checked={carryAttachments && attachmentCount > 0}
          disabled={attachmentCount === 0 || busy}
          onChange={e => setCarryAttachments(e.target.checked)}
        />
      </div>
    </Modal>
  );
};
