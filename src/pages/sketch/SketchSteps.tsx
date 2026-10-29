// src/pages/sketch/SketchSteps.tsx
// The sketch's steps in order (pulls, spins, runs, joins and cuts, moves and
// copies): pick one to see it on the model, change its distance, angle or
// copies, or delete it. A deleted pull, spin or run leaves its shape as an
// outline again; anything drawn on its faces goes with it.
import React, { useEffect, useState } from 'react';
import {
  AlertTriangle, ArrowUpFromLine, Combine, FlipHorizontal2, Move, Rotate3d, RotateCw, Route, Trash2, X,
} from 'lucide-react';
import {
  describeShape, formatLength, isShapeFeature, parseLength, removeFeature, setPullDistance,
  type SketchDoc, type SketchFeature, type SolidPlan,
} from './sketchModel';

const round1 = (n: number) => Math.round(n * 10) / 10;

const stepName = (doc: SketchDoc, f: SketchFeature): string => {
  switch (f.type) {
    case 'spin': return `Spin ${round1(f.angle)}°`;
    case 'run': return 'Run along a path';
    case 'combine': return f.mode === 'join' ? 'Join two solids' : 'Cut one solid from another';
    case 'move': {
      const t = f.transform;
      if (t.kind === 'mirror') return f.copies ? 'Mirror copy' : 'Mirror';
      if (t.kind === 'rotate') return f.copies ? `Copy round ×${f.copies}, ${round1(t.angle)}° apart` : `Rotate ${round1(t.angle)}°`;
      const len = formatLength(Math.hypot(...t.by), doc.units);
      return f.copies ? `Copy ×${f.copies}, ${len} apart` : `Move ${len}`;
    }
    case 'pull': {
      const onFace = !!doc.shapes.find(s => s.id === f.shapeId)?.onFeatureId;
      const d = formatLength(Math.abs(f.distance), doc.units);
      return onFace ? (f.distance < 0 ? `Cut into the solid ${d}` : `Join onto the solid ${d}`) : `Pull ${d}`;
    }
  }
};

const StepIcon: React.FC<{ f: SketchFeature }> = ({ f }) => {
  switch (f.type) {
    case 'spin': return <Rotate3d size={15} />;
    case 'run': return <Route size={15} />;
    case 'combine': return <Combine size={15} />;
    case 'move': return f.transform.kind === 'mirror' ? <FlipHorizontal2 size={15} /> : f.transform.kind === 'rotate' ? <RotateCw size={15} /> : <Move size={15} />;
    default: return <ArrowUpFromLine size={15} />;
  }
};

/** What the edit row changes: the first box's label and value, and whether there is a copies box. */
const editable = (doc: SketchDoc, f: SketchFeature): { label: string; value: string; copies: boolean } | null => {
  if (f.type === 'pull') return { label: 'Distance', value: formatLength(Math.abs(f.distance), doc.units), copies: false };
  if (f.type === 'spin') return { label: 'Angle °', value: String(f.angle), copies: false };
  if (f.type === 'move' && f.transform.kind === 'move') return { label: f.copies ? 'Apart' : 'Distance', value: formatLength(Math.hypot(...f.transform.by), doc.units), copies: true };
  if (f.type === 'move' && f.transform.kind === 'rotate') return { label: 'Angle °', value: String(f.transform.angle), copies: true };
  return null;
};

