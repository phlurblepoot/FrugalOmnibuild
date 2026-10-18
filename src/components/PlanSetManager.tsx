import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Layers, X, Trash2, Check, Edit2, Plus, Eye } from 'lucide-react';
import { Project } from '../types';
import { orderedPlanSets, summarizePlanSet } from '../utils/planSets';

interface Props {
  project: Project;
  selectedPlanSetId: string;
  onClose: () => void;
  onSelect: (id: string) => void;
  onUpdate: (id: string, patch: { name?: string; date?: string }) => void;
  onDelete: (id: string) => void;
  onAddNew: () => void;
}

export const PlanSetManager: React.FC<Props> = ({ project, selectedPlanSetId, onClose, onSelect, onUpdate, onDelete, onAddNew }) => {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editName, setEditName] = useState('');
  const [editDate, setEditDate] = useState('');

  // Newest first — that's how people think about reissues.
  const sets = orderedPlanSets(project).slice().reverse();
  const pageCount = (id: string) => project.pages.filter(p => p.planSetId === id).length;

  const startEdit = (id: string, name: string, date?: string) => {
    setEditingId(id);
    setEditName(name);
    setEditDate(date || '');
  };
  const saveEdit = (id: string) => {
    onUpdate(id, { name: editName.trim() || 'Untitled set', date: editDate || undefined });
    setEditingId(null);
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="Manage plan sets"
    >
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: 12 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        transition={{ duration: 0.16 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-2xl bg-raised rounded-2xl shadow-xl border border-edge overflow-hidden max-h-[85vh] flex flex-col"
      >
        <div className="p-6 border-b border-edge flex items-center justify-between shrink-0">
          <h2 className="text-lg font-bold text-ink flex items-center gap-2">
            <Layers size={18} className="text-accent-600" /> Plan Sets
          </h2>
          <div className="flex items-center gap-2">
            <button onClick={onAddNew} className="px-3 py-1.5 rounded-xl bg-accent-600 text-white text-sm font-medium hover:bg-accent-700 transition-all flex items-center gap-1.5">
              <Plus size={15} /> Add set
            </button>
            <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-ink-faint hover:text-ink hover:bg-hover">
              <X size={18} />
            </button>
          </div>
        </div>

        <div className="p-4 overflow-y-auto space-y-2">
          {sets.length === 0 && (
            <p className="text-sm text-ink-soft p-4 text-center">No plan sets yet.</p>
          )}
          {sets.map((ps, i) => {
            const isLatest = i === 0;
            const summary = summarizePlanSet(project, ps.id);
            const editing = editingId === ps.id;
            return (
              <div key={ps.id} className={`rounded-xl border p-4 ${selectedPlanSetId === ps.id ? 'border-accent-300 dark:border-accent-700 bg-accent-50/50 dark:bg-accent-900/20' : 'border-edge'}`}>
                {editing ? (
                  <div className="flex flex-col sm:flex-row sm:items-center gap-2">
                    <input
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      placeholder="Set name"
                      autoFocus
                      className="flex-1 px-3 py-1.5 rounded-lg border border-edge-strong bg-raised text-ink text-sm outline-none focus:ring-2 focus:ring-accent-500"
                    />
                    <input
                      type="date"
                      value={editDate}
                      onChange={(e) => setEditDate(e.target.value)}
                      className="px-3 py-1.5 rounded-lg border border-edge-strong bg-raised text-ink text-sm outline-none focus:ring-2 focus:ring-accent-500"
                    />
                    <div className="flex items-center gap-1">
                      <button onClick={() => saveEdit(ps.id)} aria-label="Save" className="p-1.5 rounded-lg text-green-600 hover:bg-green-50 dark:hover:bg-green-900/30"><Check size={16} /></button>
                      <button onClick={() => setEditingId(null)} aria-label="Cancel" className="p-1.5 rounded-lg text-ink-faint hover:bg-hover"><X size={16} /></button>
                    </div>
                  </div>
                ) : (
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-semibold text-ink truncate">{ps.name}</span>
                        {isLatest && <span className="text-[10px] uppercase tracking-wider font-bold rounded-full px-2 py-0.5 bg-emerald-100 dark:bg-emerald-900/40 text-emerald-700 dark:text-emerald-300">Latest</span>}
                        {ps.date && <span className="text-xs text-ink-faint">{ps.date}</span>}
                      </div>
                      <div className="text-xs text-ink-soft mt-1">
                        {pageCount(ps.id)} page{pageCount(ps.id) === 1 ? '' : 's'}
                        {(summary.newCount > 0 || summary.revisedCount > 0) && (
                          <> · {summary.newCount} new, {summary.revisedCount} revised</>
                        )}
                      </div>
                    </div>
                    <div className="flex items-center gap-1 shrink-0">
                      <button onClick={() => { onSelect(ps.id); onClose(); }} title="View as of this set" aria-label="View as of this set" className="p-1.5 rounded-lg text-ink-faint hover:text-accent-600 hover:bg-hover"><Eye size={16} /></button>
                      <button onClick={() => startEdit(ps.id, ps.name, ps.date)} title="Rename / re-date" aria-label="Rename or re-date" className="p-1.5 rounded-lg text-ink-faint hover:text-accent-600 hover:bg-hover"><Edit2 size={16} /></button>
                      <button onClick={() => onDelete(ps.id)} title="Delete plan set" aria-label="Delete plan set" className="p-1.5 rounded-lg text-ink-faint hover:text-red-500 hover:bg-red-50 dark:hover:bg-red-900/30"><Trash2 size={16} /></button>
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </motion.div>
    </div>
  );
};
