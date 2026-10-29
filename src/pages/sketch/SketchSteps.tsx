// src/pages/sketch/SketchSteps.tsx
// The sketch's steps in order (pulls, spins, runs): pick one to see it on the
// model, change its distance or angle, or delete it. Its shape stays, as an
// outline again; anything drawn on its faces goes with it.
import React, { useEffect, useState } from 'react';
import { AlertTriangle, ArrowUpFromLine, Rotate3d, Route, Trash2, X } from 'lucide-react';
import {
  describeShape, formatLength, parseLength, removeFeature, setPullDistance,
  type SketchDoc, type SketchFeature, type SolidPlan,
} from './sketchModel';

const stepName = (doc: SketchDoc, f: SketchFeature): string => {
  if (f.type === 'spin') return 'Spin';
  if (f.type === 'run') return 'Run along a path';
  const onFace = !!doc.shapes.find(s => s.id === f.shapeId)?.onFeatureId;
  return onFace ? (f.distance < 0 ? 'Cut into the solid' : 'Join onto the solid') : 'Pull';
};

const stepValue = (doc: SketchDoc, f: SketchFeature): string | null => {
  if (f.type === 'pull') return formatLength(Math.abs(f.distance), doc.units);
  if (f.type === 'spin') return `${Math.round(f.angle * 10) / 10}°`;
  return null;
};

const StepIcon: React.FC<{ f: SketchFeature }> = ({ f }) =>
  f.type === 'spin' ? <Rotate3d size={15} /> : f.type === 'run' ? <Route size={15} /> : <ArrowUpFromLine size={15} />;

export const SketchSteps: React.FC<{
  doc: SketchDoc;
  plan: SolidPlan;
  selectedId: string | null;
  editable: boolean;
  onSelect: (featureId: string | null) => void;
  onChange: (doc: SketchDoc) => void;
  onClose: () => void;
  onError: (message: string) => void;
}> = ({ doc, plan, selectedId, editable, onSelect, onChange, onClose, onError }) => {
  const selected = doc.features.find(f => f.id === selectedId);
  const [value, setValue] = useState('');
  useEffect(() => {
    setValue(selected ? (selected.type === 'pull' ? formatLength(Math.abs(selected.distance), doc.units) : selected.type === 'spin' ? String(selected.angle) : '') : '');
  }, [selected, doc.units]);

  const apply = () => {
    if (!selected) return;
    if (selected.type === 'pull') {
      const len = parseLength(value, doc.units);
      if (len === null || len === 0) { onError('Type a distance, e.g. 6 or 1\' 4".'); return; }
      // A plain number keeps the way it pulls; a minus sign turns it round.
      const next = /^\s*[-−]/.test(value) ? -Math.sign(selected.distance) * Math.abs(len) : Math.sign(selected.distance) * Math.abs(len);
      if (next !== selected.distance) onChange(setPullDistance(doc, selected.id, next));
    } else if (selected.type === 'spin') {
      const a = parseFloat(value.replace('°', ''));
      if (!Number.isFinite(a) || a === 0 || Math.abs(a) > 360) { onError('Type an angle from 1 to 360.'); return; }
      if (a !== selected.angle) onChange({ ...doc, features: doc.features.map(f => (f.id === selected.id ? { ...f, angle: a } : f)) });
    }
  };

  return (
    <div className="pointer-events-auto flex max-h-full w-64 flex-col rounded-lg border border-edge bg-raised/95 text-sm shadow-sm" data-testid="sketch-steps">
      <div className="flex items-center justify-between border-b border-edge px-3 py-2">
        <span className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Steps</span>
        <button type="button" onClick={onClose} aria-label="Hide steps" className="rounded p-0.5 text-ink-faint hover:bg-hover hover:text-ink"><X size={14} /></button>
      </div>
      {doc.features.length === 0 ? (
        <p className="px-3 py-3 text-xs text-ink-faint">Pull, spin or run a shape and each step is listed here.</p>
      ) : (
        <ol className="min-h-0 flex-1 overflow-y-auto py-1">
          {doc.features.map((f, i) => {
            const shape = doc.shapes.find(s => s.id === f.shapeId);
            const skip = plan.skipped.get(f.id);
            const isSel = f.id === selectedId;
            const v = stepValue(doc, f);
            return (
              <li key={f.id} data-testid={`sketch-step-${i}`} className={isSel ? 'bg-accent-50 dark:bg-accent-900/25' : ''}>
                <div className="flex items-start gap-2 px-3 py-1.5">
                  <button type="button" onClick={() => onSelect(isSel ? null : f.id)} className="flex min-w-0 flex-1 items-start gap-2 text-left">
                    <span className="mt-0.5 shrink-0 text-ink-faint">{i + 1}.</span>
                    <span className="mt-0.5 shrink-0 text-ink-soft"><StepIcon f={f} /></span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-ink">{stepName(doc, f)}{v ? ` ${v}` : ''}</span>
                      <span className="block truncate text-xs text-ink-faint">{shape ? describeShape(shape, doc.units) : 'Shape deleted'}</span>
                      {skip && <span className="mt-0.5 flex items-start gap-1 text-xs text-amber-700 dark:text-amber-400"><AlertTriangle size={12} className="mt-0.5 shrink-0" />{skip}</span>}
                    </span>
                  </button>
                  {editable && (
                    <button type="button" onClick={() => { onChange(removeFeature(doc, f.id)); if (isSel) onSelect(null); }}
                      aria-label={`Delete step ${i + 1}`} title="Delete this step (its shape stays)" data-testid="sketch-step-delete"
                      className="shrink-0 rounded p-1 text-ink-faint hover:bg-hover hover:text-red-600"><Trash2 size={14} /></button>
                  )}
                </div>
                {isSel && editable && (f.type === 'pull' || f.type === 'spin') && (
                  <form className="flex items-center gap-2 px-3 pb-2 pl-12" onSubmit={e => { e.preventDefault(); apply(); }}>
                    <label className="text-xs text-ink-soft">{f.type === 'pull' ? 'Distance' : 'Angle °'}</label>
                    <input value={value} onChange={e => setValue(e.target.value)} onBlur={apply} data-testid="sketch-step-value"
                      className="w-24 rounded-md border border-edge bg-raised px-2 py-1 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-500" />
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
