import React, { useMemo } from 'react';
import { motion } from 'motion/react';
import { History, X, GitCompare, ExternalLink, Ruler } from 'lucide-react';
import { Project, ProjectPage } from '../types';
import { computeRevisionModel, effectiveSheetId } from '../utils/planSets';

interface Props {
  project: Project;
  pageId: string;
  onClose: () => void;
  onOpenPage: (pageId: string) => void;
  onCompare: () => void;
}

const setLabel = (project: Project, page: ProjectPage) => {
  const ps = project.planSets?.find(s => s.id === page.planSetId);
  if (!ps) return 'Unversioned';
  return `${ps.name}${ps.date ? ` · ${ps.date}` : ''}`;
};

// History of a single sheet across plan sets, newest first.
export const PlanSetRevisions: React.FC<Props> = ({ project, pageId, onClose, onOpenPage, onCompare }) => {
  const { revs, latestId, sheetNo } = useMemo(() => {
    const model = computeRevisionModel(project, '');
    const page = project.pages.find(p => p.id === pageId);
    const key = page ? effectiveSheetId(page) : null;
    const list = key ? (model.revisionsBySheet.get(key) || []) : [];
    return {
      revs: [...list].reverse(),
      latestId: key ? model.latestPageIdBySheet.get(key) : undefined,
      sheetNo: page?.pageNumber || page?.name || 'Sheet',
    };
  }, [project, pageId]);

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
              <button onClick={onCompare} className="px-3 py-1.5 rounded-xl bg-accent-600 text-white text-sm font-medium hover:bg-accent-700 transition-all flex items-center gap-1.5">
                <GitCompare size={15} /> Compare
              </button>
            )}
            <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-ink-faint hover:text-ink hover:bg-hover">
              <X size={18} />
            </button>
          </div>
        </div>
        <div className="p-4 overflow-y-auto space-y-2">
          {revs.map((p, i) => {
            const revNumber = revs.length - i;
            const isCurrent = p.id === latestId;
            return (
              <div key={p.id} className={`rounded-xl border p-3 flex items-center gap-3 ${isCurrent ? 'border-accent-300 dark:border-accent-700 bg-accent-50/50 dark:bg-accent-900/20' : 'border-edge'}`}>
                <span className="shrink-0 w-9 h-9 rounded-lg bg-sunken text-ink-soft text-xs font-bold flex items-center justify-center">R{revNumber}</span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-ink truncate">{setLabel(project, p)}</span>
                    {isCurrent && <span className="text-[10px] uppercase tracking-wider font-bold rounded-full px-2 py-0.5 bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300">Current</span>}
                  </div>
                  <div className="text-xs text-ink-faint flex items-center gap-1 mt-0.5">
                    <Ruler size={12} /> {p.measurements.length} measurement{p.measurements.length === 1 ? '' : 's'}
                  </div>
                </div>
                <button
                  onClick={() => onOpenPage(p.id)}
                  title={isCurrent ? 'Open this revision' : 'View this revision (read-only)'}
                  aria-label={isCurrent ? 'Open this revision' : 'View this revision (read-only)'}
                  className="shrink-0 inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-medium text-ink-soft hover:text-accent-600 hover:bg-hover"
                >
                  <ExternalLink size={15} /> {isCurrent ? 'Open' : 'View'}
                </button>
              </div>
            );
          })}
        </div>
      </motion.div>
    </div>
  );
};
