// src/pages/settings/DocumentTemplatesTab.tsx — Settings → Document Templates
// (admin only; ONLYOFFICE Phase 3). The AIA Template tab is separate and
// unchanged.
//
//   * Templates: Word, Excel and PDF files anyone can start a new document
//     from ("New document" → Start from). Admins upload, rename, delete, and
//     open them in the editor to change them. The company letterhead
//     (docs/Template.docx) can be added in one click.
//   * Company stamps: APPROVED, REVIEWED, the company seal… Admins upload
//     them (white background removed), everyone can insert them in the editor.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FilePlus2, FileSpreadsheet, FileText, FileType2, Pencil, Stamp, Trash2, Upload } from 'lucide-react';
import { Button, Card, CardBody, CardHeader, Input, Skeleton } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import { CHECKERBOARD, CleanImageModal } from '../../components/documents/CleanImageModal';
import {
  addLetterheadTemplate, deleteCompanyStamp, deleteDocumentTemplate, getImageUrl, listCompanyStamps, listDocumentTemplates,
  renameCompanyStamp, renameDocumentTemplate, uploadCompanyStamp, uploadDocumentTemplate,
  type DocumentTemplate, type LibraryItem,
} from '../../utils/store';
import { NEW_DOCUMENT_TYPES } from '../../utils/officeFormats';

const LETTERHEAD_NAME = 'Letterhead.docx';
const TYPE_ICON = { docx: <FileText size={16} />, xlsx: <FileSpreadsheet size={16} />, pdf: <FileType2 size={16} /> };
const TYPE_LABEL = Object.fromEntries(NEW_DOCUMENT_TYPES.map(t => [t.ext, t.label])) as Record<DocumentTemplate['ext'], string>;
const errText = (e: unknown, fallback: string) => (e instanceof Error && e.message ? e.message : fallback);
const iconBtn = 'inline-flex items-center gap-1 rounded-md px-2 py-1 text-xs text-ink-soft hover:bg-hover hover:text-ink disabled:opacity-50';

/** A name that turns into a text box when renamed. */
export const RenameableName: React.FC<{
  name: string;
  /** Shown after the text box, e.g. ".docx", which is kept. */
  suffix?: string;
  onRename: (name: string) => Promise<void>;
  testId: string;
}> = ({ name, suffix, onRename, testId }) => {
  const [editing, setEditing] = useState(false);
  const base = suffix && name.endsWith(suffix) ? name.slice(0, -suffix.length) : name;
  const [value, setValue] = useState(base);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!value.trim() || value.trim() === base) { setEditing(false); return; }
    setBusy(true);
    try { await onRename(value.trim()); setEditing(false); } finally { setBusy(false); }
  };
  if (!editing) {
    return (
      <span className="flex min-w-0 items-center gap-1">
        <span className="truncate text-sm text-ink" title={name}>{name}</span>
        <button type="button" className={iconBtn} aria-label={`Rename ${name}`} onClick={() => { setValue(base); setEditing(true); }} data-testid={`${testId}-rename`}>
          <Pencil size={12} />
        </button>
      </span>
    );
  }
  return (
    <form className="flex min-w-0 items-center gap-1" onSubmit={e => { e.preventDefault(); void save(); }}>
      <Input
        autoFocus
        value={value}
        onChange={e => setValue(e.target.value)}
        onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setEditing(false); } }}
        className="h-8 py-1 text-sm"
        aria-label="New name"
        disabled={busy}
        data-testid={`${testId}-name-input`}
      />
      {suffix && <span className="text-sm text-ink-faint">{suffix}</span>}
      <Button size="sm" type="submit" disabled={busy}>Save</Button>
      <Button size="sm" variant="secondary" type="button" onClick={() => setEditing(false)} disabled={busy}>Cancel</Button>
    </form>
  );
};

