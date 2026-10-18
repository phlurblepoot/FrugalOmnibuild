// src/pages/project/proposal/ProposalPhotosCard.tsx
// Photos appended to the end of the generated proposal. Fully controlled and
// mutated straight through the API (no dirty state) — every action calls
// onChanged() so the editor reloads the proposal with the fresh photo list.
// Draft-only: the server rejects photo edits on a locked (non-draft) proposal.
import React, { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, X } from 'lucide-react';
import {
  type Proposal, type ProposalPhoto,
  addProposalPhoto, updateProposalPhoto, removeProposalPhoto, getImageUrl, getImageThumbUrl,
} from '../../../utils/store';
import { Button, Card, CardBody, CardHeader, Input } from '../../../components/ui';
import { AddFilesButton } from '../../../components/documents/AddFilesButton';
import { useAttachFiles } from '../../../components/documents/useAttachFiles';
import { useToast } from '../../../components/Toast';
import { Lightbox } from '../../../components/Lightbox';
import { handleProposalCardError, toastProposalCardError } from './proposalCardErrors';

// Caption text stays local while typing (like PricingLinesCard's amount
// field) and only commits to the API on blur when it actually changed —
// otherwise every keystroke would fire a PATCH.
const PhotoTile: React.FC<{
  photo: ProposalPhoto;
  readOnly: boolean;
  canMoveLeft: boolean;
  canMoveRight: boolean;
  onCaptionCommit: (caption: string) => void;
  onMove: (dir: -1 | 1) => void;
  onRemove: () => void;
  onOpen: () => void;
}> = ({ photo, readOnly, canMoveLeft, canMoveRight, onCaptionCommit, onMove, onRemove, onOpen }) => {
  const [caption, setCaption] = useState(photo.caption ?? '');
  useEffect(() => { setCaption(photo.caption ?? ''); }, [photo.caption]);

  return (
    <div className="group relative rounded-lg border border-edge bg-sunken p-2" data-testid={`proposal-photo-${photo.id}`}>
      <div className="relative">
        <img
          src={getImageThumbUrl(photo.fileId)}
          alt=""
          onClick={onOpen}
          className="h-28 w-full cursor-pointer rounded-md object-cover"
        />
        {!readOnly && (
          <button
            type="button"
            onClick={(e) => { e.stopPropagation(); onRemove(); }}
            aria-label="Remove photo"
            title="Remove"
            className="absolute right-1 top-1 flex min-h-9 min-w-9 items-center justify-center rounded-md bg-black/50 p-1 text-white opacity-100 transition-opacity focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100"
          >
            <X size={14} />
          </button>
        )}
      </div>
      <Input
        className="mt-2"
        aria-label="Caption"
        placeholder="Caption (optional)"
        value={caption}
        disabled={readOnly}
        onClick={e => e.stopPropagation()}
        onChange={e => setCaption(e.target.value)}
        onBlur={() => { if (caption !== (photo.caption ?? '')) onCaptionCommit(caption); }}
      />
      {!readOnly && (
        <div className="mt-1 flex items-center justify-end">
          <Button variant="ghost" size="sm" aria-label="Move left" title="Move left" disabled={!canMoveLeft} onClick={(e) => { e.stopPropagation(); onMove(-1); }}><ArrowLeft size={14} /></Button>
          <Button variant="ghost" size="sm" aria-label="Move right" title="Move right" disabled={!canMoveRight} onClick={(e) => { e.stopPropagation(); onMove(1); }}><ArrowRight size={14} /></Button>
        </div>
      )}
    </div>
  );
};

