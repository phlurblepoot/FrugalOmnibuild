import React, { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { History, X, GitCompare, ExternalLink, Ruler, Split } from 'lucide-react';
import { Project, ProjectPage } from '../types';
import { computeRevisionModel, effectiveSheetId, wouldBeNewestIn } from '../utils/planSets';

interface Props {
  project: Project;
  pageId: string;
  onClose: () => void;
  onOpenPage: (pageId: string) => void;
  onCompare: () => void;
  /** Fix a wrong match: move a page to sheet `target` (null = its own sheet). */
  onMoveToSheet?: (pageId: string, target: string | null, replaceTakeoffs: boolean) => void;
}

const setLabel = (project: Project, page: ProjectPage) => {
  const ps = project.planSets?.find(s => s.id === page.planSetId);
  if (!ps) return 'No plan set';
  return `${ps.name}${ps.date ? ` · ${ps.date}` : ''}`;
};

const OWN_SHEET = '__own__';

/** "Wrong sheet?" editor for one revision. */
const MoveEditor: React.FC<{
  project: Project;
  page: ProjectPage;
  sheetOptions: { key: string; label: string }[];
  isOnlyRevision: boolean;
  onCancel: () => void;
  onMove: (target: string | null, replaceTakeoffs: boolean) => void;
}> = ({ project, page, sheetOptions, isOnlyRevision, onCancel, onMove }) => {
  const [target, setTarget] = useState(isOnlyRevision ? (sheetOptions[0]?.key ?? '') : OWN_SHEET);
  const toSheet = target && target !== OWN_SHEET ? target : null;
  const becomesNewest = toSheet ? wouldBeNewestIn(project, page.id, toSheet) : false;
  const [replace, setReplace] = useState(page.measurements.length === 0);
  const count = page.measurements.length;
  return (
    <div data-testid="move-sheet-editor" className="mt-2 rounded-lg border border-edge bg-sunken/40 p-3 space-y-2 text-xs">
      <label className="block font-medium text-ink">This page is really…</label>
      <select
        data-testid="move-sheet-select"
        value={target}
        onChange={(e) => setTarget(e.target.value)}
        className="w-full px-2 py-1.5 rounded-lg border border-edge-strong bg-raised text-ink text-sm"
      >
        {!isOnlyRevision && <option value={OWN_SHEET}>Its own sheet (not a revision of this one)</option>}
        {sheetOptions.map(o => <option key={o.key} value={o.key}>A revision of {o.label}</option>)}
      </select>
      {toSheet && becomesNewest && (
        <label className="flex items-start gap-2 text-ink-soft">
          <input data-testid="move-sheet-replace" type="checkbox" checked={replace} onChange={(e) => setReplace(e.target.checked)} className="mt-0.5" />
          <span>
            Copy that sheet's current takeoffs onto this page (what uploading it as a revision would have done).
            {replace && count > 0 && <span className="block text-amber-600 dark:text-amber-400">This page's {count} takeoff{count === 1 ? '' : 's'} will be replaced.</span>}
          </span>
        </label>
      )}
      {toSheet && !becomesNewest && (
        <p className="text-ink-faint">That sheet has a newer revision, so this page will be read-only history there.</p>
      )}
      {!toSheet && count > 0 && (
        <p className="text-ink-faint">Its {count} takeoff{count === 1 ? '' : 's'} stay on it. If they were copied from this sheet by mistake, delete them on the page.</p>
      )}
      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onCancel} className="px-2.5 py-1 rounded-lg text-ink-soft hover:bg-hover">Cancel</button>
        <button
          data-testid="move-sheet-confirm"
          disabled={!target}
          onClick={() => onMove(toSheet, !!toSheet && becomesNewest && replace)}
          className="px-2.5 py-1 rounded-lg bg-accent-600 text-white font-medium hover:bg-accent-700 disabled:opacity-50"
        >
          Move
        </button>
      </div>
    </div>
  );
};

// History of a single sheet across plan sets, newest first.
export const PlanSetRevisions: React.FC<Props> = ({ project, pageId, onClose, onOpenPage, onCompare, onMoveToSheet }) => {
  const { revs, latestId, sheetNo, revNumber, otherSheets } = useMemo(() => {
    const model = computeRevisionModel(project, '');
    const page = project.pages.find(p => p.id === pageId);
    const key = page ? effectiveSheetId(page) : null;
    const list = key ? (model.revisionsBySheet.get(key) || []) : [];
    const others: { key: string; label: string; sort: string }[] = [];
    for (const [k, pages] of model.revisionsBySheet) {
      if (k === key) continue;
      const cur = pages[pages.length - 1];
      const num = cur.pageNumber || cur.name || 'Untitled';
      const desc = cur.description && cur.description !== num ? ` — ${cur.description}` : '';
      others.push({ key: k, label: `${num}${desc}${pages.length > 1 ? ` (${pages.length} revisions)` : ''}`, sort: num });
    }
    others.sort((a, b) => a.sort.localeCompare(b.sort, undefined, { numeric: true }));
    return {
      revs: [...list].reverse(),
      latestId: key ? model.latestPageIdBySheet.get(key) : undefined,
      sheetNo: page?.pageNumber || page?.name || 'Sheet',
      revNumber: model.revisionNumberByPageId,
      otherSheets: others,
    };
  }, [project, pageId]);

  const [editingId, setEditingId] = useState<string | null>(null);

  return (
    <div className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={onClose} role="dialog" aria-modal="true" aria-label="Revision history">
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0 }} transition={{ duration: 0.16 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-lg bg-raised rounded-2xl shadow-xl border border-edge overflow-hidden max-h-[85vh] flex flex-col"
      >
        <div className="p-5 border-b border-edge flex items-center justify-between shrink-0">
          <h2 className="text-lg font-bold text-ink flex items-center gap-2 min-w-0">
            <History size={18} className="text-accent-600 shrink-0" /> <span className="truncate">Revisions of {sheetNo}</span>
          </h2>
          <div className="flex items-center gap-2 shrink-0">
            {revs.length >= 2 && (
              <button data-testid="revisions-compare" onClick={onCompare} className="px-3 py-1.5 rounded-xl bg-accent-600 text-white text-sm font-medium hover:bg-accent-700 transition-all flex items-center gap-1.5">
                <GitCompare size={15} /> Compare
              </button>
            )}
            <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-ink-faint hover:text-ink hover:bg-hover">
              <X size={18} />
            </button>
          </div>
        </div>
        <div className="p-4 overflow-y-auto space-y-2">
          {revs.length < 2 && (
            <p className="text-xs text-ink-soft pb-1">
              This sheet has one revision. If this page is really a newer (or older) version of another sheet, use <b>Wrong sheet?</b> to tie them together.
            </p>
          )}
          {revs.map(p => {
            const n = revNumber.get(p.id) ?? 1;
            const isCurrent = p.id === latestId;
            return (
              <div key={p.id} data-testid="revision-row" className={`rounded-xl border p-3 ${isCurrent ? 'border-accent-300 dark:border-accent-700 bg-accent-50/50 dark:bg-accent-900/20' : 'border-edge'}`}>
                <div className="flex items-center gap-3">
                  <span className="shrink-0 w-9 h-9 rounded-lg bg-sunken text-ink-soft text-xs font-bold flex items-center justify-center">R{n}</span>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-ink truncate">{setLabel(project, p)}</span>
                      {isCurrent && revs.length > 1 && <span className="text-[10px] uppercase tracking-wider font-bold rounded-full px-2 py-0.5 bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300">Current</span>}
                    </div>
                    <div className="text-xs text-ink-faint flex items-center gap-1 mt-0.5 min-w-0">
                      <Ruler size={12} className="shrink-0" /> {p.measurements.length} measurement{p.measurements.length === 1 ? '' : 's'}
                      <span className="truncate">· {p.name}</span>
                    </div>
                  </div>
                  {onMoveToSheet && (
                    <button
                      data-testid="revision-wrong-sheet"
                      onClick={() => setEditingId(id => (id === p.id ? null : p.id))}
                      title="This page was matched to the wrong sheet"
                      className="shrink-0 inline-flex items-center gap-1 px-2 py-1.5 rounded-lg text-xs font-medium text-ink-soft hover:text-accent-600 hover:bg-hover"
                    >
                      <Split size={14} /> Wrong sheet?
                    </button>
                  )}
                  <button
                    onClick={() => onOpenPage(p.id)}
                    title={isCurrent ? 'Open this revision' : 'View this revision (read-only)'}
                    aria-label={isCurrent ? 'Open this revision' : 'View this revision (read-only)'}
                    className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-ink-soft hover:text-accent-600 hover:bg-hover"
                  >
                    <ExternalLink size={15} /> {isCurrent ? 'Open' : 'View'}
                  </button>
                </div>
                {editingId === p.id && onMoveToSheet && (
                  <MoveEditor
                    project={project}
                    page={p}
                    sheetOptions={otherSheets}
                    isOnlyRevision={revs.length < 2}
                    onCancel={() => setEditingId(null)}
                    onMove={(target, replace) => { setEditingId(null); onMoveToSheet(p.id, target, replace); }}
                  />
                )}
              </div>
            );
          })}
        </div>
      </motion.div>
    </div>
  );
};
