// src/pages/project/ProjectRfis.tsx
import React, { useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { Eye, Mail, MessageCircleQuestion, Plus, Trash2, ImageIcon } from 'lucide-react';
import {
  Rfi, RfiListItem, getRfis, getRfi, createRfi, deleteRfi,
} from '../../utils/store';
import { useProjectOutlet } from './ProjectLayout';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import {
  Button, Card, CardBody, EmptyState, Field, Input, Skeleton, Table, TBody, TD, TH, THead, TR,
} from '../../components/ui';
import { RfiStatusPill } from '../../components/ui/RfiStatusPill';
import { RfiEditor } from './rfi/RfiEditor';
import { EditingChip } from '../../components/EditingChip';
import { useGeneratedDocuments } from '../../hooks/useGeneratedDocument';
import { useReplyFlags } from '../../hooks/useReplyFlags';
import { DocumentStatusChip } from '../../components/documents/DocumentStatusChip';
import { ReplyFlagChip } from '../../components/documents/ReplyFlagChip';
import { useDocumentViewer } from '../../components/documents/useDocumentViewer';

export const rfiNo = (n: number): string => `RFI-${String(n).padStart(3, '0')}`;

// Overdue is a display rule, not a status: past the response-needed date and
// still awaiting an answer. Due-today is not overdue.
export const isRfiOverdue = (rfi: { responseNeededBy: string | null; status: string }, now: Date = new Date()): boolean => {
  if (!rfi.responseNeededBy || rfi.status === 'answered' || rfi.status === 'closed') return false;
  const due = new Date(`${rfi.responseNeededBy}T23:59:59`);
  return !isNaN(due.getTime()) && due.getTime() < now.getTime();
};

export const ProjectRfis: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const { summary } = useProjectOutlet();
  const { toast } = useToast();
  const confirm = useConfirm();
  const [rfis, setRfis] = useState<RfiListItem[] | null>(null);
  const [editing, setEditing] = useState<Rfi | null>(null);
  // Bumped only when an outside change actually moved the record on, re-keying
  // the modal so it reloads (the collab "review merge" path). A refresh the
  // editor asked to survive — or one that changed nothing — leaves the user's
  // typed draft alone.
  const [editorSeq, setEditorSeq] = useState(0);
  const [newTitle, setNewTitle] = useState('');

  const load = () => {
    if (!projectId) return;
    getRfis(projectId).then(setRfis).catch(() => setRfis([]));
  };
  useLiveQuery(load, { types: ['rfi'], projectId });

  // One batched by-source lookup for the whole list: each row shows whether its
  // RFI PDF exists and is still current.
  const rows = rfis ?? [];
  const docs = useGeneratedDocuments({
    sourceType: 'rfi',
    kind: 'rfi',
    sourceIds: rows.map(r => r.id),
    updatedAtById: Object.fromEntries(rows.map(r => [r.id, r.updatedAt])),
  });
  const replyFlags = useReplyFlags('rfi', rows.map(r => r.id));
  const viewer = useDocumentViewer();

  // Focus the create-form input when arriving via the command palette's "New RFI" action.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    if (searchParams.get('new') === '1') {
      const el = document.getElementById('new-rfi') as HTMLInputElement | null;
      if (el) { el.focus(); el.scrollIntoView({ block: 'center', behavior: 'smooth' }); }
      setSearchParams(prev => { const p = new URLSearchParams(prev); p.delete('new'); return p; }, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // Open a specific RFI's editor when arriving via CreateFromThreadMenu
  // (mail Task 3) — same one-shot query-param convention as ?new=1 above.
  useEffect(() => {
    const openId = searchParams.get('open');
    if (!openId) return;
    openRfi(openId);
    setSearchParams(prev => { const p = new URLSearchParams(prev); p.delete('open'); return p; }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  const openRfi = async (id: string) => {
    try { setEditing(await getRfi(id)); } catch { toast('Failed to open RFI', { type: 'error' }); }
  };
  const addRfi = async () => {
    if (!projectId || !newTitle.trim()) { toast('Enter a title', { type: 'warning' }); return; }
    try {
      const r = await createRfi(projectId, { title: newTitle.trim() });
      setNewTitle('');
      setEditing(await getRfi(r.id));
      load();
    } catch { toast('Failed to create RFI', { type: 'error' }); }
  };
  const removeRfi = async (id: string) => {
    if (!(await confirm({ title: 'Delete RFI?', message: 'This permanently removes the RFI.', tone: 'danger', confirmLabel: 'Delete' }))) return;
    try { await deleteRfi(id); load(); } catch { toast('Delete failed', { type: 'error' }); }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
      <h1 className="mb-4 text-xl font-bold text-ink">RFIs</h1>

      <Card className="mb-5">
        <CardBody>
          <div className="flex flex-wrap items-end gap-2">
            <Field label="New RFI" htmlFor="new-rfi">
              <Input id="new-rfi" value={newTitle} onChange={e => setNewTitle(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') addRfi(); }}
                placeholder="What do you need answered?" className="flex-1 min-w-[12rem] w-full sm:w-auto" />
            </Field>
            <Button onClick={addRfi}><Plus size={15} />Add RFI</Button>
          </div>
        </CardBody>
      </Card>

      {rfis === null ? (
        <div className="space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-10" />)}</div>
      ) : rfis.length === 0 ? (
        <EmptyState icon={<MessageCircleQuestion size={22} />} title="No RFIs yet"
          description="Ask the design team or GC a formal question — attach photos, send a branded PDF, and track the response." />
      ) : (
        <Table>
          <THead><TR><TH>#</TH><TH>Title</TH><TH>Status</TH><TH>Response needed</TH><TH>Photos</TH><TH></TH></TR></THead>
          <TBody>
            {rfis.map(rfi => (
              <TR key={rfi.id} interactive onClick={() => openRfi(rfi.id)}>
                <TD className="font-mono text-xs text-ink-soft">{rfiNo(rfi.number)}</TD>
                <TD className="font-medium text-ink"><span className="inline-flex items-center gap-1.5">{rfi.title || '(untitled)'}<EditingChip type="rfi" id={rfi.id} /></span></TD>
                <TD>
                  <span className="inline-flex items-center gap-1.5">
                    <RfiStatusPill status={rfi.status} />
                    {/* An emailed answer came back and is waiting for someone to
                        accept or dismiss it in the editor. Gated on the status
                        as well as the row: a pendingReply can outlive an
                        out-of-band status change. */}
                    {rfi.pendingReply && rfi.status === 'sent' ? (
                      <span
                        title="Email reply waiting for review"
                        className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 text-[11px] font-medium text-amber-700 dark:border-amber-500/40 dark:bg-amber-900/20 dark:text-amber-300"
                      >
                        <Mail size={11} />Reply
                      </span>
                    ) : (
                      // Same reply-state signal as the pendingReply chip above,
                      // just less rich (no accountId/response file) — shown
                      // only when pendingReply isn't already covering it, so a
                      // flagged RFI is never double-chipped.
                      replyFlags.has(rfi.id) && <ReplyFlagChip data-testid={`rfi-reply-flag-${rfi.id}`} />
                    )}
                  </span>
                </TD>
                <TD className={isRfiOverdue(rfi) ? 'font-medium text-red-600' : 'text-ink-soft'}>
                  {rfi.responseNeededBy ? new Date(`${rfi.responseNeededBy}T00:00:00`).toLocaleDateString() : '—'}
                  {isRfiOverdue(rfi) ? ' · overdue' : ''}
                </TD>
                <TD className="text-ink-soft">{rfi.photoCount > 0 ? <span className="inline-flex items-center gap-1"><ImageIcon size={13} />{rfi.photoCount}</span> : '—'}</TD>
                <TD onClick={e => e.stopPropagation()}>
                  <div className="flex items-center justify-end gap-1">
                    {docs.byId[rfi.id]?.file && (
                      <>
                        <DocumentStatusChip file={docs.byId[rfi.id].file} upToDate={docs.byId[rfi.id].upToDate} size="sm" />
                        <button
                          onClick={() => viewer.open(docs.byId[rfi.id].file!, 'rfi', projectId ?? null)}
                          title="Open PDF" aria-label="Open PDF"
                          className="rounded-md p-1.5 text-ink-faint hover:bg-hover hover:text-ink"
                        >
                          <Eye size={14} />
                        </button>
                      </>
                    )}
                    <button onClick={() => removeRfi(rfi.id)} title="Delete" className="rounded-md p-1.5 text-ink-faint hover:bg-hover hover:text-red-600"><Trash2 size={14} /></button>
                  </div>
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}

      {editing && (
        <RfiEditor
          key={`${editing.id}:${editorSeq}`}
          rfi={editing}
          projectId={projectId ?? ''}
          projectName={summary?.name ?? ''}
          contractor={summary?.contractor}
          onClose={() => setEditing(null)}
          onSaved={async (opts) => {
            let fresh: Rfi | null = null;
            try { fresh = await getRfi(editing.id); setEditing(fresh); } catch { setEditing(null); }
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
