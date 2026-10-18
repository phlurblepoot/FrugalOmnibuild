// src/pages/documents/MergePdfsModal.tsx
// "Merge PDFs": lists the selected PDFs, lets the user drag them (or use the
// arrows) into the order they should join, name the result (default: first
// name + " (merged)") and, when the PDFs come from different projects, pick
// which project the new document lands in.
import React, { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, GripVertical } from 'lucide-react';
import { Button, Input, Modal, Select } from '../../components/ui';
import { mergePdfFiles, type DocumentRow } from '../../utils/store';

export const defaultMergedName = (first: DocumentRow | undefined) =>
  `${(first?.name ?? 'Document').replace(/\.pdf$/i, '')} (merged)`;

export const MergePdfsModal: React.FC<{
  open: boolean;
  rows: DocumentRow[];
  onClose: () => void;
  /** Called once the merged document is saved. */
  onDone: (count: number, name: string) => void | Promise<void>;
}> = ({ open, rows, onClose, onDone }) => {
  const [order, setOrder] = useState<DocumentRow[]>([]);
  const [name, setName] = useState('');
  const [nameEdited, setNameEdited] = useState(false);
  const [projectId, setProjectId] = useState('');
  const [dragIdx, setDragIdx] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setOrder(rows);
    setName(defaultMergedName(rows[0]));
    setNameEdited(false);
    setProjectId(rows[0]?.projectId ?? '');
    setDragIdx(null); setError(null); setBusy(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Projects among the selection, in first-seen order.
  const projects: { id: string; name: string }[] = [];
  for (const r of rows) {
    if (r.projectId && !projects.some(p => p.id === r.projectId)) projects.push({ id: r.projectId, name: r.projectName ?? r.projectId });
  }
  const spans = new Set(rows.map(r => r.projectId ?? '')).size > 1;

  const move = (from: number, to: number) => {
    if (to < 0 || to >= order.length || from === to) return;
    const next = [...order];
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item);
    setOrder(next);
    // Until the user types their own name, the default follows the first PDF.
    if (!nameEdited) setName(defaultMergedName(next[0]));
  };

  const canSave = order.length >= 2 && name.trim().length > 0 && !busy;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      const res = await mergePdfFiles(order.map(r => r.id), name.trim(), spans && projectId ? projectId : undefined);
      await onDone(order.length, res.name);
      onClose();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Couldn't merge the PDFs");
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title="Merge PDFs"
      width="lg"
      dirty={(nameEdited || order.some((r, i) => r.id !== rows[i]?.id)) && !busy}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button data-testid="merge-pdfs-save" onClick={() => { void save(); }} disabled={!canSave}>
            {busy ? 'Merging…' : `Merge ${order.length} PDFs`}
          </Button>
        </>
      )}
    >
      <div className="space-y-4" data-testid="merge-pdfs-modal">
        <div>
          <p className="mb-1 text-xs text-ink-faint">Drag to set the order they join in.</p>
          <ol className="rounded-lg border border-edge" data-testid="merge-pdfs-list">
            {order.map((r, i) => (
              <li
                key={r.id}
                data-testid="merge-pdfs-item"
                draggable={!busy}
                onDragStart={() => setDragIdx(i)}
                onDragOver={e => e.preventDefault()}
                onDrop={e => { e.preventDefault(); if (dragIdx !== null) move(dragIdx, i); setDragIdx(null); }}
                onDragEnd={() => setDragIdx(null)}
                className={`flex items-center gap-2 border-b border-edge px-3 py-2 last:border-b-0 ${dragIdx === i ? 'opacity-50' : ''}`}
              >
                <GripVertical size={14} className="shrink-0 cursor-grab text-ink-faint" aria-hidden />
                <span className="w-5 shrink-0 text-xs text-ink-faint">{i + 1}</span>
                <span className="min-w-0 flex-1 truncate text-sm text-ink">{r.name ?? r.id}</span>
                <button
                  type="button" aria-label={`Move ${r.name ?? r.id} up`} disabled={i === 0 || busy}
                  onClick={() => move(i, i - 1)}
                  className="rounded p-1 text-ink-faint hover:bg-hover disabled:opacity-30"
                ><ArrowUp size={14} /></button>
                <button
                  type="button" aria-label={`Move ${r.name ?? r.id} down`} disabled={i === order.length - 1 || busy}
                  onClick={() => move(i, i + 1)}
                  className="rounded p-1 text-ink-faint hover:bg-hover disabled:opacity-30"
                ><ArrowDown size={14} /></button>
              </li>
            ))}
          </ol>
        </div>

        <label className="block text-sm text-ink">
          <span className="mb-1 block text-xs text-ink-faint">Name of the merged PDF</span>
          <Input
            data-testid="merge-pdfs-name"
            value={name}
            onChange={e => { setName(e.target.value); setNameEdited(true); }}
          />
        </label>

        {spans && (
          <label className="block text-sm text-ink">
            <span className="mb-1 block text-xs text-ink-faint">These PDFs are from different projects. Save the result in</span>
            <Select
              data-testid="merge-pdfs-project"
              value={projectId}
              onChange={e => setProjectId(e.target.value)}
            >
              <option value="">No project</option>
              {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
            </Select>
          </label>
        )}

        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      </div>
    </Modal>
  );
};
