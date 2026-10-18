// src/components/documents/PhotoDropCard.tsx
// The photo grid every record keeps: issues, RFIs, change orders, daily
// reports, punch items and tasks all had their own copy of this markup with
// their own hidden <input type="file"> behind it. One card now owns the
// heading, the single AddFilesButton, the drop target and the thumbnails; the
// owner supplies only what is genuinely per-record — where an upload lands,
// how a stored file is linked, and how one is removed
// (spec docs/superpowers/specs/2026-08-29-document-actions-rollout).
import React, { useState } from 'react';
import { Trash2 } from 'lucide-react';
import { getImageThumbUrl, getImageUrl } from '../../utils/store';
import { FilePickerUploadConfig } from '../FilePickerModal';
import { AddFilesButton } from './AddFilesButton';
import { useAttachFiles } from './useAttachFiles';
import { Lightbox } from '../Lightbox';

export interface PhotoDropCardProps {
  /** Section heading — 'Photos', or a stage name on punch items/tasks. */
  title: string;
  photos: { id: string; fileId: string }[];
  emptyText: string;
  /** Where a new photo lands; the image accept/capture defaults are added here. */
  upload: FilePickerUploadConfig;
  link: (fileId: string) => Promise<unknown> | unknown;
  onRemove: (fileId: string) => void;
  onDone: () => void;
  /** Prefix for this card's dropzone test id. */
  testId: string;
  initialProjectIds?: string[];
  disabled?: boolean;
  disabledMessage?: string;
  label?: string;
  className?: string;
}

export const PhotoDropCard: React.FC<PhotoDropCardProps> = ({
  title, photos, emptyText, upload, link, onRemove, onDone, testId,
  initialProjectIds, disabled = false, disabledMessage, label = 'Add photos',
  className = 'mt-4 border-t border-edge pt-3',
}) => {
  const { dragActive, dropProps, busy, attachRows } = useAttachFiles({
    upload,
    accept: 'image',
    link: fileId => link(fileId),
    onDone,
    disabled,
    disabledMessage,
    noun: 'photos',
  });
  const [lightboxIndex, setLightboxIndex] = useState<number | null>(null);

  return (
    <div
      {...dropProps}
      data-testid={`${testId}-photo-dropzone`}
      className={`${className} rounded-lg transition-shadow ${dragActive ? 'ring-2 ring-accent-500' : ''}`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-ink">{title}</h4>
        <div className="flex items-center gap-2">
          {busy && <span className="text-xs text-ink-faint">Uploading…</span>}
          <AddFilesButton
            label={label}
            accept="image"
            size="sm"
            defaultTab="upload"
            // No `capture` here: on a phone this opens the native photo picker,
            // which itself offers the camera as one of its sources — jumping
            // straight into the camera app skips the gallery entirely.
            upload={{ accept: 'image/*', ...upload }}
            initialProjectIds={initialProjectIds}
            excludeFileIds={photos.map(p => p.fileId)}
            disabled={disabled || busy}
            title={disabled ? disabledMessage : undefined}
            onPick={attachRows}
          />
        </div>
      </div>
      {photos.length === 0 ? (
        <p className="text-xs text-ink-faint">{emptyText}</p>
      ) : (
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-4">
          {photos.map((p, i) => (
            <div key={p.id} className="group relative">
              <img
                src={getImageThumbUrl(p.fileId)}
                alt=""
                onClick={() => setLightboxIndex(i)}
                className="h-24 w-full cursor-pointer rounded-lg border border-edge object-cover"
              />
              <button onClick={(e) => { e.stopPropagation(); onRemove(p.fileId); }} title="Remove"
                className="absolute right-1 top-1 flex min-h-9 min-w-9 items-center justify-center rounded-md bg-black/50 p-1 text-white opacity-100 transition-opacity focus-visible:opacity-100 sm:opacity-0 sm:group-hover:opacity-100">
                <Trash2 size={12} />
              </button>
            </div>
          ))}
        </div>
      )}
      {lightboxIndex !== null && (
        <Lightbox
          items={photos.map(p => ({ src: getImageUrl(p.fileId) }))}
          index={lightboxIndex}
          onClose={() => setLightboxIndex(null)}
        />
      )}
    </div>
  );
};