export const SketchSteps: React.FC<{
  doc: SketchDoc;
  plan: SolidPlan;
  selectedId: string | null;
  editable: boolean;
  onSelect: (featureId: string | null) => void;
  onChange: (doc: SketchDoc) => void;
  onClose: () => void;
  onError: (message: string) => void;
}> = ({ doc, plan, selectedId, editable: canEdit, onSelect, onChange, onClose, onError }) => {
  const selected = doc.features.find(f => f.id === selectedId);
  const edit = selected ? editable(doc, selected) : null;
  const [value, setValue] = useState('');
  const [copies, setCopies] = useState('');
  useEffect(() => {
    setValue(edit?.value ?? '');
    setCopies(selected?.type === 'move' ? String(selected.copies) : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, doc.units]);

  const replace = (f: SketchFeature) => onChange({ ...doc, features: doc.features.map(x => (x.id === f.id ? f : x)) });

  const apply = () => {
    if (!selected) return;
    if (selected.type === 'pull') {
      const len = parseLength(value, doc.units);
      if (len === null || len === 0) { onError('Type a distance, e.g. 6 or 1\' 4".'); return; }
      // A plain number keeps the way it pulls; a minus sign turns it round.
      const next = /^\s*[-−]/.test(value) ? -Math.sign(selected.distance) * Math.abs(len) : Math.sign(selected.distance) * Math.abs(len);
      if (next !== selected.distance) onChange(setPullDistance(doc, selected.id, next));
      return;
    }
    const angle = parseFloat(value.replace('°', ''));
    if (selected.type === 'spin') {
      if (!Number.isFinite(angle) || angle === 0 || Math.abs(angle) > 360) { onError('Type an angle from 1 to 360.'); return; }
      if (angle !== selected.angle) replace({ ...selected, angle });
      return;
    }
    if (selected.type !== 'move') return;
    const n = Math.max(0, Math.min(100, parseInt(copies, 10) || 0));
    const t = selected.transform;
    if (t.kind === 'move') {
      const len = parseLength(value, doc.units);
      if (!len) { onError('Type a distance, e.g. 6 or 1\' 4".'); return; }
      const old = Math.hypot(...t.by) || 1;
      const by = t.by.map(v => (v / old) * Math.abs(len)) as typeof t.by;
      if (Math.abs(Math.abs(len) - old) > 1e-9 || n !== selected.copies) replace({ ...selected, transform: { ...t, by }, copies: n });
    } else if (t.kind === 'rotate') {
      if (!Number.isFinite(angle) || angle === 0 || Math.abs(angle) > 360) { onError('Type an angle from 1 to 360 (minus for clockwise).'); return; }
      if (angle !== t.angle || n !== selected.copies) replace({ ...selected, transform: { ...t, angle }, copies: n });
    }
  };

  const inputClass = 'rounded-md border border-edge bg-raised px-2 py-1 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-500';

  return (
    <div className="pointer-events-auto flex min-h-0 w-64 flex-col rounded-lg border border-edge bg-raised/95 text-sm shadow-sm" data-testid="sketch-steps">
      <div className="flex items-center justify-between border-b border-edge px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Steps</span>
        <button type="button" onClick={onClose} aria-label="Hide steps" className="rounded p-0.5 text-ink-faint hover:bg-hover hover:text-ink"><X size={14} /></button>
      </div>
      {doc.features.length === 0 ? (
        <p className="px-3 py-3 text-xs text-ink-faint">Pull, spin or run a shape and each step is listed here.</p>
      ) : (
        <ol className="min-h-0 flex-1 overflow-y-auto py-1">
          {doc.features.map((f, i) => {
            const shape = isShapeFeature(f) ? doc.shapes.find(s => s.id === f.shapeId) : undefined;
            const skip = plan.skipped.get(f.id);
            const isSel = f.id === selectedId;
            const ed = isSel ? edit : null;
            return (
              <li key={f.id} data-testid={`sketch-step-${i}`} className={isSel ? 'bg-accent-50 dark:bg-accent-900/25' : ''}>
                <div className="flex items-start gap-2 px-3 py-1.5">
                  <button type="button" onClick={() => onSelect(isSel ? null : f.id)} className="flex min-w-0 flex-1 items-start gap-2 text-left">
                    <span className="mt-0.5 shrink-0 text-ink-faint">{i + 1}.</span>
                    <span className="mt-0.5 shrink-0 text-ink-soft"><StepIcon f={f} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-ink">{stepName(doc, f)}</span>
                      {isShapeFeature(f) && <span className="block truncate text-xs text-ink-faint">{shape ? describeShape(shape, doc.units) : 'Shape deleted'}</span>}
                      {skip && <span className="mt-0.5 flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400"><AlertTriangle size={12} className="mt-0.5 shrink-0" />{skip}</span>}
                    </span>
                  </button>
                  {canEdit && (
                    <button type="button" onClick={() => { onChange(removeFeature(doc, f.id)); if (isSel) onSelect(null); }}
                      aria-label={`Delete step ${i + 1}`} title={isShapeFeature(f) ? 'Delete this step (its shape stays)' : 'Delete this step'} data-testid="sketch-step-delete"
                      className="shrink-0 rounded p-1 text-ink-faint hover:bg-hover hover:text-red-600"><Trash2 size={14} /></button>
                  )}
                </div>
                {ed && canEdit && (
                  <form className="flex flex-wrap items-center gap-2 px-3 pb-2 pl-12" onSubmit={e => { e.preventDefault(); apply(); }}>
                    <label className="flex items-center gap-1.5 text-xs text-ink-soft">
                      {ed.label}
                      <input value={value} onChange={e => setValue(e.target.value)} onBlur={apply} data-testid="sketch-step-value" className={`w-24 ${inputClass}`} />
                    </label>
                    {ed.copies && (
                      <label className="flex items-center gap-1.5 text-xs text-ink-soft">
                        Copies
                        <input value={copies} onChange={e => setCopies(e.target.value.replace(/[^0-9]/g, ''))} onBlur={apply} inputMode="numeric"
                          data-testid="sketch-step-copies" className={`w-12 ${inputClass}`} />
                      </label>
                    )}
                    <button type="submit" className="sr-only">Apply</button>
                  </form>
                )}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
};
