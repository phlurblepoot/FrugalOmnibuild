// src/pages/documentEditor/OpenFromComputerModal.tsx — "Open from computer"
// in the document editor. ONLYOFFICE can only open files the app stores, so a
// file from the computer is first uploaded into a project (decision
// 2026-09-25: pick the project and document type), then opened. Everything
// anyone edits ends up filed somewhere.
import React, { useEffect, useRef, useState } from 'react';
import { v4 as uuidv4 } from 'uuid';
import { Upload } from 'lucide-react';
import { Button, Field, Modal, Select } from '../../components/ui';
import {
  getDocumentTypes, getProjectsSummary, saveBinaryFile,
  type CustomDocType, type ProjectSummary,
} from '../../utils/store';
import { CONVERTIBLE_EXTENSIONS, OFFICE_FORMATS, officeFormatOf, uploadConversionTarget } from '../../utils/officeFormats';
import { kindFromMime } from '../documents/openTarget';
import { kindLabel } from '../documents/docTypes';
import { useToast } from '../../components/Toast';
import { reportConversions } from '../../utils/uploadConversion';

// Photos aren't editor files, and company documents belong to no project.
const KINDS = ['document', 'spreadsheet', 'other'] as const;
// Editor files, and the old formats converted to one on upload.
const ACCEPT = [...OFFICE_FORMATS.map(f => f.ext), ...CONVERTIBLE_EXTENSIONS].map(e => `.${e}`).join(',');

export const OpenFromComputerModal: React.FC<{
  open: boolean;
  onClose: () => void;
  /** Called with the stored file's id once the upload lands. */
  onUploaded: (fileId: string) => void;
}> = ({ open, onClose, onUploaded }) => {
  const { toast } = useToast();
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [customTypes, setCustomTypes] = useState<CustomDocType[]>([]);
  const [file, setFile] = useState<File | null>(null);
  const [projectId, setProjectId] = useState('');
  const [kind, setKind] = useState<string>('document');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setFile(null); setError(null); setBusy(false);
    getProjectsSummary().then(ps => setProjects(ps.filter(p => !p.archived)), () => setProjects([]));
    getDocumentTypes().then(setCustomTypes, () => setCustomTypes([]));
  }, [open]);

  const pick = (f: File | undefined) => {
    if (!f) return;
    if (!officeFormatOf({ mime: f.type, name: f.name }) && !uploadConversionTarget(f.name)) {
      setError(`"${f.name}" isn't a file the editor opens. Pick a PDF, Word, Excel or PowerPoint file.`);
      return;
    }
    setError(null);
    setFile(f);
    const guessed = kindFromMime(f.type || '');
    if ((KINDS as readonly string[]).includes(guessed)) setKind(guessed);
  };

  const upload = async () => {
    if (!file || !projectId) return;
    setBusy(true);
    setError(null);
    try {
      const project = projects.find(p => p.id === projectId);
      const { fileId, conversion } = await saveBinaryFile(uuidv4(), file, {
        kind, name: file.name, projectId, customerId: project?.customerId ?? undefined,
      });
      reportConversions(toast, [{ name: file.name, conversion }]);
      onUploaded(fileId);
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : 'Upload failed');
      setBusy(false);
    }
  };

  const typeOptions = [
    ...KINDS.map(k => ({ id: k, label: kindLabel(k) })),
    ...customTypes.map(t => ({ id: `custom:${t.id}`, label: t.label })),
  ];

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title="Open from computer"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void upload()} disabled={!file || !projectId || busy} data-testid="open-computer-upload">
            {busy ? 'Uploading…' : 'Upload and open'}
          </Button>
        </>
      )}
    >
      <div className="space-y-4">
        <p className="text-sm text-ink-soft">The file is saved to the project's Documents, then opens in the editor.</p>
        <Field label="File" htmlFor="open-computer-file">
          <div className="flex items-center gap-3">
            <Button variant="secondary" onClick={() => inputRef.current?.click()} disabled={busy}>
              <Upload size={15} /> Choose file
            </Button>
            <span className="min-w-0 truncate text-sm text-ink" data-testid="open-computer-filename">{file ? file.name : 'No file chosen'}</span>
          </div>
          <input
            id="open-computer-file"
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            className="hidden"
            data-testid="open-computer-input"
            onChange={e => { pick(e.target.files?.[0]); e.target.value = ''; }}
          />
        </Field>
        <Field label="Project" htmlFor="open-computer-project">
          <Select id="open-computer-project" value={projectId} onChange={e => setProjectId(e.target.value)} disabled={busy}>
            <option value="">Choose a project…</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        <Field label="Type" htmlFor="open-computer-kind">
          <Select id="open-computer-kind" value={kind} onChange={e => setKind(e.target.value)} disabled={busy}>
            {typeOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </Select>
        </Field>
        {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      </div>
    </Modal>
  );
};
