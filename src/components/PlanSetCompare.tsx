import React, { useMemo, useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { motion } from 'motion/react';
import {
  GitCompare, X, Columns, Layers as LayersIcon, Contrast, ZoomIn, ZoomOut, Maximize, ArrowLeftRight,
  Move, Ruler, Loader2, AlertTriangle, ChevronUp, ChevronDown, ChevronLeft, ChevronRight, Wand2, RotateCcw,
} from 'lucide-react';
import { Measurement, Point, Project, ProjectPage } from '../types';
import { computeRevisionModel, effectiveSheetId } from '../utils/planSets';
import {
  Alignment, ChangeMap, IDENTITY_ALIGNMENT, SheetImage, autoAlign, changeMap, diffPixels, inkOf,
  loadFullSheet, loadPreviewSheet, touchesChange, DIFF_COLORS,
} from '../utils/compareImages';

interface Props {
  project: Project;
  /** The page compare was opened from; it is one of the two sides. */
  pageId: string;
  onClose: () => void;
  /** Open a revision on the drawing screen. */
  onOpenPage?: (pageId: string) => void;
}

type Mode = 'side' | 'overlay' | 'difference';

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 40;
/** Long edge, in pixels, of the change map behind the difference view. */
const DIFF_LONG_EDGE = 3000;
/** Below this share of matching linework, auto-align says it couldn't match. */
const GOOD_FIT = 0.35;

const setLabel = (project: Project, page: ProjectPage) => {
  const ps = project.planSets?.find(s => s.id === page.planSetId);
  if (!ps) return 'No plan set';
  return `${ps.name}${ps.date ? ` · ${ps.date}` : ''}`;
};

const alignKey = (leftId: string, rightId: string) => `compareAlign:${leftId}>${rightId}`;

const readSavedAlign = (leftId: string, rightId: string): Alignment | null => {
  try {
    const raw = localStorage.getItem(alignKey(leftId, rightId));
    if (!raw) return null;
    const a = JSON.parse(raw);
    if (typeof a?.dx === 'number' && typeof a?.dy === 'number' && typeof a?.scale === 'number') return a;
  } catch { /* storage unavailable */ }
  return null;
};

const saveAlign = (leftId: string, rightId: string, a: Alignment | null) => {
  try {
    if (a) localStorage.setItem(alignKey(leftId, rightId), JSON.stringify(a));
    else localStorage.removeItem(alignKey(leftId, rightId));
  } catch { /* storage unavailable */ }
};

/** Puts an existing canvas element into the page (a canvas can be in one place
 *  at a time; each mode shows each sheet once). */
const CanvasHost: React.FC<{ canvas: HTMLCanvasElement; style: React.CSSProperties; testId?: string }> = ({ canvas, style, testId }) => {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const host = ref.current;
    if (!host) return;
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';
    host.appendChild(canvas);
    return () => { if (canvas.parentNode === host) host.removeChild(canvas); };
  }, [canvas]);
  return <div ref={ref} data-testid={testId} className="absolute bg-white select-none pointer-events-none" style={style} />;
};

/** A page's takeoffs drawn over it, in its own sheet units. */
const TakeoffLayer: React.FC<{
  project: Project;
  page: ProjectPage;
  style: React.CSSProperties;
  flagged?: Set<string>;
  dimOthers?: boolean;
  testId?: string;
}> = ({ project, page, style, flagged, dimOthers, testId }) => {
  const colorOf = (m: Measurement) => project.takeoffs.find(t => t.id === m.takeoffId)?.color || m.color || '#2563eb';
  const r = Math.max(page.imageWidth, page.imageHeight) / 250;
  const shapes = page.measurements.filter(m => m.type !== 'scale');
  return (
    <svg
      data-testid={testId}
      className="absolute pointer-events-none overflow-visible"
      style={style}
      viewBox={`0 0 ${page.imageWidth} ${page.imageHeight}`}
      preserveAspectRatio="none"
    >
      {shapes.map(m => {
        const hit = flagged?.has(m.id);
        const color = hit ? '#f59e0b' : colorOf(m);
        const opacity = dimOthers && flagged && !hit ? 0.35 : 1;
        const paths: { pts: Point[]; subtract?: boolean }[] = [{ pts: m.points }, ...(m.segments || []).map(s => ({ pts: s.points, subtract: s.subtract }))];
        return (
          <g key={m.id} opacity={opacity} data-flagged={hit ? 'true' : undefined}>
            {paths.map((p, i) => {
              if (!p.pts?.length) return null;
              const d = p.pts.map(pt => `${pt.x},${pt.y}`).join(' ');
              if (m.type === 'count') {
                return p.pts.map((pt, k) => (
                  <circle key={`${i}-${k}`} cx={pt.x} cy={pt.y} r={r} fill={color} fillOpacity={0.5} stroke={color} strokeWidth={hit ? 4 : 2} vectorEffect="non-scaling-stroke" />
                ));
              }
              if (m.type === 'area') {
                return <polygon key={i} points={d} fill={color} fillOpacity={p.subtract ? 0 : 0.15} stroke={color} strokeWidth={hit ? 4 : 2} strokeDasharray={p.subtract ? '6 4' : undefined} vectorEffect="non-scaling-stroke" />;
              }
              return <polyline key={i} points={d} fill="none" stroke={color} strokeWidth={hit ? 5 : 3} strokeLinecap="round" strokeLinejoin="round" vectorEffect="non-scaling-stroke" />;
            })}
          </g>
        );
      })}
    </svg>
  );
};

