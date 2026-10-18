// src/components/documents/CleanImageModal.tsx — adding a signature or a
// company stamp (ONLYOFFICE Phase 3): pick a photo or scan, the white paper
// around it is made transparent (removeWhiteBackground), and the person names
// it and sees the result before saving, on a checkerboard so the cleared
// background shows.
import React, { useEffect, useRef, useState } from 'react';
import { ImagePlus } from 'lucide-react';
import { Button, Field, Input, Modal } from '../ui';
import { dataUrlToBlob, removeWhiteBackground } from '../../utils/removeWhiteBackground';

const readAsDataUrl = (file: File) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(new Error('Could not read the file'));
  r.readAsDataURL(file);
});

export const CHECKERBOARD: React.CSSProperties = {
  backgroundImage: 'linear-gradient(45deg,#e5e7eb 25%,transparent 25%),linear-gradient(-45deg,#e5e7eb 25%,transparent 25%),linear-gradient(45deg,transparent 75%,#e5e7eb 75%),linear-gradient(-45deg,transparent 75%,#e5e7eb 75%)',
  backgroundSize: '16px 16px',
  backgroundPosition: '0 0,0 8px,8px -8px,-8px 0',
  backgroundColor: '#fff',
};

export const CleanImageModal: React.FC<{
  open: boolean;
  onClose: () => void;
  title: string;
  /** What the name field starts with. */
  defaultName: string;
  hint?: string;
  onSave: (png: Blob, name: string) => Promise<void>;
  testIdPrefix: string;
}> = ({ open, onClose, title, defaultName, hint, onSave, testIdPrefix }) => {
  const [cleaned, setCleaned] = useState<string | null>(null);
  const [name, setName] = useState(defaultName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setCleaned(null); setName(defaultName); setBusy(false); setError(null);
  }, [open, defaultName]);

  const pick = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) { setError('Pick an image (a photo or scan).'); return; }
    setError(null);
    setBusy(true);
    try {
      setCleaned(await removeWhiteBackground(await readAsDataUrl(file)));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read the image');
    } finally {
      setBusy(false);
    }
  };

  const save = async () => {
    if (!cleaned || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await onSave(dataUrlToBlob(cleaned), name.trim());
      onClose();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Saving failed');
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title={title}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void save()} disabled={!cleaned || !name.trim() || busy} data-testid={`${testIdPrefix}-save`}>
            {busy && cleaned ? 'Saving…' : 'Save'}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        {hint && <p className="text-sm text-ink-soft">{hint}</p>}
        <div>
          <Button variant="secondary" onClick={() => inputRef.current?.click()} disabled={busy}>
            <ImagePlus size={15} /> {cleaned ? 'Choose another image' : 'Choose image'}
          </Button>
          <input
            ref={inputRef}
            type="file"
            accept="image/*"
            className="hidden"
            data-testid={`${testIdPrefix}-input`}
            onChange={e => { void pick(e.target.files?.[0]); e.target.value = ''; }}
          />
        </div>
        {cleaned && (
          <div className="flex justify-center rounded-lg border border-edge p-3" style={CHECKERBOARD}>
            <img src={cleaned} alt="Preview with the background removed" className="max-h-40 max-w-full object-contain" data-testid={`${testIdPrefix}-preview`} />
          </div>
        )}
        <Field label="Name" htmlFor={`${testIdPrefix}-name`}>
          <Input id={`${testIdPrefix}-name`} value={name} onChange={e => setName(e.target.value)} disabled={busy} maxLength={200} />
        </Field>
        {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      </div>
    </Modal>
  );
};