export const DocumentTemplatesTab: React.FC = () => {
  const navigate = useNavigate();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [templates, setTemplates] = useState<DocumentTemplate[] | null>(null);
  const [stamps, setStamps] = useState<LibraryItem[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [stampOpen, setStampOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    const [t, s] = await Promise.allSettled([listDocumentTemplates(), listCompanyStamps()]);
    setTemplates(t.status === 'fulfilled' ? t.value : []);
    setStamps(s.status === 'fulfilled' ? s.value : []);
  }, []);
  useEffect(() => { void load(); }, [load]);

  const run = async (fn: () => Promise<unknown>, done: string, failed: string) => {
    setBusy(true);
    try { await fn(); toast(done, { type: 'success' }); await load(); }
    catch (e) { toast(errText(e, failed), { type: 'error' }); }
    finally { setBusy(false); }
  };

  const upload = (file: File | undefined) => {
    if (!file) return;
    void run(() => uploadDocumentTemplate(file), `Template "${file.name}" added`, 'Uploading the template failed');
  };

  const removeTemplate = async (t: DocumentTemplate) => {
    const ok = await confirm({
      title: 'Delete template', message: `Delete the template "${t.name}"? Documents already made from it are not affected.`,
      confirmLabel: 'Delete', tone: 'danger',
    });
    if (ok) await run(() => deleteDocumentTemplate(t.id), 'Template deleted', 'Deleting the template failed');
  };

  const removeStamp = async (s: LibraryItem) => {
    const ok = await confirm({
      title: 'Delete stamp', message: `Delete the stamp "${s.name}"? Documents it was already inserted into keep it.`,
      confirmLabel: 'Delete', tone: 'danger',
    });
    if (ok) await run(() => deleteCompanyStamp(s.id), 'Stamp deleted', 'Deleting the stamp failed');
  };

  const hasLetterhead = templates?.some(t => t.name === LETTERHEAD_NAME) ?? true;

  return (
    <div className="space-y-6" data-testid="document-templates-tab">
      <Card>
        <CardHeader
          title={<span className="flex items-center gap-2"><FilePlus2 size={18} className="text-accent-600" /> Document templates</span>}
          actions={(
            <div className="flex flex-wrap items-center gap-2">
              {!hasLetterhead && (
                <Button size="sm" variant="secondary" disabled={busy} data-testid="templates-add-letterhead"
                  onClick={() => void run(addLetterheadTemplate, 'Letterhead template added', 'Adding the letterhead failed')}>
                  <FileText size={14} /> Add company letterhead
                </Button>
              )}
              <Button size="sm" disabled={busy} onClick={() => fileRef.current?.click()} data-testid="templates-upload">
                <Upload size={14} /> Upload template
              </Button>
              <input
                ref={fileRef}
                type="file"
                accept=".docx,.xlsx,.pdf"
                className="hidden"
                data-testid="templates-upload-input"
                onChange={e => { upload(e.target.files?.[0]); e.target.value = ''; }}
              />
            </div>
          )}
        />
        <CardBody className="space-y-3">
          <p className="text-sm text-ink-soft">
            Anyone can start a new document from these (Documents → New document → Start from). Open one in the editor to change it.
          </p>
          {templates === null ? <Skeleton className="h-8 w-64" /> : templates.length === 0 ? (
            <p className="text-sm text-ink-faint">No templates yet. Upload a Word, Excel or PDF file.</p>
          ) : (
            <ul className="divide-y divide-edge" data-testid="templates-list">
              {templates.map(t => (
                <li key={t.id} className="flex flex-wrap items-center gap-3 py-2" data-testid="template-row">
                  <span className="text-ink-faint">{TYPE_ICON[t.ext]}</span>
                  <div className="min-w-0 flex-1">
                    <RenameableName
                      name={t.name}
                      suffix={`.${t.ext}`}
                      testId="template"
                      onRename={async name => {
                        try { await renameDocumentTemplate(t.id, name); await load(); }
                        catch (e) { toast(errText(e, 'Renaming failed'), { type: 'error' }); throw e; }
                      }}
                    />
                    <span className="text-xs text-ink-faint">{TYPE_LABEL[t.ext]}</span>
                  </div>
                  <button type="button" className={iconBtn} onClick={() => navigate(`/tools/edit?fileId=${encodeURIComponent(t.id)}`)}>
                    <Pencil size={12} /> Open in editor
                  </button>
                  <button type="button" className={`${iconBtn} hover:!text-red-600`} aria-label={`Delete ${t.name}`} disabled={busy} onClick={() => void removeTemplate(t)}>
                    <Trash2 size={12} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={<span className="flex items-center gap-2"><Stamp size={18} className="text-accent-600" /> Company stamps</span>}
          actions={<Button size="sm" disabled={busy} onClick={() => setStampOpen(true)} data-testid="stamps-add"><Upload size={14} /> Add stamp</Button>}
        />
        <CardBody className="space-y-3">
          <p className="text-sm text-ink-soft">
            Stamps like APPROVED or the company seal. Everyone can insert them in the editor (Insert → Image → From storage).
          </p>
          {stamps === null ? <Skeleton className="h-16 w-64" /> : stamps.length === 0 ? (
            <p className="text-sm text-ink-faint">No stamps yet.</p>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="stamps-list">
              {stamps.map(s => (
                <li key={s.id} className="space-y-2 rounded-lg border border-edge p-2" data-testid="stamp-row">
                  <div className="flex h-24 items-center justify-center rounded" style={CHECKERBOARD}>
                    <img src={getImageUrl(s.id)} alt={s.name} className="max-h-20 max-w-full object-contain" />
                  </div>
                  <div className="flex items-center gap-1">
                    <div className="min-w-0 flex-1">
                      <RenameableName
                        name={s.name}
                        testId="stamp"
                        onRename={async name => {
                          try { await renameCompanyStamp(s.id, name); await load(); }
                          catch (e) { toast(errText(e, 'Renaming failed'), { type: 'error' }); throw e; }
                        }}
                      />
                    </div>
                    <button type="button" className={`${iconBtn} hover:!text-red-600`} aria-label={`Delete ${s.name}`} disabled={busy} onClick={() => void removeStamp(s)}>
                      <Trash2 size={12} />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardBody>
      </Card>

      <CleanImageModal
        open={stampOpen}
        onClose={() => setStampOpen(false)}
        title="Add a company stamp"
        defaultName=""
        hint="Use a clear scan or photo on white paper. The white around it is removed so the stamp sits cleanly on a document."
        testIdPrefix="stamp-upload"
        onSave={async (png, name) => {
          await uploadCompanyStamp(png, name);
          toast(`Stamp "${name}" added`, { type: 'success' });
          await load();
        }}
      />
    </div>
  );
};
