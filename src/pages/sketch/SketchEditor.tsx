// src/pages/sketch/SketchEditor.tsx
// The sketch editor: draw measured shapes on a work plane (Ground, Front or
// Side), pull closed ones into solids, and save each change as a new version
// of the sketch file. One person edits at a time; anyone else who opens it
// (and every phone) gets a view they can orbit but not change.
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Link, useBlocker } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
import {
  ArrowLeft, ArrowUpFromLine, Box, Circle, Eye, EyeOff, LoaderCircle, Maximize, MousePointer2, PenLine,
  RectangleHorizontal, Redo2, Save, Spline, Trash2, Undo2,
} from 'lucide-react';
import { Button } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import { useCollaboration } from '../../context/CollaborationContext';
import { useCollabEditing } from '../../hooks/useCollabEditing';
import { fetchFileBlob, getFileMeta, getProjectSummary, saveFileVersion, type ProjectFile } from '../../utils/store';
import {
  PLANE_LABELS, SKETCH_MIME, canPull, formatLength, parseLength, parseSketch, pulledShapeIds, serializeSketch,
  shapeSnapPoints, toWorld, type PlaneId, type SketchDoc, type SketchShape, type SketchUnits, type Vec2,
} from './sketchModel';
import { angleDeg, gridStep, parseAngle, snapPoint } from './sketchSnap';
import {
  circleClick, circleTyped, draftLastPoint, draftPreview, lineBack, lineClick, lineFinish, lineTyped, rectClick, rectTyped,
  type Draft, type Step, type ToolId,
} from './sketchTools';
import { SketchScene, VIEW_FOR_PLANE, type ViewName } from './sketchScene';
import { buildSolids } from './geometryClient';
import type { SolidMesh } from './geometryTypes';
import { sketchTitle } from './sketchNames';

// The mobile top bar sits above every page on phones (AppShell); the editor
// fills whatever is left — the same rule as the document editor.
const FULL_HEIGHT = 'h-[calc(100dvh-3.5rem-env(safe-area-inset-top))] md:h-dvh';
const CLICK_SLOP_PX = 6;

const isDrawTool = (t: ToolId) => t === 'line' || t === 'rect' || t === 'circle';

const TOOL_HINTS: Record<ToolId, string> = {
  select: 'Click a shape or solid to select it. Delete removes it.',
  line: 'Click to start. After the first point, type a length (and angle). Click the start again to close the shape; Enter leaves it open. A switches to arcs.',
  rect: 'Click two corners, or click one and type the width and height.',
  circle: 'Click the centre, then a point on the edge, or type the radius.',
  pull: 'Click a closed shape (or a solid to change it), move to pull it out, then click or type the distance.',
};