export const ProposalPhotosCard: React.FC<{
  proposal: Proposal;
  projectId: string;
  readOnly: boolean;
  onChanged: () => void;
}> = ({ proposal, projectId, readOnly, onChanged }) => {
  const { toast } = useToast();
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  const photos = [...proposal.photos].sort((a, b) => a.sortOrder - b.sortOrder);

  // One affordance for both "upload a new shot" and "reuse one already filed"
  // — and the same wiring for a photo dropped onto the card. A per-row failure
  // (a stale fileId, or the proposal locking mid-pick) is summarised rather
  // than swallowed: a pick or a drop can carry many files at once.
  const photoUpload = { kind: 'proposal-photo', projectId, sourceType: 'proposal', sourceId: proposal.id };
  const { dragActive, dropProps, busy, attachRows } = useAttachFiles({
    upload: photoUpload,
    accept: 'image',
    link: fileId => addProposalPhoto(proposal.id, fileId),
    onDone: onChanged,
    disabled: readOnly,
    disabledMessage: 'This proposal was sent and is now locked',
    noun: 'photos',
  });

  const handleCaption = async (photo: ProposalPhoto, caption: string) => {
    try {
      await updateProposalPhoto(proposal.id, photo.fileId, { caption: caption.trim() || null });
      onChanged();
    } catch (e) { handleProposalCardError(e, toast, onChanged, 'Failed to update caption'); }
  };

  // The two PATCHes are sequential rather than Promise.all'd: if the second
  // one fails, the server is left with one photo's sortOrder already moved —
  // onChanged() always runs (via finally) so the card resyncs to whatever
  // sortOrder the server actually ended up with, instead of showing a stale
  // (and now duplicate) local order.
  const handleMove = async (index: number, dir: -1 | 1) => {
    const cur = photos[index];
    const other = photos[index + dir];
    if (!other) return;
    try {
      await updateProposalPhoto(proposal.id, cur.fileId, { sortOrder: other.sortOrder });
      await updateProposalPhoto(proposal.id, other.fileId, { sortOrder: cur.sortOrder });
    } catch (e) {
      toastProposalCardError(e, toast, 'Failed to reorder photos');
    } finally {
      onChanged();
    }
  };

  const handleRemove = async (photo: ProposalPhoto) => {
    try {
      await removeProposalPhoto(proposal.id, photo.fileId);
      onChanged();
    } catch (e) { handleProposalCardError(e, toast, onChanged, 'Failed to remove photo'); }
  };

  return (
    <Card
      data-testid="proposal-photos"
      {...dropProps}
      className={dragActive ? 'ring-2 ring-accent-500' : ''}
    >
      <CardHeader
        title="Photos"
        actions={!readOnly && (
          <div className="flex flex-wrap items-center gap-2">
            {busy && <span className="text-xs text-ink-faint">Uploading…</span>}
            <AddFilesButton
              label="Add photos"
              accept="image"
              size="sm"
              defaultTab="upload"
              // No `capture`: proposal photos are chosen from the gallery after
              // the fact, unlike the field cards where the camera is the point.
              upload={{ ...photoUpload, accept: 'image/*' }}
              initialProjectIds={[projectId]}
              excludeFileIds={proposal.photos.map(p => p.fileId)}
              disabled={busy}
              onPick={attachRows}
            />
          </div>
        )}
      />
      <CardBody>
        {photos.length === 0 ? (
          <p className="text-sm text-ink-faint">No photos. Appended to the end of the generated proposal.</p>
        ) : (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {photos.map((photo, i) => (
              <PhotoTile
                key={photo.id}
                photo={photo}
                readOnly={readOnly}
                canMoveLeft={i > 0}
                canMoveRight={i < photos.length - 1}
                onCaptionCommit={caption => handleCaption(photo, caption)}
                onMove={dir => handleMove(i, dir)}
                onRemove={() => handleRemove(photo)}
                onOpen={() => setLightboxIndex(i)}
              />
            ))}
          </div>
        )}
      </CardBody>
      {lightboxIndex !== null && (
        <Lightbox
          items={photos.map(p => ({ src: getImageUrl(p.fileId), caption: p.caption ?? undefined }))}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </Card>
  );
};