// Full-screen visual comparison of two revisions of the same sheet. Both sheets
// are drawn full size in a shared space (the left sheet's units) with the right
// sheet lined up on it, so side by side, overlay and difference all pan and
// zoom together and point at the same spot.
export const PlanSetCompare: React.FC<Props> = ({ project, pageId, onClose, onOpenPage }) => {
  const { revs, revNumber, latestId } = useMemo(() => {
    const model = computeRevisionModel(project, '');
    const page = project.pages.find(p => p.id === pageId);
    const key = page ? effectiveSheetId(page) : null;
    return {
      revs: key ? (model.revisionsBySheet.get(key) || []) : [],
      revNumber: model.revisionNumberByPageId,
      latestId: key ? model.latestPageIdBySheet.get(key) : undefined,
    };
  }, [project, pageId]);

  // Opened from a page: compare it with the current revision, or (when it is
  // the current one) with the revision just before it. Older on the left.
  const [leftId, setLeftId] = useState(() => {
    const i = revs.findIndex(p => p.id === pageId);
    if (revs.length < 2) return revs[0]?.id || '';
    if (i < 0 || i === revs.length - 1) return revs[revs.length - 2].id;
    return revs[i].id;
  });
  const [rightId, setRightId] = useState(() => {
    const i = revs.findIndex(p => p.id === pageId);
    if (i === revs.length - 1 || i < 0) return revs[revs.length - 1]?.id || '';
    return revs[revs.length - 1].id;
  });

  const left = revs.find(p => p.id === leftId);
  const right = revs.find(p => p.id === rightId);

  const pickLeft = (id: string) => {
    if (id === rightId) setRightId(leftId);
    setLeftId(id);
  };
  const pickRight = (id: string) => {
    if (id === leftId) setLeftId(rightId);
    setRightId(id);
  };
  const swap = () => { setLeftId(rightId); setRightId(leftId); };

  const [mode, setMode] = useState<Mode>('overlay');
  const [opacity, setOpacity] = useState(50);
  const [showTakeoffs, setShowTakeoffs] = useState(false);
  const [alignOpen, setAlignOpen] = useState(false);

  // ── Sheet images (preview first, then full size) ─────────────────────────
  const [sheets, setSheets] = useState<Record<string, SheetImage>>({});
  const [fullDone, setFullDone] = useState<Record<string, boolean>>({});
  const [loadErrors, setLoadErrors] = useState<Record<string, string>>({});
  const startedRef = useRef(new Set<string>());
  const sheetsRef = useRef(sheets);
  sheetsRef.current = sheets;
  const mountedRef = useRef(true);
  useEffect(() => () => { mountedRef.current = false; }, []);

  // Each revision is drawn once per visit (project updates don't redraw it).
  const leftPage = left;
  const rightPage = right;
  useEffect(() => {
    for (const p of [leftPage, rightPage]) {
      if (!p || startedRef.current.has(p.id)) continue;
      startedRef.current.add(p.id);
      loadPreviewSheet(p)
        .then(img => { if (mountedRef.current) setSheets(s => (s[p.id] ? s : { ...s, [p.id]: img })); })
        .catch(() => { /* the full sheet below reports errors */ });
      loadFullSheet(p)
        .then(img => { if (mountedRef.current) setSheets(s => ({ ...s, [p.id]: img })); })
        .catch(err => {
          console.warn('Compare: could not draw the full sheet', err);
          if (mountedRef.current) setLoadErrors(e => ({ ...e, [p.id]: 'Could not load the full-size sheet' }));
        })
        .finally(() => { if (mountedRef.current) setFullDone(d => ({ ...d, [p.id]: true })); });
    }
  }, [leftPage?.id, rightPage?.id]);

  // Free the big canvases when compare closes.
  useEffect(() => () => {
    for (const img of Object.values(sheetsRef.current)) { img.canvas.width = 0; img.canvas.height = 0; }
  }, []);

  const leftImg = left ? sheets[left.id] : undefined;
  const rightImg = right ? sheets[right.id] : undefined;
  const bothFullOrFinal = !!left && !!right && !!leftImg && !!rightImg && !!fullDone[left.id] && !!fullDone[right.id];
  const previewOnly = [left, right].filter((p): p is ProjectPage =>
    !!p && !p.sourcePdfFileId && !p.imageId);

  // The shared frame: the left sheet's units.
  const frameW = left?.imageWidth || 1;
  const frameH = left?.imageHeight || 1;

  // ── Alignment ────────────────────────────────────────────────────────────
  const [align, setAlign] = useState<Alignment>(IDENTITY_ALIGNMENT);
  const [alignStatus, setAlignStatus] = useState<'pending' | 'auto' | 'nomatch' | 'saved' | 'manual'>('pending');
  const [aligning, setAligning] = useState(false);
  const pairKey = `${leftId}>${rightId}`;
  const alignedPairRef = useRef<string>('');

  const runAutoAlign = useCallback((keepScale?: number) => {
    if (!leftImg || !rightImg) return;
    setAligning(true);
    // Let the spinner paint before the (brief) search blocks the thread.
    setTimeout(() => {
      try {
        const { align: a, fit } = autoAlign(leftImg, rightImg, frameW, frameH, keepScale ?? 1);
        if (fit >= GOOD_FIT) {
          setAlign(a);
          setAlignStatus('auto');
          // Only hand alignments are remembered; this is redone each visit.
          saveAlign(leftId, rightId, null);
        } else {
          setAlign({ ...IDENTITY_ALIGNMENT, scale: keepScale ?? 1 });
          setAlignStatus('nomatch');
        }
      } catch (err) {
        console.warn('Compare: auto-align failed', err);
        setAlignStatus('nomatch');
      } finally {
        setAligning(false);
      }
    }, 30);
  }, [leftImg, rightImg, frameW, frameH, leftId, rightId]);

  // Each pair is lined up once its full sheets are in: a saved alignment if
  // there is one (from an earlier look or a hand tweak), else automatically.
  useEffect(() => {
    if (!left || !right || !bothFullOrFinal) return;
    if (alignedPairRef.current === pairKey) return;
    alignedPairRef.current = pairKey;
    const saved = readSavedAlign(left.id, right.id);
    if (saved) { setAlign(saved); setAlignStatus('saved'); return; }
    runAutoAlign();
  }, [left, right, bothFullOrFinal, pairKey, runAutoAlign]);

  useEffect(() => {
    if (alignedPairRef.current !== pairKey) { setAlign(IDENTITY_ALIGNMENT); setAlignStatus('pending'); }
  }, [pairKey]);

  const nudge = useCallback((patch: Partial<Alignment>) => {
    setAlign(a => {
      const next = { ...a, ...patch };
      saveAlign(leftId, rightId, next);
      return next;
    });
    setAlignStatus('manual');
  }, [leftId, rightId]);

  const resetAlign = () => {
    setAlign(IDENTITY_ALIGNMENT);
    saveAlign(leftId, rightId, IDENTITY_ALIGNMENT);
    setAlignStatus('manual');
  };

  // ── Pan / zoom (shared by every view and both side-by-side panes) ─────────
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const dragRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const [viewSize, setViewSize] = useState({ w: 800, h: 600 });

  useEffect(() => {
    const el = viewRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewSize({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setViewSize({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  // Side by side splits the view into two panes; each shows the same window.
  const paneW = mode === 'side' ? Math.max(1, (viewSize.w - 12) / 2) : viewSize.w;
  const paneH = viewSize.h;
  const fit = Math.min(paneW / frameW, paneH / frameH) * 0.96;
  const unitPx = fit * zoom; // screen pixels per sheet unit

  const resetView = useCallback(() => { setZoom(1); setPan({ x: 0, y: 0 }); }, []);

  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const zoomAt = useCallback((factor: number, cx = 0, cy = 0) => {
    const z = zoomRef.current;
    const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * factor));
    const k = nz / z;
    zoomRef.current = nz;
    setZoom(nz);
    setPan(p => ({ x: cx - (cx - p.x) * k, y: cy - (cy - p.y) * k }));
  }, []);

  const onWheel = useCallback((e: React.WheelEvent<HTMLDivElement>) => {
    const box = e.currentTarget.getBoundingClientRect();
    zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX - box.left - box.width / 2, e.clientY - box.top - box.height / 2);
  }, [zoomAt]);

  // One finger or the mouse drags; two fingers pinch-zoom around their midpoint.
  const pointersRef = useRef(new Map<number, { x: number; y: number }>());
  const pinchRef = useRef<{ dist: number } | null>(null);
  const onPointerDown = useCallback((e: React.PointerEvent) => {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      pinchRef.current = { dist: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
      dragRef.current = null;
    } else if (pointersRef.current.size === 1) {
      dragRef.current = { x: e.clientX, y: e.clientY, px: pan.x, py: pan.y };
    }
  }, [pan]);
  const onPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!pointersRef.current.has(e.pointerId)) return;
    pointersRef.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinchRef.current && pointersRef.current.size === 2) {
      const [a, b] = [...pointersRef.current.values()];
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1;
      const box = e.currentTarget.getBoundingClientRect();
      zoomAt(dist / pinchRef.current.dist, (a.x + b.x) / 2 - box.left - box.width / 2, (a.y + b.y) / 2 - box.top - box.height / 2);
      pinchRef.current.dist = dist;
      return;
    }
    if (!dragRef.current) return;
    setPan({ x: dragRef.current.px + (e.clientX - dragRef.current.x), y: dragRef.current.py + (e.clientY - dragRef.current.y) });
  }, [zoomAt]);
  const onPointerUp = useCallback((e: React.PointerEvent) => {
    pointersRef.current.delete(e.pointerId);
    if (pointersRef.current.size < 2) pinchRef.current = null;
    dragRef.current = null;
  }, []);

  // Close on Escape; arrow keys nudge the right sheet while aligning.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onClose(); return; }
      if (!alignOpen || (e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'SELECT') return;
      const step = (e.shiftKey ? 10 : 1) / unitPx;
      const d: Record<string, [number, number]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] };
      const mv = d[e.key];
      if (!mv) return;
      e.preventDefault();
      nudge({ dx: align.dx + mv[0], dy: align.dy + mv[1] });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, alignOpen, unitPx, nudge, align]);

  // ── Change map (difference view + takeoffs on changes) ────────────────────
  const [diff, setDiff] = useState<{ key: string; canvas: HTMLCanvasElement; changes: ChangeMap; ppu: number } | null>(null);
  const [diffBusy, setDiffBusy] = useState(false);
  const diffRef = useRef(diff);
  diffRef.current = diff;
  useEffect(() => () => {
    if (diffRef.current) { diffRef.current.canvas.width = 0; diffRef.current.canvas.height = 0; }
  }, []);
  const needDiff = mode === 'difference' || showTakeoffs;
  const diffKey = `${pairKey}|${align.dx.toFixed(2)},${align.dy.toFixed(2)},${align.scale.toFixed(5)}|${leftImg?.quality}|${rightImg?.quality}`;

  useEffect(() => {
    if (!needDiff || !leftImg || !rightImg || diff?.key === diffKey) return;
    setDiffBusy(true);
    const t = setTimeout(() => {
      try {
        const ppu = Math.min(1, DIFF_LONG_EDGE / Math.max(frameW, frameH));
        const older = inkOf(leftImg, frameW, frameH, ppu);
        const newer = inkOf(rightImg, frameW, frameH, ppu, align);
        const changes = changeMap(older, newer);
        const canvas = document.createElement('canvas');
        canvas.width = changes.w;
        canvas.height = changes.h;
        canvas.getContext('2d')!.putImageData(new ImageData(diffPixels(older, newer, changes), changes.w, changes.h), 0, 0);
        setDiff(prev => {
          if (prev) { prev.canvas.width = 0; prev.canvas.height = 0; }
          return { key: diffKey, canvas, changes, ppu };
        });
      } catch (err) {
        console.warn('Compare: could not work out the changes', err);
      } finally {
        setDiffBusy(false);
      }
    }, 250);
    return () => { clearTimeout(t); setDiffBusy(false); };
  }, [needDiff, leftImg, rightImg, diffKey, diff?.key, frameW, frameH, align]);

  // Takeoffs on the right (newer) revision that sit on changed linework.
  const flagged = useMemo(() => {
    const out = { right: new Set<string>(), left: new Set<string>() };
    if (!diff || !right || !left || diff.key !== diffKey) return out;
    const radius = Math.max(frameW, frameH) / 400;
    for (const m of right.measurements) {
      if (m.type === 'scale') continue;
      if (touchesChange(m, diff.changes, diff.ppu, p => ({ x: align.dx + p.x * align.scale, y: align.dy + p.y * align.scale }), radius)) out.right.add(m.id);
    }
    for (const m of left.measurements) {
      if (m.type === 'scale') continue;
      if (touchesChange(m, diff.changes, diff.ppu, p => p, radius)) out.left.add(m.id);
    }
    return out;
  }, [diff, diffKey, right, left, align, frameW, frameH]);

  const flaggedList = useMemo(() => (right ? right.measurements.filter(m => flagged.right.has(m.id)) : []), [right, flagged]);

  const zoomToMeasurement = (m: Measurement) => {
    const pts = [m.points, ...(m.segments || []).map(s => s.points)].flat()
      .map(p => ({ x: align.dx + p.x * align.scale, y: align.dy + p.y * align.scale }));
    if (!pts.length) return;
    const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const pad = Math.max(frameW, frameH) / 40;
    const bw = maxX - minX + pad * 2, bh = maxY - minY + pad * 2;
    const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.min(paneW / bw, paneH / bh) / fit));
    const u = fit * nz;
    setZoom(nz);
    setPan({ x: -((minX + maxX) / 2 - frameW / 2) * u, y: -((minY + maxY) / 2 - frameH / 2) * u });
  };

  // ── Layout helpers ────────────────────────────────────────────────────────
  const frameStyle = (w: number, h: number): React.CSSProperties => ({
    position: 'absolute',
    left: w / 2 + pan.x,
    top: h / 2 + pan.y,
    width: frameW,
    height: frameH,
    transform: `scale(${unitPx}) translate(${-frameW / 2}px, ${-frameH / 2}px)`,
    transformOrigin: '0 0',
  });
  const fullFrame: React.CSSProperties = { left: 0, top: 0, width: frameW, height: frameH };
  const rightBox: React.CSSProperties = right
    ? { left: align.dx, top: align.dy, width: right.imageWidth * align.scale, height: right.imageHeight * align.scale }
    : fullFrame;

  const viewportHandlers = {
    onWheel,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    onPointerCancel: onPointerUp,
  };

  const optionLabel = (p: ProjectPage) =>
    `Rev ${revNumber.get(p.id) ?? '?'} · ${setLabel(project, p)} · ${p.pageNumber || p.name}${p.id === latestId ? ' (current)' : ''}`;

  const revName = (p?: ProjectPage) => (p ? `Rev ${revNumber.get(p.id) ?? '?'}` : '—');
  const leftIsNewer = !!left && !!right && (revNumber.get(left.id) ?? 0) > (revNumber.get(right.id) ?? 0);

  const loadingFull = !!left && !!right && !bothFullOrFinal;

  const alignMessage = (() => {
    if (aligning) return 'Lining the sheets up…';
    switch (alignStatus) {
      case 'auto': {
        const mx = Math.round(align.dx / 2), my = Math.round(align.dy / 2);
        return mx === 0 && my === 0 ? 'Sheets already line up' : `Lined up automatically (${revName(right)} moved ${Math.abs(mx)} pt ${mx < 0 ? 'left' : 'right'}, ${Math.abs(my)} pt ${my < 0 ? 'up' : 'down'})`;
      }
      case 'nomatch': return "Couldn't line these up automatically — use Align to nudge them by hand";
      case 'saved': return 'Using your saved alignment';
      case 'manual': return 'Aligned by hand';
      default: return loadingFull ? 'Waiting for full-size sheets…' : '';
    }
  })();

  if (revs.length < 2 || !left || !right) {
    return (
      <div className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/95" role="dialog" aria-modal="true" aria-label="Compare revisions">
        <div className="text-center text-slate-200 space-y-4">
          <p>This sheet has only one revision, so there's nothing to compare yet.</p>
          <button onClick={onClose} className="px-4 py-2 rounded-lg bg-white/10 hover:bg-white/20">Close</button>
        </div>
      </div>
    );
  }

  const takeoffToggle = (
    <button
      data-testid="compare-takeoffs-toggle"
      onClick={() => setShowTakeoffs(s => !s)}
      aria-pressed={showTakeoffs}
      title="Show each revision's takeoffs"
      className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all ${showTakeoffs ? 'bg-white text-accent-600 shadow-sm' : 'bg-white/10 text-slate-300 hover:text-white'}`}
    >
      <Ruler size={14} /> Takeoffs
    </button>
  );

  return (
    <div className="fixed inset-0 z-[200] flex flex-col bg-slate-900/95 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label="Compare revisions" data-testid="compare-dialog">
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.16 }}
        className="flex flex-col h-full w-full"
      >
        {/* Toolbar */}
        <div className="px-4 py-3 border-b border-white/10 flex flex-wrap items-center gap-3 justify-between shrink-0 bg-slate-900/80">
          <h2 className="text-lg font-bold text-white flex items-center gap-2 min-w-0">
            <GitCompare size={18} className="text-accent-400 shrink-0" /> <span className="truncate">Compare {right.pageNumber || left.pageNumber || 'sheet'}</span>
          </h2>
          <div className="flex items-center gap-1 bg-white/10 rounded-lg p-1">
            {([['side', 'Side by side', Columns], ['overlay', 'Overlay', LayersIcon], ['difference', 'Difference', Contrast]] as const).map(([m, label, Icon]) => (
              <button
                key={m}
                data-testid={`compare-mode-${m}`}
                onClick={() => setMode(m)}
                aria-pressed={mode === m}
                className={`px-2.5 py-1.5 rounded-md text-xs font-medium flex items-center gap-1.5 transition-all ${mode === m ? 'bg-white text-accent-600 shadow-sm' : 'text-slate-300 hover:text-white'}`}
              >
                <Icon size={14} /> <span className="hidden sm:inline">{label}</span>
              </button>
            ))}
          </div>
          <div className="flex items-center gap-2">
            {takeoffToggle}
            <button
              data-testid="compare-align-toggle"
              onClick={() => setAlignOpen(o => !o)}
              aria-pressed={alignOpen}
              title="Line the two sheets up"
              className={`px-2.5 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1.5 transition-all ${alignOpen ? 'bg-white text-accent-600 shadow-sm' : 'bg-white/10 text-slate-300 hover:text-white'}`}
            >
              <Move size={14} /> Align
            </button>
            <div className="flex items-center gap-1 bg-white/10 rounded-lg p-1">
              <button onClick={() => zoomAt(1 / 1.25)} title="Zoom out" aria-label="Zoom out" className="p-1.5 rounded-md text-slate-300 hover:text-white hover:bg-white/10"><ZoomOut size={16} /></button>
              <span className="text-xs text-slate-300 w-12 text-center tabular-nums" data-testid="compare-zoom">{Math.round(zoom * 100)}%</span>
              <button onClick={() => zoomAt(1.25)} title="Zoom in" aria-label="Zoom in" className="p-1.5 rounded-md text-slate-300 hover:text-white hover:bg-white/10"><ZoomIn size={16} /></button>
              <button onClick={resetView} title="Fit sheet" aria-label="Fit sheet" className="p-1.5 rounded-md text-slate-300 hover:text-white hover:bg-white/10"><Maximize size={16} /></button>
            </div>
            <button onClick={onClose} aria-label="Close" className="p-1.5 rounded-lg text-slate-300 hover:text-white hover:bg-white/10">
              <X size={20} />
            </button>
          </div>
        </div>

        {/* Revision pickers */}
        <div className="px-4 py-3 flex items-end gap-2 shrink-0 bg-slate-900/60 border-b border-white/10">
          <div className="flex-1 min-w-0">
            <label htmlFor="compare-left" className="text-[10px] uppercase tracking-wider font-bold text-slate-400">Left / base</label>
            <select id="compare-left" data-testid="compare-left-select" value={leftId} onChange={(e) => pickLeft(e.target.value)} className="w-full mt-1 px-3 py-1.5 rounded-lg border border-white/15 bg-slate-800 text-white text-sm outline-none">
              {revs.map(p => <option key={p.id} value={p.id}>{optionLabel(p)}</option>)}
            </select>
          </div>
          <button
            data-testid="compare-swap"
            onClick={swap}
            title="Swap left and right"
            aria-label="Swap left and right"
            className="mb-0.5 p-2 rounded-lg bg-white/10 text-slate-300 hover:text-white hover:bg-white/20 shrink-0"
          >
            <ArrowLeftRight size={16} />
          </button>
          <div className="flex-1 min-w-0">
            <label htmlFor="compare-right" className="text-[10px] uppercase tracking-wider font-bold text-slate-400">Right / overlay</label>
            <select id="compare-right" data-testid="compare-right-select" value={rightId} onChange={(e) => pickRight(e.target.value)} className="w-full mt-1 px-3 py-1.5 rounded-lg border border-white/15 bg-slate-800 text-white text-sm outline-none">
              {revs.map(p => <option key={p.id} value={p.id}>{optionLabel(p)}</option>)}
            </select>
          </div>
        </div>

        {/* Align panel */}
        {alignOpen && (
          <div data-testid="compare-align-panel" className="px-4 py-2 flex flex-wrap items-center gap-3 shrink-0 bg-slate-800/80 border-b border-white/10 text-xs text-slate-300">
            <span>Move the right sheet:</span>
            <div className="flex items-center gap-1">
              {([['left', ChevronLeft, -1, 0], ['up', ChevronUp, 0, -1], ['down', ChevronDown, 0, 1], ['right', ChevronRight, 1, 0]] as const).map(([dir, Icon, sx, sy]) => (
                <button
                  key={dir}
                  data-testid={`compare-nudge-${dir}`}
                  onClick={(e) => { const step = (e.shiftKey ? 10 : 1) / unitPx; nudge({ dx: align.dx + sx * step, dy: align.dy + sy * step }); }}
                  title={`Nudge ${dir} (arrow keys; Shift for bigger steps)`}
                  aria-label={`Nudge ${dir}`}
                  className="p-1.5 rounded-md bg-white/10 hover:bg-white/20 text-white"
                >
                  <Icon size={14} />
                </button>
              ))}
            </div>
            <label className="flex items-center gap-1.5">
              Size
              <button onClick={() => nudge({ scale: align.scale / 1.001 })} className="px-1.5 rounded bg-white/10 hover:bg-white/20 text-white" aria-label="Shrink right sheet">−</button>
              <input
                data-testid="compare-scale"
                type="number"
                step={0.1}
                min={50}
                max={200}
                value={(align.scale * 100).toFixed(1)}
                onChange={(e) => { const v = Number(e.target.value); if (v >= 50 && v <= 200) nudge({ scale: v / 100 }); }}
                className="w-16 px-1.5 py-0.5 rounded bg-slate-900 border border-white/15 text-white text-right tabular-nums"
              />%
              <button onClick={() => nudge({ scale: align.scale * 1.001 })} className="px-1.5 rounded bg-white/10 hover:bg-white/20 text-white" aria-label="Enlarge right sheet">+</button>
            </label>
            <button data-testid="compare-auto-align" onClick={() => runAutoAlign(align.scale)} disabled={aligning || !leftImg || !rightImg} className="px-2.5 py-1 rounded-md bg-accent-600 hover:bg-accent-700 text-white flex items-center gap-1.5 disabled:opacity-50">
              <Wand2 size={13} /> Auto-align
            </button>
            <button onClick={resetAlign} className="px-2.5 py-1 rounded-md bg-white/10 hover:bg-white/20 text-white flex items-center gap-1.5">
              <RotateCcw size={13} /> Reset
            </button>
            <span className="text-slate-400">Tip: use Overlay or Difference and zoom in on a corner of the title block while nudging.</span>
          </div>
        )}

        {/* Viewport */}
        <div ref={viewRef} className="flex-1 min-h-0 overflow-hidden bg-slate-950 relative">
          {mode === 'side' && (
            <div className="absolute inset-0 grid grid-cols-2 gap-3">
              {[{ p: left, img: leftImg, box: fullFrame, flag: flagged.left, tid: 'compare-pane-left' }, { p: right, img: rightImg, box: rightBox, flag: flagged.right, tid: 'compare-pane-right' }].map(({ p, img, box, flag, tid }) => (
                <div key={tid} data-testid={tid} className="relative overflow-hidden cursor-grab active:cursor-grabbing touch-none bg-slate-950" {...viewportHandlers}>
                  <div style={frameStyle(paneW, paneH)}>
                    {img && <CanvasHost canvas={img.canvas} style={box} />}
                    {showTakeoffs && <TakeoffLayer project={project} page={p} style={box} flagged={diff ? flag : undefined} />}
                  </div>
                  <div className="absolute top-2 left-2 px-2 py-1 rounded-md bg-black/70 text-[11px] text-white font-medium pointer-events-none">
                    {revName(p)} · {setLabel(project, p)}
                  </div>
                </div>
              ))}
            </div>
          )}

          {mode === 'overlay' && (
            <div data-testid="compare-pane-overlay" className="absolute inset-0 cursor-grab active:cursor-grabbing touch-none" {...viewportHandlers}>
              <div style={frameStyle(paneW, paneH)}>
                {leftImg && <CanvasHost canvas={leftImg.canvas} style={fullFrame} testId="compare-left-image" />}
                {showTakeoffs && <TakeoffLayer project={project} page={left} style={{ ...fullFrame, opacity: 1 - opacity / 100 }} />}
                {rightImg && <CanvasHost canvas={rightImg.canvas} style={{ ...rightBox, opacity: opacity / 100 }} testId="compare-right-image" />}
                {showTakeoffs && <TakeoffLayer project={project} page={right} style={{ ...rightBox, opacity: Math.max(0.15, opacity / 100) }} flagged={diff ? flagged.right : undefined} />}
              </div>
            </div>
          )}

          {mode === 'difference' && (
            <div data-testid="compare-pane-difference" className="absolute inset-0 cursor-grab active:cursor-grabbing touch-none" {...viewportHandlers}>
              <div style={frameStyle(paneW, paneH)}>
                {diff
                  ? <CanvasHost canvas={diff.canvas} style={fullFrame} testId="compare-diff-image" />
                  : <div className="absolute bg-white" style={fullFrame} />}
                {showTakeoffs && <TakeoffLayer project={project} page={right} style={rightBox} flagged={diff ? flagged.right : undefined} dimOthers testId="compare-diff-takeoffs" />}
              </div>
            </div>
          )}

          {/* Status chips */}
          <div className="absolute top-3 left-1/2 -translate-x-1/2 flex flex-col items-center gap-2 pointer-events-none">
            {loadingFull && (
              <div data-testid="compare-loading" className="px-3 py-1.5 rounded-full bg-black/75 text-xs text-white flex items-center gap-2">
                <Loader2 size={13} className="animate-spin" /> Loading full-size sheets…
              </div>
            )}
            {needDiff && diffBusy && !loadingFull && (
              <div className="px-3 py-1.5 rounded-full bg-black/75 text-xs text-white flex items-center gap-2">
                <Loader2 size={13} className="animate-spin" /> Finding changes…
              </div>
            )}
            {previewOnly.length > 0 && (
              <div data-testid="compare-preview-warning" className="px-3 py-1.5 rounded-full bg-amber-500/90 text-xs text-black font-medium flex items-center gap-2">
                <AlertTriangle size={13} /> {previewOnly.map(p => revName(p)).join(' and ')} only {previewOnly.length === 1 ? 'has' : 'have'} a small preview stored, so {previewOnly.length === 1 ? 'it' : 'they'} will look blurry.
              </div>
            )}
            {Object.keys(loadErrors).filter(id => id === leftId || id === rightId).map(id => (
              <div key={id} className="px-3 py-1.5 rounded-full bg-red-600/90 text-xs text-white font-medium flex items-center gap-2">
                <AlertTriangle size={13} /> {revName(revs.find(p => p.id === id))}: couldn't load the full-size sheet; showing the preview.
              </div>
            ))}
          </div>

          {/* Takeoffs on changes */}
          {showTakeoffs && (
            <div data-testid="compare-flagged" className="absolute right-3 bottom-3 w-72 max-h-[45%] overflow-y-auto rounded-xl bg-slate-900/95 border border-white/10 shadow-xl text-xs text-slate-200">
              <div className="px-3 py-2 border-b border-white/10 font-semibold text-white">
                {!diff || diff.key !== diffKey
                  ? 'Checking takeoffs against changes…'
                  : flaggedList.length
                    ? `${flaggedList.length} takeoff${flaggedList.length === 1 ? '' : 's'} on ${revName(right)} sit${flaggedList.length === 1 ? 's' : ''} on changed linework`
                    : `No takeoffs on ${revName(right)} sit on changed linework`}
              </div>
              {flaggedList.map(m => (
                <button
                  key={m.id}
                  data-testid="compare-flagged-item"
                  onClick={() => { if (mode === 'side') setMode('difference'); zoomToMeasurement(m); }}
                  className="w-full text-left px-3 py-1.5 hover:bg-white/10 flex items-center gap-2"
                >
                  <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: project.takeoffs.find(t => t.id === m.takeoffId)?.color || m.color }} />
                  <span className="truncate flex-1">{project.takeoffs.find(t => t.id === m.takeoffId)?.name || m.name || 'Measurement'}</span>
                  <span className="text-slate-500">{m.type}</span>
                </button>
              ))}
              {onOpenPage && flaggedList.length > 0 && (
                <button onClick={() => onOpenPage(right.id)} className="w-full text-left px-3 py-2 border-t border-white/10 text-accent-300 hover:bg-white/10">
                  Open {revName(right)} to fix them →
                </button>
              )}
            </div>
          )}
        </div>

        {/* Footer: slider / legend / hints */}
        <div className="px-6 py-2.5 border-t border-white/10 flex flex-wrap items-center gap-x-6 gap-y-2 shrink-0 bg-slate-900/80 text-xs text-slate-400">
          {mode === 'overlay' && (
            <div className="flex items-center gap-3 flex-1 min-w-[220px]">
              <span className="whitespace-nowrap">{revName(left)}</span>
              <input type="range" min={0} max={100} value={opacity} onChange={(e) => setOpacity(Number(e.target.value))} className="flex-1 accent-accent-500" aria-label="Fade between revisions" />
              <span className="whitespace-nowrap">{revName(right)}</span>
            </div>
          )}
          {mode === 'difference' && (
            <div data-testid="compare-legend" className="flex items-center gap-4 flex-1 flex-wrap">
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm" style={{ background: `rgb(${DIFF_COLORS.removed.join(',')})` }} /> Only on {revName(left)}{leftIsNewer ? '' : ' (removed)'}</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm" style={{ background: `rgb(${DIFF_COLORS.added.join(',')})` }} /> Only on {revName(right)}{leftIsNewer ? '' : ' (added)'}</span>
              <span className="flex items-center gap-1.5"><span className="w-3 h-3 rounded-sm bg-slate-300" /> Unchanged</span>
              {diff && diff.key === diffKey && diff.changes.removed + diff.changes.added === 0 && <span className="text-emerald-400">No changes found</span>}
            </div>
          )}
          <span data-testid="compare-align-status" data-dx={align.dx.toFixed(1)} data-dy={align.dy.toFixed(1)} data-state={aligning ? 'aligning' : alignStatus} className={alignStatus === 'nomatch' ? 'text-amber-300' : ''}>
            {alignMessage}
          </span>
          <span className="text-slate-500 ml-auto">Drag to pan, scroll to zoom{alignOpen ? ', arrow keys nudge' : ''}.</span>
        </div>
      </motion.div>
    </div>
  );
};
