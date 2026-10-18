// src/pages/documents/AppendPagesModal.tsx
// "Append pages": on one PDF, pick other PDFs, say which pages of each to take
// (blank = all, or "1-3, 5") and where they go: the start, the end, or after
// page N. The result is saved as a new version of the PDF (server/pdfMerge.ts).
import React, { useEffect, useMemo, useState } from 'react';
import { Button, Input, Modal, Select } from '../../components/ui';
import { appendPdfPages, getDocuments, type AppendPosition, type DocumentRow } from '../../utils/store';

type Where = 'end' | 'start' | 'after';

export const AppendPagesModal: React.FC<{
  open: boolean;
  target: DocumentRow | null;
  onClose: () => void;
  /** Called once the new version is saved. */
  onDone: (target: DocumentRow) => void | Promise<void>;
}> = ({ open, target, onClose, onDone }) => {
  const [candidates, setCandidates] = useState<DocumentRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [q, setQ] = useState('');
  // Picked PDFs in the order they were ticked: that is the order they land in.
  const [picked, setPicked] = useState<string[]>([]);
  const [pages, setPages] = useState<Record<string, string>>({});
  const [where, setWhere] = useState<Where>('end');
  const [afterPage, setAfterPage] = useState('1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !target) return;
    setPicked([]); setPages({}); setWhere('end'); setAfterPage('1'); setQ(''); setError(null); setBusy(false);
    setLoading(true);
    let live = true;
    getDocuments({ mimes: ['application/pdf'], limit: 200, ...(target.projectId ? { projectIds: [target.projectId] } : {}) })
      .then(r => { if (live) setCandidates(r.rows.filter(x => x.id !== target.id)); })
      .catch(() => { if (live) setCandidates([]); })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [open, target]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? candidates.filter(c => (c.name ?? '').toLowerCase().includes(t)) : candidates;
  }, [candidates, q]);

  if (!target) return null;

  const toggle = (id: string) => setPicked(p => (p.includes(id) ? p.filter(x => x !== id) : [...p, id]));
  const afterN = Number(afterPage);
  const afterBad = where === 'after' && (!Number.isInteger(afterN) || afterN < 0);
  const canSave = picked.length > 0 && !afterBad && !busy;

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    const position: AppendPosition = where === 'after' ? { afterPage: afterN } : where;
    try {
      await appendPdfPages(target.id, picked.map(id => ({ id, pages: (pages[id] ?? '').trim() })), position);
      await onDone(target);
      onClose();
    } catch (e) {
      setError(e instanceof Error && e.message ? e.message : "Couldn't add the pages");
      setBusy(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={busy ? () => {} : onClose}
      title={`Append pages to ${target.name ?? 'PDF'}`}
      width="lg"
      dirty={picked.length > 0 && !busy}
      footer={(
        <>
          <Button variant="secondary" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button data-testid="append-pages-save" onClick={() => { void save(); }} disabled={!canSave}>
            {busy ? 'Saving…' : 'Add pages as a new version'}
          </Button>
        </>
      )}
    >
      <div className="space-y-4" data-testid="append-pages-modal">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-ink-faint">Put them</span>
          <Select
            aria-label="Where the pages go"
            data-testid="append-pages-where"
            value={where}
            onChange={e => setWhere(e.target.value as Where)}
            className="h-9 w-auto"
          >
            <option value="end">At the end</option>
            <option value="start">At the start</option>
            <option value="after">After page…</option>
          </Select>
          {where === 'after' && (
            <Input
              aria-label="After page number"
              data-testid="append-pages-after"
              type="number"
              min={0}
              value={afterPage}
              onChange={e => setAfterPage(e.target.value)}
              className="h-9 w-20"
            />
          )}
        </div>

        <Input
          aria-label="Search PDFs"
          placeholder="Search PDFs"
          value={q}
          onChange={e => setQ(e.target.value)}
        />

        <div className="max-h-72 overflow-y-auto rounded-lg border border-edge" data-testid="append-pages-list">
          {loading ? (
            <p className="p-3 text-sm text-ink-faint">Loading PDFs…</p>
          ) : shown.length === 0 ? (
            <p className="p-3 text-sm text-ink-faint">No other PDFs found{target.projectId ? ' in this project' : ''}.</p>
          ) : shown.map(c => {
            const on = picked.includes(c.id);
            return (
              <div key={c.id} className="flex flex-wrap items-center gap-2 border-b border-edge px-3 py-2 last:border-b-0">
                <label className="flex min-w-0 flex-1 items-center gap-2 text-sm text-ink">
                  <input type="checkbox" className="size-4 rounded border-edge-strong accent-accent-600" checked={on} onChange={() => toggle(c.id)} aria-label={`Add pages from ${c.name ?? c.id}`} />
                  <span className="truncate">{c.name ?? c.id}</span>
                  {on && <span className="shrink-0 text-xs text-ink-faint">#{picked.indexOf(c.id) + 1}</span>}
                </label>
                {on && (
                  <Input
                    aria-label={`Pages of ${c.name ?? c.id}`}
                    placeholder="All pages, or 1-3, 5"
                    value={pages[c.id] ?? ''}
                    onChange={e => setPages(p => ({ ...p, [c.id]: e.target.value }))}
                    className="h-8 w-44 text-xs"
                  />
                )}
              </div>
            );
          })}
        </div>

        {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      </div>
    </Modal>
  );
};