const useIsPhone = () => {
  const [phone, setPhone] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const on = (e: MediaQueryListEvent) => setPhone(e.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return phone;
};

const useDark = () => {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'));
  useEffect(() => {
    const obs = new MutationObserver(() => setDark(document.documentElement.classList.contains('dark')));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return dark;
};

type Selection = { shapeId: string } | { featureId: string } | null;

export const SketchEditor: React.FC<{ fileId: string }> = ({ fileId }) => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const isPhone = useIsPhone();
  const dark = useDark();

  // ── File ──────────────────────────────────────────────────────────────────
  const [meta, setMeta] = useState<ProjectFile | null>(null);
  const [projectName, setProjectName] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [doc, setDocState] = useState<SketchDoc | null>(null);
  const [savedJson, setSavedJson] = useState('');
  const [saving, setSaving] = useState(false);
  const past = useRef<SketchDoc[]>([]);
  const future = useRef<SketchDoc[]>([]);
  const [, bumpHistory] = useReducer((n: number) => n + 1, 0);
  const dirty = !!doc && serializeSketch(doc) !== savedJson;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const load = useCallback(async () => {
    try {
      const m = await getFileMeta(fileId);
      if (!m) { setLoadError('This sketch no longer exists.'); return; }
      const d = parseSketch(await (await fetchFileBlob(fileId)).text());
      setMeta(m);
      setDocState(d);
      setSavedJson(serializeSketch(d));
      past.current = [];
      future.current = [];
      bumpHistory();
      if (m.projectId) getProjectSummary(m.projectId).then(p => setProjectName(p?.name ?? null)).catch(() => {});
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : 'Could not open this sketch.');
    }
  }, [fileId]);
  useEffect(() => { void load(); }, [load]);

  const commitDoc = useCallback((next: SketchDoc) => {
    setDocState(prev => {
      if (prev) past.current.push(prev);
      if (past.current.length > 200) past.current.shift();
      future.current = [];
      return next;
    });
    bumpHistory();
  }, []);

  // ── Who edits ─────────────────────────────────────────────────────────────
  // Decided once the file is loaded: if someone else is already editing it
  // this opens as a view, and offers to edit once they have left.
  let collab: ReturnType<typeof useCollaboration> | null;
  try { collab = useCollaboration(); } catch { collab = null; }
  const sessions = collab?.sessions ?? [];
  const mySessionId = collab?.mySessionId ?? null;
  const othersNow = sessions.filter(s => s.sessionId !== mySessionId && s.editing?.type === 'file' && s.editing.id === fileId);
  const [lockedBy, setLockedBy] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    if (!doc || lockedBy !== undefined) return;
    setLockedBy(othersNow.length ? othersNow.map(s => s.name).join(', ') : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc]);
  const historical = !!meta?.parentFileId;
  const editable = !!doc && lockedBy === null && !isPhone && !historical;
  useCollabEditing({ type: 'file', id: fileId, isDirty: () => dirtyRef.current, onFresh: () => void load(), enabled: editable });
  // A view follows the editor's saves.
  useEffect(() => {
    const socket = collab?.socket;
    if (!socket || editable) return;
    const on = (ev: { type: string; id: string }) => { if (ev.type === 'file' && ev.id === fileId) void load(); };
    socket.on('entity-changed', on);
    return () => { socket.off('entity-changed', on); };
  }, [collab?.socket, editable, fileId, load]);

  // ── Tools ─────────────────────────────────────────────────────────────────
  const [tool, setToolState] = useState<ToolId>('select');
  const [plane, setPlaneState] = useState<PlaneId>('front');
  const [arcMode, setArcMode] = useState(false);
  const [showDims, setShowDims] = useState(true);
  const [view, setViewState] = useState<ViewName>('iso');
  const [draft, setDraftState] = useState<Draft | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const setDraft = (d: Draft | null) => { draftRef.current = d; setDraftState(d); };
  const [selection, setSelection] = useState<Selection>(null);
  const [typed, setTyped] = useState<[string, string]>(['', '']);
  const typedRef = useRef<HTMLInputElement>(null);

  // ── Solids ────────────────────────────────────────────────────────────────
  const [solids, setSolids] = useState<SolidMesh[]>([]);
  const [engine, setEngine] = useState<'idle' | 'loading' | 'ready' | 'failed'>('idle');
  const [buildErrors, setBuildErrors] = useState<string[]>([]);
  const buildSeq = useRef(0);
  useEffect(() => {
    if (!doc) return;
    if (doc.features.length === 0) { setSolids([]); setBuildErrors([]); return; }
    const seq = ++buildSeq.current;
    setEngine(e => (e === 'ready' ? e : 'loading'));
    buildSolids(doc).then(r => {
      if (seq !== buildSeq.current) return;
      if (r.fatal) { setEngine('failed'); setBuildErrors([r.fatal]); return; }
      setEngine('ready');
      setSolids(r.solids);
      setBuildErrors(r.errors.map(e => e.message));
    });
  }, [doc]);

  // ── Scene ─────────────────────────────────────────────────────────────────
  const containerRef = useRef<HTMLDivElement>(null);
  const sceneRef = useRef<SketchScene | null>(null);
  const fitted = useRef(false);
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const scene = new SketchScene(el, { dark });
    sceneRef.current = scene;
    return () => { scene.dispose(); sceneRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => { sceneRef.current?.setDark(dark); }, [dark]);
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene || !doc) return;
    scene.setUnits(doc.units);
    scene.setContent({
      doc, solids, showDims,
      selectedShapeId: selection && 'shapeId' in selection ? selection.shapeId : null,
      selectedFeatureId: selection && 'featureId' in selection ? selection.featureId : null,
    });
    // Frame the sketch once, when it (and its solids) first arrive.
    if (!fitted.current && (doc.features.length === 0 || solids.length > 0)) {
      fitted.current = true;
      scene.fit(doc, solids);
    }
  }, [doc, solids, selection, showDims]);
  useEffect(() => { sceneRef.current?.setWorkPlane(plane); }, [plane]);
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const drawing = editable && (isDrawTool(tool) || (tool === 'pull' && draft?.tool === 'pull'));
    scene.setNavigation(drawing ? 'draw' : 'navigate');
  }, [tool, draft, view, editable]);

  const setView = (v: ViewName) => {
    setViewState(v);
    sceneRef.current?.setView(v);
  };

  const setTool = (t: ToolId) => {
    setDraft(null);
    setTyped(['', '']);
    setToolState(t);
    if (isDrawTool(t)) setView(VIEW_FOR_PLANE[plane]);
    if (t !== 'select') setSelection(null);
  };

  const setPlane = (p: PlaneId) => {
    setDraft(null);
    setPlaneState(p);
    if (isDrawTool(tool)) setView(VIEW_FOR_PLANE[p]);
  };

  // ── Pointer → snapped plane point → preview ─────────────────────────────────
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const hover = useRef<Vec2 | null>(null);
  const hoverAngle = useRef<number | null>(null);
  const pullDistance = useRef(0);

  const snapTargets = useMemo(() => {
    const pts: Vec2[] = [{ x: 0, y: 0 }];
    for (const s of doc?.shapes ?? []) if (s.plane === plane) pts.push(...shapeSnapPoints(s));
    if (draft?.tool === 'line') {
      pts.push(draft.start);
      for (const seg of draft.segments) pts.push(seg.to);
    }
    return pts;
  }, [doc, draft, plane]);

  const snappedAt = (clientX: number, clientY: number, free: boolean) => {
    const scene = sceneRef.current;
    if (!scene || !doc) return null;
    const raw = scene.planePoint(clientX, clientY, plane);
    if (!raw) return null;
    const pxPerMm = scene.pxPerMm();
    const from = draft?.tool === 'line' ? draftLastPoint(draft) : draft?.tool === 'rect' ? draft.a : draft?.tool === 'circle' ? draft.center : undefined;
    return snapPoint({ raw, pxPerMm, step: gridStep(doc.units, pxPerMm), targets: snapTargets, from, free });
  };

  const pullShape = (d: Draft | null): SketchShape | undefined =>
    d?.tool === 'pull' ? doc?.shapes.find(s => s.id === d.shapeId) : undefined;

  const refreshPreview = (free = false) => {
    const scene = sceneRef.current;
    if (!scene || !doc) return;
    const ptr = pointer.current;
    const units = doc.units;
    if (!editable) return;
    if (tool === 'pull') {
      const shape = pullShape(draft);
      if (draft?.tool === 'pull' && shape) {
        if (ptr) {
          const d = scene.pullDistanceAt(ptr.x, ptr.y, shape);
          if (d !== null) {
            const step = gridStep(units, scene.pxPerMm());
            pullDistance.current = free ? d : Math.round(d / step) * step;
          }
        }
        const anchor = toWorld(shape.plane, shape.type === 'circle' ? shape.center : shape.start);
        scene.setPreview({
          shape: null, snap: null,
          readout: { at: anchor, text: formatLength(pullDistance.current, units) },
          pull: { shape, distance: pullDistance.current, replacesFeatureId: draft.featureId },
        });
      } else {
        scene.setPreview({ shape: null, snap: null, readout: null, pull: null });
      }
      return;
    }
    if (!isDrawTool(tool) || !ptr) {
      scene.setPreview({ shape: null, snap: null, readout: null, pull: null });
      return;
    }
    const snapped = snappedAt(ptr.x, ptr.y, free);
    if (!snapped) return;
    hover.current = snapped.p;
    const shape = draftPreview(draft, snapped.p);
    let readout: { at: [number, number, number]; text: string } | null = null;
    if (draft?.tool === 'line' && !draft.arcThrough) {
      const last = draftLastPoint(draft);
      const len = Math.hypot(snapped.p.x - last.x, snapped.p.y - last.y);
      hoverAngle.current = len > 0 ? angleDeg(last, snapped.p) : null;
      if (len > 0) readout = { at: toWorld(plane, snapped.p), text: `${formatLength(len, units)}  ${Math.round(hoverAngle.current ?? 0)}°` };
    } else if (draft?.tool === 'rect') {
      readout = { at: toWorld(plane, snapped.p), text: `${formatLength(Math.abs(snapped.p.x - draft.a.x), units)} × ${formatLength(Math.abs(snapped.p.y - draft.a.y), units)}` };
    } else if (draft?.tool === 'circle') {
      readout = { at: toWorld(plane, snapped.p), text: `R ${formatLength(Math.hypot(snapped.p.x - draft.center.x, snapped.p.y - draft.center.y), units)}` };
    }
    scene.setPreview({ shape, snap: { p: snapped.p, plane, kind: snapped.kind }, readout, pull: null });
  };
  // Keep the preview in step with the draft, tool, plane and zoom.
  useEffect(() => {
    refreshPreview();
    const scene = sceneRef.current;
    if (scene) scene.onCameraChange = () => refreshPreview();
  });

  const applyStep = (step: Step) => {
    setDraft(step.draft);
    setTyped(['', '']);
    if (step.commit && doc) commitDoc({ ...doc, shapes: [...doc.shapes, step.commit] });
  };

  const commitPull = (distance: number) => {
    const d = draftRef.current;
    if (!doc || d?.tool !== 'pull') return;
    if (Math.abs(distance) < 1e-3) { toast('Pull it out some distance first.', { type: 'warning' }); return; }
    const features = d.featureId
      ? doc.features.map(f => (f.id === d.featureId ? { ...f, distance } : f))
      : [...doc.features, { id: uuidv4(), type: 'pull' as const, shapeId: d.shapeId, distance }];
    commitDoc({ ...doc, features });
    setDraft(null);
    setTyped(['', '']);
    pullDistance.current = 0;
  };

  const startPull = (picked: Selection) => {
    if (!doc || !picked) return;
    const pulled = pulledShapeIds(doc);
    if ('featureId' in picked) {
      const f = doc.features.find(ff => ff.id === picked.featureId);
      if (!f) return;
      pullDistance.current = f.distance;
      setDraft({ tool: 'pull', shapeId: f.shapeId, featureId: f.id, distance: f.distance });
      return;
    }
    const shape = doc.shapes.find(s => s.id === picked.shapeId);
    if (!shape || pulled.has(shape.id)) return;
    if (!canPull(shape)) { toast('Only a closed shape can be pulled. Close it by ending on its first point.', { type: 'warning' }); return; }
    pullDistance.current = 0;
    setDraft({ tool: 'pull', shapeId: shape.id, distance: 0 });
    // Looking straight at its plane there is nothing to pull along: turn to the 3D view.
    if (view === VIEW_FOR_PLANE[shape.plane]) setView('iso');
  };

  const handleClick = (clientX: number, clientY: number, free: boolean) => {
    const scene = sceneRef.current;
    if (!scene || !doc) return;
    if (!editable || tool === 'select') {
      setSelection(scene.pick(clientX, clientY));
      return;
    }
    if (tool === 'pull') {
      if (draft?.tool === 'pull') commitPull(pullDistance.current);
      else startPull(scene.pick(clientX, clientY));
      return;
    }
    const snapped = snappedAt(clientX, clientY, free);
    if (!snapped) return;
    const id = () => uuidv4();
    if (tool === 'line') applyStep(lineClick(draft, snapped.p, plane, arcMode, id));
    else if (tool === 'rect') applyStep(rectClick(draft, snapped.p, plane, id));
    else if (tool === 'circle') applyStep(circleClick(draft, snapped.p, plane, id));
  };

  const applyTyped = () => {
    if (!doc) return;
    const units: SketchUnits = doc.units;
    const [a, b] = typed;
    const d = draftRef.current;
    const id = () => uuidv4();
    const bad = (what: string) => toast(`Type a ${what}, e.g. ${units === 'metric' ? '250' : `1' 4 1/2"`}.`, { type: 'warning' });
    if (d?.tool === 'line') {
      const len = parseLength(a, units);
      if (len === null || len <= 0) return bad('length');
      const ang = b.trim() ? parseAngle(b) : hoverAngle.current ?? 0;
      if (ang === null) return toast('Type the angle in degrees, e.g. 45.', { type: 'warning' });
      applyStep(lineTyped(d, len, ang, id));
    } else if (d?.tool === 'rect') {
      const w = parseLength(a, units), h = parseLength(b, units);
      if (!w || !h) return bad('width and height');
      applyStep(rectTyped(d, w, h, hover.current, id));
    } else if (d?.tool === 'circle') {
      const r = parseLength(a, units);
      if (!r || r <= 0) return bad('radius');
      applyStep(circleTyped(d, r, id));
    } else if (d?.tool === 'pull') {
      const dist = parseLength(a, units);
      if (dist === null || dist === 0) return bad('distance');
      // A plain number pulls the way the pointer is pulling; a minus sign flips it.
      const sign = /^\s*[-−]/.test(a) ? 1 : Math.sign(pullDistance.current) || 1;
      commitPull(sign * dist);
    }
  };

  const deleteSelection = () => {
    if (!doc || !selection) return;
    const shapeId = 'shapeId' in selection ? selection.shapeId : doc.features.find(f => f.id === selection.featureId)?.shapeId;
    if (!shapeId) return;
    commitDoc({ ...doc, shapes: doc.shapes.filter(s => s.id !== shapeId), features: doc.features.filter(f => f.shapeId !== shapeId) });
    setSelection(null);
  };

  const undo = () => {
    const prev = past.current.pop();
    if (!prev || !doc) return;
    future.current.push(doc);
    setDraft(null);
    setSelection(null);
    setDocState(prev);
    bumpHistory();
  };
  const redo = () => {
    const next = future.current.pop();
    if (!next || !doc) return;
    past.current.push(doc);
    setDraft(null);
    setDocState(next);
    bumpHistory();
  };

  const save = async () => {
    if (!doc || !editable || saving || !dirty) return;
    setSaving(true);
    try {
      const json = serializeSketch(doc);
      const res = await saveFileVersion(fileId, new Blob([json], { type: SKETCH_MIME }));
      setSavedJson(json);
      toast(`Saved as version ${res.versionNumber}`, { type: 'success' });
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save the sketch', { type: 'error' });
    } finally {
      setSaving(false);
    }
  };

  // ── Keyboard ──────────────────────────────────────────────────────────────
  const keyRef = useRef<(e: KeyboardEvent) => void>(() => {});
  keyRef.current = (e: KeyboardEvent) => {
    if (!editable) return;
    const inInput = e.target instanceof HTMLElement && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA');
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); void save(); return; }
    if (inInput) return;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); return; }
    if (mod) return;
    // Typing a number while drawing goes straight into the measurement box.
    if (draft && /^[0-9.'"\-−]$/.test(e.key)) {
      e.preventDefault();
      setTyped([e.key, typed[1]]);
      requestAnimationFrame(() => typedRef.current?.focus());
      return;
    }
    switch (e.key) {
      case 'Escape':
        if (draft) setDraft(null);
        else if (selection) setSelection(null);
        else if (tool !== 'select') setTool('select');
        break;
      case 'Enter':
        if (draft?.tool === 'line') applyStep(lineFinish(draft, () => uuidv4()));
        break;
      case 'Backspace':
      case 'Delete':
        if (draft?.tool === 'line') setDraft(lineBack(draft));
        else if (selection) deleteSelection();
        break;
      case 'a': case 'A': if (tool === 'line') setArcMode(m => !m); break;
      case 'v': case 'V': setTool('select'); break;
      case 'l': case 'L': setTool('line'); break;
      case 'r': case 'R': setTool('rect'); break;
      case 'c': case 'C': setTool('circle'); break;
      case 'p': case 'P': setTool('pull'); break;
      default: return;
    }
    e.preventDefault();
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  // ── Leaving with unsaved changes ──────────────────────────────────────────
  const blocker = useBlocker(({ currentLocation, nextLocation }) =>
    dirty && editable && currentLocation.pathname + currentLocation.search !== nextLocation.pathname + nextLocation.search);
  useEffect(() => {
    if (blocker.state !== 'blocked') return;
    void confirm({
      title: 'Leave without saving?',
      message: 'Your changes to this sketch are not saved.',
      confirmLabel: 'Leave',
      tone: 'danger',
    }).then(ok => (ok ? blocker.proceed() : blocker.reset()));
  }, [blocker, confirm]);
  useEffect(() => {
    if (!dirty || !editable) return;
    const on = (e: BeforeUnloadEvent) => { e.preventDefault(); };
    window.addEventListener('beforeunload', on);
    return () => window.removeEventListener('beforeunload', on);
  }, [dirty, editable]);

  // ── Pointer events on the view ────────────────────────────────────────────
  const down = useRef<{ id: number; x: number; y: number } | null>(null);
  const activePointers = useRef(new Set<number>());
  const onPointerDown = (e: React.PointerEvent) => {
    activePointers.current.add(e.pointerId);
    pointer.current = { x: e.clientX, y: e.clientY };
    if (e.pointerType === 'mouse' && e.button !== 0) { down.current = null; return; }
    down.current = activePointers.current.size === 1 ? { id: e.pointerId, x: e.clientX, y: e.clientY } : null;
    refreshPreview(e.altKey);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    pointer.current = { x: e.clientX, y: e.clientY };
    refreshPreview(e.altKey);
  };
  const onPointerUp = (e: React.PointerEvent) => {
    activePointers.current.delete(e.pointerId);
    const d = down.current;
    down.current = null;
    if (!d || d.id !== e.pointerId) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP_PX) return;
    handleClick(e.clientX, e.clientY, e.altKey);
  };
  const onPointerLeave = () => {
    pointer.current = null;
    if (editable && isDrawTool(tool)) sceneRef.current?.setPreview({ shape: null, snap: null, readout: null, pull: null });
  };
  const onDoubleClick = () => {
    if (editable && draft?.tool === 'line') applyStep(lineFinish(draft, () => uuidv4()));
  };

  // ── Render ────────────────────────────────────────────────────────────────
  if (loadError) {
    return (
      <div className="p-8">
        <p className="text-sm text-red-600 dark:text-red-400" data-testid="sketch-error">{loadError}</p>
        <Link to="/tools/sketch" className="mt-3 inline-block text-sm text-accent-600 hover:underline">Back to sketches</Link>
      </div>
    );
  }

  const units = doc?.units ?? 'imperial';
  const typedFields: { label: string; placeholder: string }[] =
    draft?.tool === 'line' && !draft.arcThrough ? [{ label: 'Length', placeholder: units === 'metric' ? '250' : `1' 4 1/2"` }, { label: 'Angle °', placeholder: 'as drawn' }]
    : draft?.tool === 'rect' ? [{ label: 'Width', placeholder: units === 'metric' ? '600' : `2'` }, { label: 'Height', placeholder: units === 'metric' ? '90' : '3 1/2' }]
    : draft?.tool === 'circle' ? [{ label: 'Radius', placeholder: units === 'metric' ? '50' : '2' }]
    : draft?.tool === 'pull' ? [{ label: 'Distance', placeholder: units === 'metric' ? '300' : `1'` }]
    : [];

  const toolButton = (t: ToolId, label: string, icon: React.ReactNode, key: string) => (
    <button
      type="button"
      data-testid={`sketch-tool-${t}`}
      onClick={() => setTool(t)}
      title={`${label} (${key})`}
      aria-label={label}
      aria-pressed={tool === t}
      className={`flex size-10 items-center justify-center rounded-lg transition-colors ${tool === t ? 'bg-accent-600 text-white' : 'text-ink-soft hover:bg-hover hover:text-ink'}`}
    >
      {icon}
    </button>
  );

  return (
    <div className={`flex flex-col ${FULL_HEIGHT}`} data-testid="sketch-editor">
      <header className="flex items-center gap-2 border-b border-edge bg-raised px-3 py-2">
        <Link to="/tools/sketch" className="flex items-center gap-1 rounded-md px-2 py-1 text-sm text-ink-soft hover:bg-hover hover:text-ink">
          <ArrowLeft size={16} /><span className="hidden sm:inline">Sketches</span>
        </Link>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-sm font-semibold text-ink" data-testid="sketch-title">{doc ? sketchTitle(meta?.name) : 'Opening…'}</h1>
          <p className="truncate text-xs text-ink-faint">
            {projectName ?? 'No project'}
            {editable && (dirty ? ' · Unsaved changes' : ' · Saved')}
          </p>
        </div>
        {editable && doc && (
          <select
            aria-label="Units"
            value={doc.units}
            onChange={e => commitDoc({ ...doc, units: e.target.value as SketchUnits })}
            className="hidden rounded-lg border border-edge bg-raised px-2 py-1.5 text-sm text-ink sm:block"
          >
            <option value="imperial">Feet &amp; inches</option>
            <option value="metric">Millimetres</option>
          </select>
        )}
        {editable && (
          <Button onClick={() => void save()} disabled={!dirty || saving} data-testid="sketch-save" size="sm">
            <Save size={15} />{saving ? 'Saving…' : 'Save'}
          </Button>
        )}
      </header>

      {doc && !editable && (
        <div className="flex flex-wrap items-center gap-3 border-b border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800 dark:border-amber-700/40 dark:bg-amber-900/20 dark:text-amber-300" data-testid="sketch-view-only">
          <Eye size={15} className="shrink-0" />
          <span className="min-w-0 flex-1">
            {isPhone ? 'Phones open sketches to look at. Edit on a tablet or computer.'
              : historical ? 'This is an older version. Open the current one from Documents to edit.'
              : `${lockedBy} is editing this sketch. You can look around; it updates when they save.`}
          </span>
          {!isPhone && !historical && lockedBy && othersNow.length === 0 && (
            <Button size="sm" variant="secondary" onClick={() => { void load().then(() => setLockedBy(null)); }}>Start editing</Button>
          )}
        </div>
      )}

      <div className="relative flex min-h-0 flex-1">
        {editable && (
          <aside className="flex w-12 shrink-0 flex-col items-center gap-1 overflow-y-auto border-r border-edge bg-raised py-2" aria-label="Sketch tools">
            {toolButton('select', 'Select', <MousePointer2 size={18} />, 'V')}
            {toolButton('line', 'Line', <PenLine size={18} />, 'L')}
            <button
              type="button"
              data-testid="sketch-arc"
              onClick={() => { if (tool !== 'line') setTool('line'); setArcMode(m => !m); }}
              title="Arcs: the next click sets the curve, the one after its end (A)"
              aria-label="Arc"
              aria-pressed={arcMode && tool === 'line'}
              className={`flex size-10 items-center justify-center rounded-lg transition-colors ${arcMode && tool === 'line' ? 'bg-fuchsia-600 text-white' : 'text-ink-soft hover:bg-hover hover:text-ink'}`}
            >
              <Spline size={18} />
            </button>
            {toolButton('rect', 'Rectangle', <RectangleHorizontal size={18} />, 'R')}
            {toolButton('circle', 'Circle', <Circle size={18} />, 'C')}
            {toolButton('pull', 'Pull into 3D', <ArrowUpFromLine size={18} />, 'P')}
            <div className="my-1 h-px w-8 bg-edge" />
            <button type="button" onClick={undo} disabled={past.current.length === 0} title="Undo (Ctrl+Z)" aria-label="Undo"
              className="flex size-10 items-center justify-center rounded-lg text-ink-soft hover:bg-hover disabled:opacity-40"><Undo2 size={18} /></button>
            <button type="button" onClick={redo} disabled={future.current.length === 0} title="Redo (Ctrl+Shift+Z)" aria-label="Redo"
              className="flex size-10 items-center justify-center rounded-lg text-ink-soft hover:bg-hover disabled:opacity-40"><Redo2 size={18} /></button>
            <button type="button" onClick={deleteSelection} disabled={!selection} title="Delete (Del)" aria-label="Delete"
              data-testid="sketch-delete"
              className="flex size-10 items-center justify-center rounded-lg text-ink-soft hover:bg-hover hover:text-red-600 disabled:opacity-40"><Trash2 size={18} /></button>
          </aside>
        )}

        <div className="relative min-w-0 flex-1 overflow-hidden">
          <div
            ref={containerRef}
            data-testid="sketch-view"
            className={`absolute inset-0 ${editable && (isDrawTool(tool) || draft) ? 'cursor-crosshair' : 'cursor-default'}`}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={e => { activePointers.current.delete(e.pointerId); down.current = null; }}
            onPointerLeave={onPointerLeave}
            onDoubleClick={onDoubleClick}
            onContextMenu={e => e.preventDefault()}
          />

          {editable && (
            <div className="pointer-events-auto absolute left-3 top-3 flex items-center gap-1 rounded-lg border border-edge bg-raised/95 p-1 text-xs shadow-sm">
              <span className="px-1.5 text-ink-faint">Draw on</span>
              {(['front', 'side', 'ground'] as PlaneId[]).map(p => (
                <button key={p} type="button" data-testid={`sketch-plane-${p}`} onClick={() => setPlane(p)} aria-pressed={plane === p}
                  className={`rounded-md px-2 py-1 font-medium ${plane === p ? 'bg-accent-600 text-white' : 'text-ink-soft hover:bg-hover'}`}>
                  {PLANE_LABELS[p]}
                </button>
              ))}
            </div>
          )}

          <div className="pointer-events-auto absolute right-3 top-3 flex items-center gap-1 rounded-lg border border-edge bg-raised/95 p-1 text-xs shadow-sm">
            {(['top', 'front', 'side'] as ViewName[]).map(v => (
              <button key={v} type="button" onClick={() => setView(v)} aria-pressed={view === v} data-testid={`sketch-view-${v}`}
                className={`rounded-md px-2 py-1 font-medium capitalize ${view === v ? 'bg-sunken text-ink' : 'text-ink-soft hover:bg-hover'}`}>{v}</button>
            ))}
            <button type="button" onClick={() => setView('iso')} aria-pressed={view === 'iso'} title="3D view" data-testid="sketch-view-iso"
              className={`flex items-center gap-1 rounded-md px-2 py-1 font-medium ${view === 'iso' ? 'bg-sunken text-ink' : 'text-ink-soft hover:bg-hover'}`}><Box size={13} />3D</button>
            <div className="mx-0.5 h-4 w-px bg-edge" />
            <button type="button" onClick={() => doc && sceneRef.current?.fit(doc, solids)} title="Fit everything in view" aria-label="Fit"
              className="rounded-md p-1 text-ink-soft hover:bg-hover"><Maximize size={14} /></button>
            <button type="button" onClick={() => setShowDims(s => !s)} title={showDims ? 'Hide dimensions' : 'Show dimensions'} aria-label="Dimensions"
              aria-pressed={showDims} className="rounded-md p-1 text-ink-soft hover:bg-hover">{showDims ? <Eye size={14} /> : <EyeOff size={14} />}</button>
          </div>

          {(engine === 'loading' || !doc) && (
            <div className="pointer-events-none absolute left-1/2 top-16 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-edge bg-raised px-3 py-2 text-sm text-ink-soft shadow-sm">
              <LoaderCircle size={15} className="animate-spin" />{doc ? 'Loading the 3D engine…' : 'Opening the sketch…'}
            </div>
          )}
          {buildErrors.length > 0 && (
            <div className="absolute left-1/2 top-16 max-w-md -translate-x-1/2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700 dark:border-red-700/40 dark:bg-red-900/20 dark:text-red-300">
              {engine === 'failed' ? 'The 3D engine could not start: ' : 'A shape could not be pulled: '}{buildErrors[0]}
            </div>
          )}

          {editable && (
            <div className="absolute inset-x-3 bottom-3 flex justify-center">
              <div className="pointer-events-auto flex max-w-full flex-wrap items-center gap-2 rounded-xl border border-edge bg-raised/95 px-3 py-2 text-sm shadow-lg" data-testid="sketch-vcb">
                {typedFields.length > 0 ? (
                  <form className="flex flex-wrap items-center gap-2" onSubmit={e => { e.preventDefault(); applyTyped(); }}>
                    {typedFields.map((f, i) => (
                      <label key={f.label} className="flex items-center gap-1.5 text-xs text-ink-soft">
                        {f.label}
                        <input
                          ref={i === 0 ? typedRef : undefined}
                          data-testid={`sketch-typed-${i}`}
                          value={typed[i]}
                          onChange={e => setTyped(i === 0 ? [e.target.value, typed[1]] : [typed[0], e.target.value])}
                          onKeyDown={e => { if (e.key === 'Escape') { setTyped(['', '']); (e.target as HTMLInputElement).blur(); } }}
                          placeholder={f.placeholder}
                          inputMode="text"
                          className="w-24 rounded-md border border-edge bg-raised px-2 py-1 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-accent-500"
                        />
                      </label>
                    ))}
                    <Button type="submit" size="sm">Enter</Button>
                  </form>
                ) : (
                  <span className="text-xs text-ink-soft">{TOOL_HINTS[tool]}</span>
                )}
                {draft?.tool === 'line' && (
                  <span className="text-xs text-ink-faint">{draft.arcThrough ? 'Click where the arc ends.' : arcMode ? 'Arc: click a point on the curve.' : ''}</span>
                )}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
