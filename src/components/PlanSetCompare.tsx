import React, { useMemo, useState, useRef, useCallback } from 'react';
import { motion } from 'motion/react';
import { GitCompare, X, Columns, Layers as LayersIcon, Contrast, ZoomIn, ZoomOut, Maximize } from 'lucide-react';
import { Project, ProjectPage } from '../types';
import { getImageUrl } from '../utils/store';
import { computeRevisionModel, effectiveSheetId } from '../utils/planSets';

interface Props {
  project: Project;
  pageId: string;
  onClose: () => void;
}

type Mode = 'side' | 'overlay' | 'difference';

const setLabel = (project: Project, page: ProjectPage) => {
  const ps = project.planSets?.find(s => s.id === page.planSetId);
  if (!ps) return 'Unversioned';
  return `${ps.name}${ps.date ? ` · ${ps.date}` : ''}`;
};

// Enlarged, full-screen visual comparison of two revisions of the same sheet.
// Pan/zoom the shared viewport; an opacity slider cross-fades the newer revision
// over the older one. Uses the stored page raster (thumbnail/full image) so it
// works for both legacy and vector pages.
export const PlanSetCompare: React.FC<Props> = ({ project, pageId, onClose }) => {
  const revs = useMemo(() => {
    const model = computeRevisionModel(project, '');
    const page = project.pages.find(p => p.id === pageId);
    const key = page ? effectiveSheetId(page) : null;
    return key ? (model.revisionsBySheet.get(key) || []) : [];
  }, [project, pageId]);

  // Default: newest two revisions (older on the left, newer on the right).
  const [leftId, setLeftId] = useState(() => (revs.length >= 2 ? revs[revs.length - 2].id : revs[0]?.id) || '');
  const [rightId, setRightId] = useState(() => revs[revs.length - 1]?.id || '');
  const [mode, setMode] = useState<Mode>('overlay');
  const [opacity, setOpacity] = useState(50);

  // Shared pan/zoom for the overlay & difference viewports.
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);

  const left = revs.find(p => p.id === leftId);
  const right = revs.find(p => p.id === rightId);
  const src = (p?: ProjectPage) => (p ? getImageUrl(p.thumbnailId || p.imageId) : '');

  const sheetNo = (right || left)?.pageNumber || 'sheet';

  const resetView = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, []);

  const onWheel = useCallback((e: React.WheelEvent) => {
    e.preventDefault();
    setZoom(z => Math.min(8, Math.max(0.2, z * (e.deltaY < 0 ? 1.1 : 0.9))));
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    dragRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
  }, [pan]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    if (!dragRef.current) return;
    setPan({ x: dragRef.current.px + (e.clientX - dragRef.current.x), y: dragRef.current.py + (e.clientY - dragRef.current.y) });
  }, []);

  const onPointerUp = useCallback(() => { dragRef.current = null; }, []);

  const transform = `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`;

  return (
    <div className="fixed inset-0 z-[200] flex flex-col bg-slate-900/95 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Compare revisions">
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.16 }}
        className="flex flex-col h-full w-full"
      >
        <div className="px-4 py-3 border-b border-white/10 flex flex-wrap items-center gap-3 justify-between shrink-0 bg-slate-900/80">
          <h2 className="text-lg font-bold text-white flex items-center gap-2">
            <GitCompare size={18} className="text-accent-400" /> Compare {sheetNo}
          </h2>
          <div className="flex items-center gap-1 bg-white/10 rounded-lg p-1">
            {([['side', 'Side by side', Columns], ['overlay', 'Overlay', LayersIcon], ['difference', 'Difference', Contrast]] as const).map(([m, label, Icon]) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-2.5 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5 transition-all ${mode === m ? 'bg-white text-accent-600 shadow-sm' : 'text-slate-300 hover:text-white'}`}
              >
                <Icon size={14} /> {label}
              </button>
            ))}
          </div>
          {mode !== 'side' && (
            <div className="flex items-center gap-1 bg-white/10 rounded-lg p-1">
              <button onClick={() => setZoom(z => Math.max(0.2, z * 0.8))} title="Zoom out" aria-label="Zoom out" className="p-1.5 rounded-md text-slate-300 hover:text-white hover:bg-white/10"><ZoomOut size={16} /></button>
              <span className="text-xs text-slate-300 w-12 text-center tabular-nums">{Math.round(zoom * 100)}%</span>
              <button onClick={() => setZoom(z => Math.min(8, z * 1.25))} title="Zoom in" aria-label="Zoom in" className="p-1.5 rounded-md text-slate-300 hover:text-white hover:bg-white/10"><ZoomIn size={16} /></button>
              <button onClick={resetView} title="Reset view" aria-label="Reset view" className="p-1.5 rounded-md text-slate-300 hover:text-white hover:bg-white/10"><Maximize size={16} /></button>
            </div>
          )}
          <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-white/10">
            <X size={20} />
          </button>
        </div>

        <div className="px-4 py-3 grid grid-cols-2 gap-3 shrink-0 bg-slate-900/60 border-b border-white/10">
          <div>
            <label className="text-[10px] uppercase tracking-wider font-bold text-slate-400">Left / Base (older)</label>
            <select value={leftId} onChange={(e) => setLeftId(e.target.value)} className="w-full mt-1 px-3 py-1.5 rounded-lg border border-white/15 bg-slate-800 text-white text-sm outline-none">
              {revs.map(p => <option key={p.id} value={p.id}>{setLabel(project, p)}</option>)}
            </select>
          </div>
          <div>
            <label className="text-[10px] uppercase tracking-wider font-bold text-slate-400">Right / Overlay (newer)</label>
            <select value={rightId} onChange={(e) => setRightId(e.target.value)} className="w-full mt-1 px-3 py-1.5 rounded-lg border border-white/15 bg-slate-800 text-white text-sm outline-none">
              {revs.map(p => <option key={p.id} value={p.id}>{setLabel(project, p)}</option>)}
            </select>
          </div>
        </div>

        <div className="flex-1 min-h-0 overflow-hidden bg-slate-950 relative">
          {mode === 'side' && (
            <div className="grid grid-cols-2 gap-4 h-full p-4">
              {[left, right].map((p, i) => (
                <div key={i} className="flex flex-col min-h-0">
                  <div className="text-xs font-medium text-slate-400 mb-1 text-center truncate">{p ? setLabel(project, p) : '—'}</div>
                  <div className="flex-1 min-h-0 flex items-center justify-center bg-white rounded-lg border border-white/10 overflow-hidden">
                    {p ? <img src={src(p)} alt="" className="max-w-full max-h-full object-contain" referrerPolicy="no-referrer" /> : null}
                  </div>
                </div>
              ))}
            </div>
          )}

          {(mode === 'overlay' || mode === 'difference') && (
            <div
              className="absolute inset-0 cursor-grab active:cursor-grabbing touch-none"
              onWheel={onWheel}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
            >
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="relative" style={{ transform, transformOrigin: 'center center' }}>
                  <img src={src(left)} alt="" className="block max-w-none select-none pointer-events-none bg-white" style={{ maxHeight: '80vh' }} referrerPolicy="no-referrer" draggable={false} />
                  <img
                    src={src(right)}
                    alt=""
                    className="absolute inset-0 w-full h-full object-contain select-none pointer-events-none"
                    style={mode === 'difference' ? { mixBlendMode: 'difference' } : { opacity: opacity / 100 }}
                    referrerPolicy="no-referrer"
                    draggable={false}
                  />
                </div>
              </div>
            </div>
          )}
        </div>

        {mode === 'overlay' && (
          <div className="px-6 py-3 border-t border-white/10 flex items-center gap-3 shrink-0 bg-slate-900/80">
            <span className="text-xs text-slate-400 whitespace-nowrap">Base</span>
            <input type="range" min={0} max={100} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} className="flex-1 accent-accent-500" aria-label="Opacity between revisions" />
            <span className="text-xs text-slate-400 whitespace-nowrap">Overlay</span>
          </div>
        )}
        {mode === 'difference' && (
          <div className="px-6 py-3 border-t border-white/10 text-xs text-slate-400 shrink-0 bg-slate-900/80">
            Areas that match appear black; anything that changed between the two revisions shows up bright. Drag to pan, scroll to zoom.
          </div>
        )}
        {mode === 'overlay' && (
          <div className="px-6 pb-3 -mt-1 text-[11px] text-slate-500 shrink-0 bg-slate-900/80">
            Drag to pan, scroll to zoom.
          </div>
        )}
      </motion.div>
    </div>
  );
};
