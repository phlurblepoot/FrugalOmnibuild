// src/pages/documents/NewDocumentModal.tsx — "New document" (ONLYOFFICE
// Phase 3): a blank Word, Excel or PDF-form file, or one started from a
// template (Settings → Document Templates), filed in a project, then opened in
// the editor.
import React, { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { FileSpreadsheet, FileText, FileType2 } from 'lucide-react';
import { Button, Field, Input, Modal, Select } from '../../components/ui';
import {
  createNewDocument, getDocumentTypes, getProjectsSummary, listDocumentTemplates,
  type CustomDocType, type DocumentTemplate, type ProjectSummary,
} from '../../utils/store';
import { NEW_DOCUMENT_TYPES, type NewDocumentType } from '../../utils/officeFormats';
import { kindLabel } from './docTypes';

const TYPE_ICON: Record<NewDocumentType, React.ReactNode> = {
  docx: <FileText size={20} />, xlsx: <FileSpreadsheet size={20} />, pdf: <FileType2 size={20} />,
};
// Photos aren't documents; company documents belong to no project.
const KINDS = ['document', 'spreadsheet', 'other', 'company-document'] as const;
const defaultKind = (type: NewDocumentType) => (type === 'xlsx' ? 'spreadsheet' : 'document');
const editorUrl = (fileId: string) => `/tools/edit?fileId=${encodeURIComponent(fileId)}`;

export const NewDocumentModal: React.FC<{
  open: boolean;
  onClose: () => void;
  initialType?: NewDocumentType;
  /** Preselected when opened from inside a project. */
  initialProjectId?: string;
}> = ({ open, onClose, initialType = 'docx', initialProjectId }) => {
  const navigate = useNavigate();
  const [type, setType] = useState<NewDocumentType>(initialType);
  const [templateId, setTemplateId] = useState('');
  const [name, setName] = useState('');
  const [projectId, setProjectId] = useState(initialProjectId ?? '');
  const [kind, setKind] = useState<string>(defaultKind(initialType));
  const [templates, setTemplates] = useState<DocumentTemplate[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [customTypes, setCustomTypes] = useState<CustomDocType[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setType(initialType); setTemplateId(''); setName(''); setKind(defaultKind(initialType));
    setProjectId(initialProjectId ?? ''); setError(null); setBusy(false);
    listDocumentTemplates().then(setTemplates, () => setTemplates([]));
    getProjectsSummary().then(ps => setProjects(ps.filter(p => !p.archived)), () => setProjects([]));
    getDocumentTypes().then(setCustomTypes, () => setCustomTypes([]));
  }, [open, initialType, initialProjectId]);

  const templatesOfType = useMemo(() => templates.filter(t => t.ext === type), [templates, type]);
  const companyDoc = kind === 'company-document';
  const needsProject = !companyDoc && !projectId;

  const pickType = (t: NewDocumentType) => {
    setType(t);
    setTemplateId('');
    // Follow the type unless the person already chose something else.
    if (kind === defaultKind(type)) setKind(defaultKind(t));
  };

  const create = async () => {
    if (needsProject || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { fileId } = await createNewDocument({
        type, name: name.trim() || 'Untitled', kind,
        ...(templateId ? { templateId } : {}),
        ...(companyDoc ? {} : { projectId }),
      });
      onClose();
      navigate(editorUrl(fileId));
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Couldn't create the document");
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
      title="New document"
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button onClick={() => void create()} disabled={needsProject || busy} data-testid="new-document-create">
            {busy ? 'Creating…' : 'Create and open'}
          </Button>
        </>
      )}
    >
      <div className="space-y-4" data-testid="new-document-modal">
        <div role="radiogroup" aria-label="Type" className="grid grid-cols-3 gap-2">
          {NEW_DOCUMENT_TYPES.map(t => (
            <button
              key={t.ext}
              type="button"
              role="radio"
              aria-checked={type === t.ext}
              onClick={() => pickType(t.ext)}
              className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-3 text-sm transition-colors ${
                type === t.ext
                  ? 'border-accent-500 bg-accent-50 text-accent-700 dark:bg-accent-400/10 dark:text-accent-300'
                  : 'border-edge text-ink-soft hover:bg-hover'
              }`}
            >
              {TYPE_ICON[t.ext]}
              <span className="font-medium">{t.label}</span>
            </button>
          ))}
        </div>
        <Field label="Start from" htmlFor="new-document-template">
          <Select id="new-document-template" value={templateId} onChange={e => setTemplateId(e.target.value)} disabled={busy}>
            <option value="">Blank</option>
            {templatesOfType.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </Select>
        </Field>
        <Field label="Name" htmlFor="new-document-name">
          <Input
            id="new-document-name"
            value={name}
            onChange={e => setName(e.target.value)}
            placeholder="Untitled"
            disabled={busy}
            onKeyDown={e => { if (e.key === 'Enter') void create(); }}
          />
        </Field>
        <Field label="Document type" htmlFor="new-document-kind">
          <Select id="new-document-kind" value={kind} onChange={e => setKind(e.target.value)} disabled={busy}>
            {typeOptions.map(o => <option key={o.id} value={o.id}>{o.label}</option>)}
          </Select>
        </Field>
        <Field
          label="Project"
          htmlFor="new-document-project"
          hint={companyDoc ? 'Company documents belong to no project.' : undefined}
        >
          <Select id="new-document-project" value={companyDoc ? '' : projectId} onChange={e => setProjectId(e.target.value)} disabled={busy || companyDoc}>
            <option value="">{companyDoc ? '—' : 'Choose a project…'}</option>
            {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
          </Select>
        </Field>
        {error && <p className="text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>}
      </div>
    </Modal>
  );
};
