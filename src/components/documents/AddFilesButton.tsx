// src/components/documents/AddFilesButton.tsx
// The one "add files" affordance every photo grid, attachment list and
// importer mounts (spec docs/superpowers/specs/2026-08-29-document-actions-rollout):
// a button that opens FilePickerModal so picking an existing document and
// uploading a new one are the same gesture everywhere in the app, instead of
// each screen shipping its own bare <input type="file">.
//
// It owns nothing but the open/closed state — every decision (what counts as
// an acceptable file, where an upload lands, whether the caller wants rows or
// bytes) is the caller's, passed straight through to the picker.
import React, { useState } from 'react';
import { Plus } from 'lucide-react';
import { DocumentRow } from '../../utils/store';
import { FilePickerModal, FilePickerTab, FilePickerUploadConfig } from '../FilePickerModal';
import { Button } from '../ui';

export interface AddFilesButtonProps {
  /** Also the picker's title — "Add photos" / "Add files" / "Attach files". */
  label: string;
  accept: 'pdf' | 'image' | 'image-pdf' | 'spreadsheet' | 'office' | 'any';
  multi?: boolean;
  upload?: FilePickerUploadConfig;
  defaultTab?: FilePickerTab;
  initialProjectIds?: string[];
  excludeFileIds?: string[];
  returnBlobs?: boolean;
  onPick?: (rows: DocumentRow[]) => void | Promise<void>;
  onPickBlobs?: (picked: { row: DocumentRow; blob: Blob }[]) => void | Promise<void>;
  /** The Upload tab hands back the chosen files unstored (FilePickerModal). */
  onPickFiles?: (files: File[]) => void | Promise<void>;
  variant?: 'primary' | 'secondary' | 'ghost';
  size?: 'sm';
  className?: string;
  disabled?: boolean;
  title?: string;
}

export const AddFilesButton: React.FC<AddFilesButtonProps> = ({
  label, accept, multi = true, upload, defaultTab, initialProjectIds, excludeFileIds,
  returnBlobs, onPick, onPickBlobs, onPickFiles, variant = 'secondary', size, className, disabled, title,
}) => {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        variant={variant}
        size={size}
        className={className}
        disabled={disabled}
        title={title}
        data-testid="add-files-button"
        onClick={() => setOpen(true)}
      >
        <Plus size={15} />{label}
      </Button>

      {/* Mounted only while open: these buttons sit on every card in a grid,
          and an always-mounted picker per card would fire a documents query
          each. */}
      {open && (
        <FilePickerModal
          open
          onClose={() => setOpen(false)}
          title={label}
          accept={accept}
          multi={multi}
          upload={upload}
          defaultTab={defaultTab}
          initialProjectIds={initialProjectIds}
          excludeFileIds={excludeFileIds}
          returnBlobs={returnBlobs}
          onPick={onPick}
          onPickBlobs={onPickBlobs}
          onPickFiles={onPickFiles}
        />
      )}
    </>
  );
};
