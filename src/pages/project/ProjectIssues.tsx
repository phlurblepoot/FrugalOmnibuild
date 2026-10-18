// src/pages/project/ProjectIssues.tsx
import React, { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { AlertCircle, Eye, Plus, Trash2, ImageIcon } from 'lucide-react';
import {
  Issue, IssueListItem, getIssues, getIssue, createIssue, deleteIssue,
} from '../../utils/store';
import { useProjectOutlet } from './ProjectLayout';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import {
  Button, Card, CardBody, EmptyState, Field, Input, Skeleton, Table, TBody, TD, TH, THead, TR,
} from '../../components/ui';
import { IssueStatusPill } from '../../components/ui/IssueStatusPill';
import { IssueEditor } from './issues/IssueEditor';
import { EditingChip } from '../../components/EditingChip';
import { useGeneratedDocuments } from '../../hooks/useGeneratedDocument';
import { useReplyFlags } from '../../hooks/useReplyFlags';
import { DocumentStatusChip } from '../../components/documents/DocumentStatusChip';
import { ReplyFlagChip } from '../../components/documents/ReplyFlagChip';
import { useDocumentViewer } from '../../components/documents/useDocumentViewer';

export const issueNo = (n: number): string => `ISS-${String(n).padStart(3, '0')}`;

export const ProjectIssues: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const { summary } = useProjectOutlet();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [issues, setIssues] = useState<IssueListItem[] | null>(null);
  const [editing, setEditing] = useState<Issue | null>(null);
  // Bumped only when an outside change actually moved the record on, re-keying
  // the modal so it reloads (the collab "review merge" path). A refresh the
  // editor asked to survive — or one that changed nothing — leaves the user's
  // typed draft alone.
  const [editorSeq, setEditorSeq] = useState(0);
  const [newTitle, setNewTitle] = useState('');

  const load = () => {
    if (!projectId) return;
    getIssues(projectId).then(setIssues).catch(() => setIssues([]));
  };
  useLiveQuery(load, { types: ['issue'], projectId });

  // One batched by-source lookup for the whole list: each row shows whether its
  // issue report exists and is still current.
  const rows = issues ?? [];
  const docs = useGeneratedDocuments({
    sourceType: 'issue',
    kind: 'issue-report',
    sourceIds: rows.map(r => r.id),
    updatedAtById: Object.fromEntries(rows.map(r => [r.id, r.updatedAt])),
  });
  const replyFlags = useReplyFlags('issue', rows.map(r => r.id));
  const viewer = useDocumentViewer();

  // Focus the create-form input when arriving via the command palette's "New issue" action.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      const el = document.getElementById('new-iss') as HTMLInputElement | null;
      if (el) { el.focus(); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      setSearchParams(prev => { const p = new URLSearchParams(prev); p.delete('new'); return p; }, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Open a specific issue's editor when arriving via CreateFromThreadMenu
  // (mail Task 3) — same one-shot query-param convention as ?new=1 above.
  useEffect(() => {
    const openId = searchParams.get('open');
    if (!openId) return;
    openIssue(openId);
    setSearchParams(prev => { const p = new URLSearchParams(prev); p.delete('open'); return p; }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const openIssue = async (id: string) => {
    try { setEditing(await getIssue(id)); } catch { toast('Failed to open issue', { type: 'error' }); }
  };
  const addIssue = async () => {
    if (!projectId || !newTitle.trim()) { toast('Enter a title', { type: 'warning' }); return; }
    try {
      const r = await createIssue(projectId, { title: newTitle.trim() });
      setNewTitle('');
      setEditing(await getIssue(r.id));
      load();
    } catch { toast('Failed to create issue', { type: 'error' }); }
  };
  const removeIssue = async (id: string) => {
    if (!(await confirm({ title: 'Delete issue?', message: 'This permanently removes the issue.', tone: 'danger', confirmLabel: 'Delete' }))) return;
    try { await deleteIssue(id); load(); } catch { toast('Delete failed', { type: 'error' }); }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
      <h1 className="mb-4 text-xl font-bold text-ink">Issues</h1>

      <Card className="mb-5">
        <CardBody>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="New issue" htmlFor="new-iss">
              <Input id="new-iss" value={newTitle} onChange={e => setNewTitle(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addIssue(); }}
                placeholder="Short description of the deficiency" className="flex-1 min-w-[12rem] w-full sm:w-auto" />
            </Field>
            <Button onClick={addIssue}><Plus size={15} />Add issue</Button>
          </div>
        </CardBody>
      </Card>

      {issues === null ? (
        <div className="space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-10" />)}</div>
      ) : issues.length === 0 ? (
        <EmptyState icon={<AlertCircle size={22} />} title="No issues yet"
          description="Log deficiencies or observations here — add photos and send a report to the contractor." />
      ) : (
        <Table>
          <THead><TR><TH>#</TH><TH>Title</TH><TH>Status</TH><TH>Photos</TH><TH></TH></TR></THead>
          <TBody>
            {issues.map(iss => (
              <TR key={iss.id} interactive onClick={() => openIssue(iss.id)}>
                <TD className="font-mono text-xs text-ink-soft">{issueNo(iss.number)}</TD>
                <TD className="font-medium text-ink"><span className="inline-flex items-center gap-1.5">{iss.title || '(untitled)'}<EditingChip type="issue" id={iss.id} />{replyFlags.has(iss.id) && <ReplyFlagChip data-testid={`issue-reply-flag-${iss.id}`} />}</span></TD>
                <TD><IssueStatusPill status={iss.status} /></TD>
                <TD className="text-ink-soft">{iss.photoCount > 0 ? <span className="inline-flex items-center gap-1"><ImageIcon size={13} />{iss.photoCount}</span> : '—'}</TD>
                <TD onClick={e => e.stopPropagation()}>
                  <div className="flex items-center justify-end gap-1">
                    {docs.byId[iss.id]?.file && (
                      <>
                        <DocumentStatusChip file={docs.byId[iss.id].file} upToDate={docs.byId[iss.id].upToDate} size="sm" />
                        <button
                          onClick={() => viewer.open(docs.byId[iss.id].file!, 'issue-report', projectId ?? null)}
                          title="Open PDF" aria-label="Open PDF"
                          className="rounded-md p-1.5 text-ink-faint hover:bg-hover hover:text-ink"
                        >
                          <Eye size={14} />
                        </button>
                      </>
                    )}
                    <button onClick={() => removeIssue(iss.id)} title="Delete" className="rounded-md p-1.5 text-ink-faint hover:bg-hover hover:text-red-600"><Trash2 size={14} /></button>
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      {editing && (
        <IssueEditor
          key={`${editing.id}:${editorSeq}`}
          issue={editing}
          projectId={projectId ?? ''}
          projectName={summary?.name ?? ''}
          contractor={summary?.contractor}
          onClose={() => setEditing(null)}
          onSaved={async (opts) => {
            let fresh: Issue | null = null;
            try { fresh = await getIssue(editing.id); setEditing(fresh); } catch { setEditing(null); }
            // Remounting mid-flow would tear down the editor's document bar
            // (and its version dialog), so its own saves ask to stay mounted —
            // their local state already matches what came back. A refresh that
            // found nothing new (a failed photo upload, say) must not discard
            // what the user has typed either.
            if (!opts?.keepMounted && fresh && fresh.version !== editing.version) {
              setEditorSeq(n => n + 1);
            }
            load();
          }}
        />
      )}

      {viewer.modal}
    </div>
  );
};
