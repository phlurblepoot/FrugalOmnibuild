// src/pages/sketch/SketchRefs.tsx
// The sketch's reference photos: pick one to show it as picked, fade it,
// turn it, set its scale from a length you know, move it, hide it or take it
// off (its file stays in Documents).
import React, { useEffect, useState } from 'react';
import { Eye, EyeOff, Image as ImageIcon, Move, Ruler, Trash2 } from 'lucide-react';
import { formatLength, type ReferencePhoto, type SketchUnits } from './sketchModel';

export const SketchRefs: React.FC<{
  refs: ReferencePhoto[];
  units: SketchUnits;
  selectedId: string | null;
  editable: boolean;
  onSelect: (refId: string | null) => void;
  onUpdate: (refId: string, change: (r: ReferencePhoto) => ReferencePhoto) => void;
  onRemove: (refId: string) => void;
  onScale: (refId: string) => void;
  onMove: (refId: string) => void;
}> = ({ refs, units, selectedId, editable, onSelect, onUpdate, onRemove, onScale, onMove }) => {
  const selected = refs.find(r => r.id === selectedId);
  const [turn, setTurn] = useState('');
  useEffect(() => { setTurn(selected ? String(Math.round(selected.rotation * 10) / 10) : ''); }, [selected]);
  // The opacity slider moves freely and is saved (one undo step) when let go.
  const [fade, setFade] = useState<number | null>(null);
  useEffect(() => { setFade(null); }, [selectedId]);

  if (refs.length === 0) return null;

  const applyTurn = () => {
    if (!selected) return;
    const deg = parseFloat(turn.replace('°', ''));
    if (Number.isFinite(deg) && deg !== selected.rotation) onUpdate(selected.id, r => ({ ...r, rotation: deg }));
  };

  const buttonClass = 'flex items-center gap-1 rounded-md border border-edge px-2 py-1 text-xs font-medium text-ink-soft hover:bg-hover hover:text-ink';

  return (
    <div className="pointer-events-auto flex w-64 shrink-0 flex-col rounded-lg border border-edge bg-raised/95 text-sm shadow-sm" data-testid="sketch-refs">
      <div className="border-b border-edge px-3 py-2 text-xs font-semibold uppercase tracking-wide text-ink-faint">Reference photos</div>
      <ul className="max-h-72 overflow-y-auto py-1">
        {refs.map((r, i) => {
          const isSel = r.id === selectedId;
          return (
            <li key={r.id} data-testid={`sketch-ref-${i}`} className={isSel ? 'bg-accent-50 dark:bg-accent-900/25' : ''}>
              <div className="flex items-center gap-2 px-3 py-1.5">
                <button type="button" onClick={() => onSelect(isSel ? null : r.id)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  <ImageIcon size={15} className="shrink-0 text-ink-soft" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-ink">{r.name}</span>
                    <span className="block truncate text-xs text-ink-faint">{formatLength(r.width, units)} across</span>
                  </span>
                </button>
                <button type="button" onClick={() => onUpdate(r.id, x => ({ ...x, hidden: !x.hidden }))} disabled={!editable}
                  aria-label={r.hidden ? 'Show the photo' : 'Hide the photo'} title={r.hidden ? 'Show' : 'Hide'} data-testid="sketch-ref-visible"
                  className="shrink-0 rounded p-1 text-ink-faint hover:bg-hover hover:text-ink disabled:opacity-40">{r.hidden ? <EyeOff size={14} /> : <Eye size={14} />}</button>
                {editable && (
                  <button type="button" onClick={() => onRemove(r.id)} aria-label="Take the photo off the sketch" title="Take it off (its file stays in Documents)"
                    data-testid="sketch-ref-delete" className="shrink-0 rounded p-1 text-ink-faint hover:bg-hover hover:text-red-600"><Trash2 size={14} /></button>
                )}
              </div>
              {isSel && editable && (
                <div className="space-y-2 px-3 pb-2 pl-9">
                  <div className="flex flex-wrap gap-1.5">
                    <button type="button" onClick={() => onScale(r.id)} className={buttonClass} data-testid="sketch-ref-scale"
                      title="Click two points on the photo a known length apart, then type that length"><Ruler size={13} />Set scale</button>
                    <button type="button" onClick={() => onMove(r.id)} className={buttonClass} data-testid="sketch-ref-move"
                      title="Click a point on the photo, then where it should go"><Move size={13} />Move</button>
                  </div>
                  <label className="flex items-center gap-2 text-xs text-ink-soft">
                    Fade
                    <input type="range" min={10} max={100} step={5} value={Math.round((fade ?? r.opacity) * 100)} data-testid="sketch-ref-opacity"
                      onChange={e => setFade(Number(e.target.value) / 100)}
                      onPointerUp={() => { if (fade !== null) onUpdate(r.id, x => ({ ...x, opacity: fade })); }}
                      onKeyUp={() => { if (fade !== null) onUpdate(r.id, x => ({ ...x, opacity: fade })); }}
                      onBlur={() => { if (fade !== null && fade !== r.opacity) onUpdate(r.id, x => ({ ...x, opacity: fade })); }}
                      className="min-w-0 flex-1 accent-accent-600" />
                  </label>
                  <form className="flex items-center gap-2 text-xs text-ink-soft" onSubmit={e => { e.preventDefault(); applyTurn(); }}>
                    <label className="flex items-center gap-1.5">
                      Turn °
                      <input value={turn} onChange={e => setTurn(e.target.value)} onBlur={applyTurn} data-testid="sketch-ref-turn"
                        className="w-16 rounded-md border border-edge bg-raised px-2 py-1 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-500" />
                    </label>
                    <button type="submit" className="sr-only">Apply</button>
                  </form>
                </div>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
};
