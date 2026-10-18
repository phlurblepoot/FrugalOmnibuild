// src/pages/documentEditor/InsertImagePicker.tsx — the editor's Insert → Image
// → From storage (ONLYOFFICE Phase 3): your signatures (default first),
// company stamps, or photos and other images in Documents (the shared file
// picker, starting on this document's project). Picking hands the chosen file
// ids back; the editor page asks the server for signed links and inserts.
import React, { useEffect, useState } from 'react';
import { Images, PenLine, Stamp } from 'lucide-react';
import { Button, Modal, Skeleton } from '../../components/ui';
import { FilePickerModal } from '../../components/FilePickerModal';
import { CHECKERBOARD } from '../../components/documents/CleanImageModal';
import { SignatureImage } from '../settings/MySignatures';
import { getImageUrl, listCompanyStamps, listSignatures, type LibraryItem, type Signature } from '../../utils/store';
import { importLegacySignatures } from '../../utils/legacySignatures';

type Tab = 'signatures' | 'stamps';

const Tile: React.FC<{ label: string; badge?: string; onClick: () => void; children: React.ReactNode; testId: string }> = ({ label, badge, onClick, children, testId }) => (
  <button
    type="button"
    onClick={onClick}
    className="group flex flex-col gap-1 rounded-lg border border-edge p-2 text-left hover:border-accent-400 focus:outline-none focus:ring-2 focus:ring-accent-500"
    data-testid={testId}
    aria-label={`Insert ${label}`}
  >
    <span className="flex h-20 items-center justify-center rounded" style={CHECKERBOARD}>{children}</span>
    <span className="flex items-center gap-1 truncate text-xs text-ink">
      <span className="truncate">{label}</span>
      {badge && <span className="shrink-0 text-accent-600 dark:text-accent-400">· {badge}</span>}
    </span>
  </button>
);

export const InsertImagePicker: React.FC<{
  open: boolean;
  onClose: () => void;
  /** The document's project, where "Photos" starts. */
  projectId: string | null;
  onPick: (fileIds: string[]) => void;
}> = ({ open, onClose, projectId, onPick }) => {
  const [tab, setTab] = useState<Tab>('signatures');
  const [signatures, setSignatures] = useState<Signature[] | null>(null);
  const [stamps, setStamps] = useState<LibraryItem[] | null>(null);
  const [browsing, setBrowsing] = useState(false);

  useEffect(() => {
    if (!open) return;
    setTab('signatures'); setSignatures(null); setStamps(null); setBrowsing(false);
    // Old-editor signatures come across the first time, here as in Settings.
    void importLegacySignatures().catch(() => 0).then(() => listSignatures())
      .then(list => setSignatures([...list].sort((a, b) => Number(b.isDefault) - Number(a.isDefault))), () => setSignatures([]));
    listCompanyStamps().then(setStamps, () => setStamps([]));
  }, [open]);

  const pick = (ids: string[]) => { if (ids.length) onPick(ids); };

  const tabBtn = (id: Tab, label: string, icon: React.ReactNode) => (
    <button
      type="button"
      role="tab"
      aria-selected={tab === id}
      onClick={() => setTab(id)}
      className={`flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm ${tab === id ? 'border-accent-500 font-medium text-ink' : 'border-transparent text-ink-soft hover:text-ink'}`}
    >
      {icon}{label}
    </button>
  );

  return (
    <>
      <Modal
        open={open && !browsing}
        onClose={onClose}
        title="Insert an image"
        width="lg"
        footer={(
          <>
            <Button variant="secondary" onClick={() => setBrowsing(true)} data-testid="insert-image-photos">
              <Images size={15} /> Photos and images in Documents…
            </Button>
            <Button variant="secondary" onClick={onClose}>Cancel</Button>
          </>
        )}
      >
        <div className="space-y-3" data-testid="insert-image-picker">
          <div role="tablist" className="flex gap-1 border-b border-edge">
            {tabBtn('signatures', 'My signatures', <PenLine size={14} />)}
            {tabBtn('stamps', 'Company stamps', <Stamp size={14} />)}
          </div>
          {tab === 'signatures' && (signatures === null ? <Skeleton className="h-20 w-48" /> : signatures.length === 0 ? (
            <p className="text-sm text-ink-faint">No signatures yet. Add them in Settings → User Preferences → My signatures.</p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {signatures.map(s => (
                <Tile key={s.id} label={s.name} badge={s.isDefault ? 'default' : undefined} onClick={() => pick([s.id])} testId="insert-signature">
                  <SignatureImage id={s.id} alt={s.name} className="max-h-16 max-w-full object-contain" />
                </Tile>
              ))}
            </div>
          ))}
          {tab === 'stamps' && (stamps === null ? <Skeleton className="h-20 w-48" /> : stamps.length === 0 ? (
            <p className="text-sm text-ink-faint">No company stamps yet. An admin adds them in Settings → Document Templates.</p>
          ) : (
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {stamps.map(s => (
                <Tile key={s.id} label={s.name} onClick={() => pick([s.id])} testId="insert-stamp">
                  <img src={getImageUrl(s.id)} alt={s.name} className="max-h-16 max-w-full object-contain" />
                </Tile>
              ))}
            </div>
          ))}
        </div>
      </Modal>
      <FilePickerModal
        open={open && browsing}
        onClose={() => setBrowsing(false)}
        accept="image"
        multi
        title="Insert photos or images"
        initialProjectIds={projectId ? [projectId] : []}
        onPick={rows => pick(rows.map(r => r.id))}
      />
    </>
  );
};
