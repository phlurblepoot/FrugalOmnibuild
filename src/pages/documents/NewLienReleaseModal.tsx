// src/pages/documents/NewLienReleaseModal.tsx — Documents -> New -> "Release of
// lien" (spec §6.1): pick the project and the variant, then the editor opens on
// a release filled in with the project's defaults, to finish by hand.
import React, { useEffect, useState } from 'react';
import { Button, Field, Modal, Select } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { getProjectsSummary, type ProjectSummary } from '../../utils/store';
import {
  LIEN_VARIANTS, LienReleaseHost, buildLienDraft, type HostedRelease,
} from '../project/billing/LienReleaseLauncher';

export const NewLienReleaseModal: React.FC<{
  open: boolean;
  onClose: () => void;
  /** Preselected inside a project (including the project's Documents tab). */
  initialProjectId?: string;
}> = ({ open, onClose, initialProjectId }) => {
  const { toast } = useToast();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [projectId, setProjectId] = useState(initialProjectId ?? '');
  const [variantIx, setVariantIx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [hosted, setHosted] = useState<HostedRelease | null>(null);

  useEffect(() => {
    if (!open) return;
    setProjectId(initialProjectId ?? ''); setVariantIx(0); setBusy(false);
    getProjectsSummary().then(ps => setProjects(ps.filter(p => !p.archived)), () => setProjects([]));
  }, [open, initialProjectId]);

  const create = async () => {
    if (!projectId || busy) return;
    setBusy(true);
    try {
      const v = LIEN_VARIANTS[variantIx];
      setHosted(await buildLienDraft(projectId, { paymentType: v.paymentType, conditional: v.conditional }));
    } catch (e) {
      toast((e instanceof Error && e.message) || "Couldn't start the release", { type: 'error' });
    } finally { setBusy(false); }
  };

  const closeAll = () => { setHosted(null); onClose(); };

  if (hosted) {
    return <LienReleaseHost projectId={projectId} initial={hosted} onClose={closeAll} />;
  }

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title="New release of lien"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void create()} disabled={!projectId || busy} data-testid="new-lien-release-create">
            {busy ? 'Starting…' : 'Continue'}
          </Button>
        </>
      )}
    >
      <div className="space-y-4" data-testid="new-lien-release-modal">
        <Field label="Project" htmlFor="new-lien-project">
          <Select id="new-lien-project" value={projectId} onChange={e => setProjectId(e.target.value)} disabled={busy}>
            <option value="">Choose a project…</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        <Field label="Release" htmlFor="new-lien-variant">
          <Select id="new-lien-variant" value={String(variantIx)} onChange={e => setVariantIx(Number(e.target.value))} disabled={busy}>
            {LIEN_VARIANTS.map((v, i) => <option key={v.label} value={i}>{v.label}</option>)}
          </Select>
        </Field>
      </div>
    </Modal>
  );
};
