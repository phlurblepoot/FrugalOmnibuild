// src/pages/settings/MySignatures.tsx — Settings → User Preferences → My
// signatures (ONLYOFFICE Phase 3). Each person keeps several signatures,
// names them and picks a default; the white background is removed when one
// is added. They are inserted in the editor through Insert → Image → From
// storage, and nobody else can see them.
import React, { useCallback, useEffect, useState } from 'react';
import { PenLine, Star, Trash2, Upload } from 'lucide-react';
import { Button, Skeleton } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import { CHECKERBOARD, CleanImageModal } from '../../components/documents/CleanImageModal';
import { addSignature, deleteSignature, fetchFileBlob, listSignatures, updateSignature, type Signature } from '../../utils/store';
import { importLegacySignatures } from '../../utils/legacySignatures';
import { RenameableName } from './DocumentTemplatesTab';

const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);

/** A signature image. Signatures are private, so they load through the
 *  signed-in file route rather than a plain image link. */
export const SignatureImage: React.FC<{ id: string; alt: string; className?: string }> = ({ id, alt, className }) => {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let url: string | null = null;
    let live = true;
    fetchFileBlob(id).then(b => {
      if (!live) return;
      url = URL.createObjectURL(b);
      setSrc(url);
    }).catch(() => {});
    return () => { live = false; if (url) URL.revokeObjectURL(url); };
  }, [id]);
  return src ? <img src={src} alt={alt} className={className} /> : <Skeleton className="h-10 w-24" />;
};

export const MySignatures: React.FC = () => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [signatures, setSignatures] = useState<Signature[] | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try { setSignatures(await listSignatures()); } catch { setSignatures([]); }
  }, []);

  useEffect(() => {
    // Signatures saved in this browser by the old PDF editor come across once.
    void importLegacySignatures().then(n => {
      if (n > 0) toast(`${n} signature${n === 1 ? '' : 's'} from the old PDF editor added`, { type: 'success' });
    }).finally(() => { void load(); });
  }, [load, toast]);

  const act = async (fn: () => Promise<unknown>, failed: string) => {
    setBusy(true);
    try { await fn(); await load(); }
    catch (e) { toast(errText(e, failed), { type: 'error' }); }
    finally { setBusy(false); }
  };

  const remove = async (s: Signature) => {
    const ok = await confirm({ title: 'Delete signature', message: `Delete "${s.name}"?`, confirmLabel: 'Delete', tone: 'danger' });
    if (ok) await act(() => deleteSignature(s.id), 'Deleting the signature failed');
  };

  return (
    <div className="bg-raised rounded-2xl border border-edge shadow-sm overflow-hidden" data-testid="my-signatures">
      <div className="p-6 border-b border-edge flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold text-ink flex items-center gap-2">
            <PenLine size={18} className="text-accent-600 dark:text-accent-400" />
            My signatures
          </h2>
          <p className="text-sm text-ink-soft">
            Insert them in the Document Editor with Insert → Image → From storage. Only you can see them.
          </p>
        </div>
        <Button size="sm" onClick={() => setAdding(true)} disabled={busy} data-testid="signatures-add">
          <Upload size={14} /> Add signature
        </Button>
      </div>
      <div className="p-6">
        {signatures === null ? <Skeleton className="h-16 w-64" /> : signatures.length === 0 ? (
          <p className="text-sm text-ink-faint">No signatures yet. Sign a sheet of white paper, then photograph or scan it.</p>
        ) : (
          <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3" data-testid="signatures-list">
            {signatures.map(s => (
              <li key={s.id} className={`space-y-2 rounded-lg border p-2 ${s.isDefault ? 'border-accent-400' : 'border-edge'}`} data-testid="signature-row">
                <div className="flex h-20 items-center justify-center rounded" style={CHECKERBOARD}>
                  <SignatureImage id={s.id} alt={s.name} className="max-h-16 max-w-full object-contain" />
                </div>
                <div className="flex items-center gap-1">
                  <div className="min-w-0 flex-1">
                    <RenameableName
                      name={s.name}
                      testId="signature"
                      onRename={async name => {
                        try { await updateSignature(s.id, { name }); await load(); }
                        catch (e) { toast(errText(e, 'Renaming failed'), { type: 'error' }); throw e; }
                      }}
                    />
                  </div>
                  {s.isDefault ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-accent-600 dark:text-accent-400" data-testid="signature-default">
                      <Star size={12} className="fill-current" /> Default
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="rounded-md px-2 py-1 text-xs text-ink-soft hover:bg-hover hover:text-ink disabled:opacity-50"
                      disabled={busy}
                      onClick={() => void act(() => updateSignature(s.id, { isDefault: true }), 'Setting the default failed')}
                    >
                      Make default
                    </button>
                  )}
                  <button
                    type="button"
                    className="rounded-md p-1 text-ink-soft hover:bg-hover hover:text-red-600 disabled:opacity-50"
                    aria-label={`Delete ${s.name}`}
                    disabled={busy}
                    onClick={() => void remove(s)}
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>
      <CleanImageModal
        open={adding}
        onClose={() => setAdding(false)}
        title="Add a signature"
        defaultName={signatures && signatures.length > 0 ? `Signature ${signatures.length + 1}` : 'Signature'}
        hint="Sign on white paper and photograph or scan it. The white around the ink is removed."
        testIdPrefix="signature-upload"
        onSave={async (png, name) => {
          await addSignature(png, name);
          toast(`Signature "${name}" added`, { type: 'success' });
          await load();
        }}
      />
    </div>
  );
};
