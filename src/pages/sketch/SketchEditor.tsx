// src/pages/sketch/SketchEditor.tsx
// The sketch editor: draw measured shapes on a work plane (Ground, Front,
// Side, or a flat face of a solid), pull closed ones into solids (a shape on a
// face joins its solid when pulled out and cuts it when pulled in), and save
// each change as a new version of the sketch file. One person edits at a
// time; anyone else who opens it (and every phone) gets a view they can orbit
// but not change.
import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import { Link, useBlocker } from 'react-router-dom';
import { v4 as uuidv4 } from 'uuid';
import {
  ArrowLeft, ArrowUpFromLine, Box, Circle, Combine, Eye, EyeOff, FileDown, FlipHorizontal2, ListOrdered, LoaderCircle, Magnet, Maximize,
  ImagePlus, MousePointer2, Move, PenLine, RectangleHorizontal, Redo2, Rotate3d, RotateCw, Route, Save, Spline, Trash2, TriangleRight, Undo2,
} from 'lucide-react';
import { Button } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import { useCollaboration } from '../../context/CollaborationContext';
import { useCollabEditing } from '../../hooks/useCollabEditing';
import { fetchFileBlob, getFileMeta, getProjectSummary, getSettings, saveBinaryFile, saveFileVersion, type ProjectFile } from '../../utils/store';
import { downloadBlob } from '../../utils/download';
import {
  PLANE_LABELS, SKETCH_MIME, axisClearOfShape, canPull, faceFrame, formatLength, frameOf, isShapeFeature, parseLength,
  parseSketch, planSolids, pullAtPoint, removeFeature, removeShape, samePlane, samePlaneSurface, serializeSketch,
  scaleReference, setPullDistance, shapeOutline, shapeSnapPoints, stepOfSolid, toPlane, toWorld, transformMatrix, usedShapeIds,
  type PlaneId, type SketchDoc, type SketchPlane, type SketchShape, type SketchUnits, type SolidPlan, type Transform,
  type Vec2, type Vec3,
} from './sketchModel';
import {
  angleDeg, angleFromLevel, gridStep, levelAngleToward, parseAngle, pointAt, snapPoint, type SnapTargets,
} from './sketchSnap';
import {
  circleClick, circleTyped, draftLastPoint, draftPreview, lineBack, lineClick, lineFinish, lineTyped, rectClick, rectTyped,
  type Draft, type Step, type ToolId,
} from './sketchTools';
import { SketchScene, viewForPlane, type Pick, type ViewName } from './sketchScene';
import { buildSolids, projectViews } from './geometryClient';
import type { ViewSpec } from './geometryTypes';
import { SketchExportModal, type PdfOptions } from './SketchExportModal';
import { buildSketchPdf } from './sketchPdf';
import { SHEET_VIEWS, looseShapeLines, scalesFor, viewLabels, viewSpec, type SheetView } from './sketchViews';
import type { SolidMesh } from './geometryTypes';
import { sketchTitle } from './sketchNames';
import { SketchSteps } from './SketchSteps';
import { SketchRefs } from './SketchRefs';
import { loadReferenceImage, type ReferenceImage } from './referenceImage';
import { FilePickerModal } from '../../components/FilePickerModal';

// The mobile top bar sits above every page on phones (AppShell); the editor
// fills whatever is left — the same rule as the document editor.
const FULL_HEIGHT = 'h-[calc(100dvh-3.5rem-env(safe-area-inset-top))] md:h-dvh';
const CLICK_SLOP_PX = 6;

const isDrawTool = (t: ToolId) => t === 'line' || t === 'rect' || t === 'circle';

const TOOL_HINTS: Record<ToolId, string> = {
  select: 'Click a shape or solid to select it. Delete removes it.',
  line: 'Click to start, then click each corner or type a length and angle (from level, toward the pointer). Click the start to close; Enter leaves it open; Backspace steps back; A for arcs. Hold Shift to line up with what is drawn, Ctrl for 15° angles.',
  rect: 'Click two corners, or click one and type the width and height. Hold Shift to line up with what is drawn.',
  circle: 'Click the centre, then a point on the edge, or type the radius. Hold Shift to line up with what is drawn.',
  pull: 'Click a closed shape (or a solid to change it), move to pull it out, then click or type the distance. A shape drawn on a face joins the solid when pulled out and cuts it when pulled in.',
  spin: 'Click a closed shape to spin, then two points on the line to spin it round (in its plane, to one side of it). Type an angle for less than a full turn.',
  run: 'Click the profile (a closed shape), then the path to run it along. Draw the profile across the path, where the path starts; corners are mitred.',
  combine: 'Click a solid, then a second one to join to it (or, set to Cut, to cut away from it).',
  move: 'Click a solid, then the point to move it from and the point to move it to (or type how far). Copies leaves it where it is and makes that many.',
  rotate: 'Click a solid, then the point to turn it round (on the plane you draw on), then click or type the angle. Copies leaves it and makes that many.',
  mirror: 'Click a solid, then two points on the mirror line (on the plane you draw on).',
};
const SOLID_TOOLS: ToolId[] = ['combine', 'move', 'rotate', 'mirror'];
const EMPTY_PLAN: SolidPlan = { solids: [], skipped: new Map() };
type ScenePreviewAngle = { plane: SketchPlane; at: Vec2; levelDeg: number; dirDeg: number; text: string } | null;
const FACE_PICK_HINT = 'Click a flat face of a solid to draw on it.';
const ANGLE_STEP_DEG = 15;
const PERSPECTIVE_KEY = 'sketch-perspective';

const readPerspective = () => { try { return localStorage.getItem(PERSPECTIVE_KEY) === '1'; } catch { return false; } };

/** Where new shapes go: a main plane, or a solid's face (and the pull that made that face). */
interface WorkPlane { plane: SketchPlane; onFeatureId?: string }

/** Corners of a solid's edges lying on a plane, and the edges themselves, in that plane's coordinates. */
const solidEdgesOn = (plane: SketchPlane, edges: Float32Array): { corners: Vec2[]; segments: [Vec2, Vec2][] } => {
  const segments: [Vec2, Vec2][] = [];
  const dirs = new Map<string, { p: Vec2; d: Vec2[] }>();
  const note = (p: Vec2, q: Vec2) => {
    const key = `${p.x.toFixed(3)},${p.y.toFixed(3)}`;
    const len = Math.hypot(q.x - p.x, q.y - p.y) || 1;
    const entry = dirs.get(key) ?? { p, d: [] };
    entry.d.push({ x: (q.x - p.x) / len, y: (q.y - p.y) / len });
    dirs.set(key, entry);
  };
  for (let i = 0; i + 5 < edges.length; i += 6) {
    const a = toPlane(plane, [edges[i], edges[i + 1], edges[i + 2]]);
    const b = toPlane(plane, [edges[i + 3], edges[i + 4], edges[i + 5]]);
    if (Math.abs(a.w) > 0.01 || Math.abs(b.w) > 0.01) continue;
    const pa = { x: a.x, y: a.y }, pb = { x: b.x, y: b.y };
    segments.push([pa, pb]);
    note(pa, pb);
    note(pb, pa);
  }
  // A corner is where the edge turns (curved edges come as many short pieces that barely turn).
  const corners: Vec2[] = [];
  for (const { p, d } of dirs.values()) {
    const turns = d.length === 1 || d.some((u, i) => d.some((v, j) => j > i && u.x * v.x + u.y * v.y > -0.966));
    if (turns) corners.push(p);
  }
  return { corners, segments };
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

type Selection = { shapeId: string } | { featureId: string } | { refId: string } | null;

/** What the pointer picked, as a selection: a solid resolves to the pull that made the face that was hit
 *  (or, failing that, the step that made the solid). */
const selectionOf = (doc: SketchDoc, picked: Pick): Selection => {
  if (!picked) return null;
  if ('shapeId' in picked || 'refId' in picked) return picked;
  return { featureId: pullAtPoint(doc, picked.solid.pullIds, picked.solid.point) ?? stepOfSolid(picked.solid.solidId) };
};

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
/** Degrees in (−180, 180]: 330 reads as −30. */
const signedDeg = (d: number) => (d > 180 ? d - 360 : d);

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
  const [work, setWork] = useState<WorkPlane>({ plane: 'front' });
  const plane = work.plane;
  const [facePick, setFacePick] = useState(false);
  const [arcMode, setArcMode] = useState(false);
  const [showDims, setShowDims] = useState(true);
  const [view, setViewState] = useState<ViewName>('front');
  const [perspective, setPerspectiveState] = useState(readPerspective);
  // Tablet stand-ins for holding Shift (line up with what is drawn) and Ctrl (lock angles).
  const [snapShapes, setSnapShapes] = useState(false);
  // Join or cut (Join/Cut tool), how many copies (Move, Rotate), and whether a mirror keeps the original.
  const [combineMode, setCombineMode] = useState<'join' | 'cut'>('join');
  const [copiesText, setCopiesText] = useState('0');
  const [mirrorKeep, setMirrorKeep] = useState(true);
  const [photoPicker, setPhotoPicker] = useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  // The step list starts open on wide screens.
  const [showSteps, setShowSteps] = useState(() => window.matchMedia('(min-width: 1280px)').matches);
  const [lockAngles, setLockAngles] = useState(false);
  const mods = useRef({ shift: false, ctrl: false, alt: false });
  const [draft, setDraftState] = useState<Draft | null>(null);
  const draftRef = useRef<Draft | null>(null);
  const setDraft = (d: Draft | null) => { draftRef.current = d; setDraftState(d); };
  const [selection, setSelection] = useState<Selection>(null);
  const [typed, setTyped] = useState<[string, string]>(['', '']);
  const typedRef = useRef<HTMLInputElement>(null);

  // ── Solids ────────────────────────────────────────────────────────────────
  const [solids, setSolids] = useState<SolidMesh[]>([]);
  const plan = useMemo(() => (doc ? planSolids(doc) : EMPTY_PLAN), [doc]);

  // Reference photos' pictures, loaded as their files are needed.
  const [refImages, setRefImages] = useState<Map<string, ReferenceImage>>(() => new Map());
  const refFileIds = useMemo(() => [...new Set((doc?.refs ?? []).map(r => r.fileId))].join(','), [doc]);
  useEffect(() => {
    let live = true;
    for (const fid of refFileIds ? refFileIds.split(',') : []) {
      if (refImages.has(fid)) continue;
      loadReferenceImage(fid)
        .then(img => { if (live) setRefImages(prev => new Map(prev).set(fid, img)); })
        .catch(() => { if (live) toast('A reference photo could not be loaded.', { type: 'warning' }); });
    }
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refFileIds]);
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
    const scene = new SketchScene(el, { dark, view: 'front', perspective: readPerspective() });
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
      doc, plan, solids, showDims, refImages,
      selectedRefId: selection && 'refId' in selection ? selection.refId : null,
      // The solid a Join/Cut, Move, Rotate or Mirror is working on.
      activeSolidId: draft?.tool === 'combine' ? draft.targetId
        : draft?.tool === 'move' || draft?.tool === 'rotate' || draft?.tool === 'mirror' ? draft.solidId : null,
      selectedShapeId: selection && 'shapeId' in selection ? selection.shapeId : null,
      selectedFeatureId: selection && 'featureId' in selection ? selection.featureId : null,
    });
    // Frame the sketch once, when it (and its solids) first arrive.
    if (!fitted.current && (doc.features.length === 0 || solids.length > 0)) {
      fitted.current = true;
      scene.fit(doc, solids);
    }
  }, [doc, plan, solids, selection, showDims, draft, refImages]);
  useEffect(() => { sceneRef.current?.setWorkPlane(plane); }, [plane]);
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const drawing = editable && !facePick && (isDrawTool(tool) || (tool === 'pull' && draft?.tool === 'pull') || draft?.tool === 'spin'
      || draft?.tool === 'move' || draft?.tool === 'rotate' || draft?.tool === 'mirror'
      || draft?.tool === 'photo-scale' || draft?.tool === 'photo-move');
    scene.setNavigation(drawing ? 'draw' : 'navigate');
  }, [tool, draft, view, editable, facePick]);

  const setView = (v: ViewName) => {
    setViewState(v);
    sceneRef.current?.setView(v);
  };

  const setTool = (t: ToolId) => {
    const preselected = selection && 'shapeId' in selection ? selection : null;
    setDraft(null);
    setTyped(['', '']);
    setFacePick(false);
    setToolState(t);
    if (isDrawTool(t)) setView(viewForPlane(plane));
    if (t !== 'select') setSelection(null);
    // A shape picked before choosing Spin or Run is the one to spin or run;
    // a solid picked before Join/Cut, Move, Rotate or Mirror is the one it works on.
    if (preselected && t === 'spin') startSpin(preselected);
    if (preselected && t === 'run') startRun(preselected);
    const solid = SOLID_TOOLS.includes(t) ? selectedSolid() : null;
    if (solid) startSolidTool(t, solid);
  };

  const setPlane = (p: PlaneId) => {
    setDraft(null);
    setFacePick(false);
    setWork({ plane: p });
    if (isDrawTool(tool)) setView(viewForPlane(p));
  };

  /** Draw on a solid's face: turn to look straight at it, with its own grid. */
  const pickFace = (clientX: number, clientY: number) => {
    const scene = sceneRef.current;
    if (!scene || !doc) return;
    const picked = scene.pick(clientX, clientY, 'solids');
    if (!picked || !('solid' in picked)) { toast('Click a face of a solid.', { type: 'warning' }); return; }
    if (!picked.solid.planar) { toast('That face is curved. Pick a flat face to draw on.', { type: 'warning' }); return; }
    const frame = faceFrame(picked.solid.point, picked.solid.normal);
    const onFeatureId = pullAtPoint(doc, picked.solid.pullIds, picked.solid.point) ?? picked.solid.solidId;
    setFacePick(false);
    setDraft(null);
    setWork({ plane: frame, onFeatureId });
    scene.setWorkPlane(frame);
    if (!isDrawTool(tool)) { setToolState('line'); setSelection(null); }
    setView('plane');
  };

  const togglePerspective = () => {
    const next = !perspective;
    setPerspectiveState(next);
    try { localStorage.setItem(PERSPECTIVE_KEY, next ? '1' : '0'); } catch { /* private mode: just this visit */ }
    sceneRef.current?.setPerspective(next);
    if (next && view !== 'iso') setView('iso');
  };

  // ── Pointer → snapped plane point → preview ─────────────────────────────────
  const pointer = useRef<{ x: number; y: number } | null>(null);
  const hover = useRef<Vec2 | null>(null);
  const pullDistance = useRef(0);

  const snapTargets = useMemo((): SnapTargets => {
    const ends: Vec2[] = [], extras: Vec2[] = [], segments: [Vec2, Vec2][] = [];
    const origin = toPlane(plane, [0, 0, 0]);
    ends.push({ x: origin.x, y: origin.y });
    // Shapes on this plane (or on the same surface facing the other way).
    for (const s of doc?.shapes ?? []) {
      if (!samePlaneSurface(s.plane, plane)) continue;
      const here = (p: Vec2): Vec2 => {
        if (samePlane(s.plane, plane)) return p;
        const q = toPlane(plane, toWorld(s.plane, p));
        return { x: q.x, y: q.y };
      };
      const corners = s.type === 'circle' ? shapeSnapPoints(s).slice(1) : [s.start, ...s.segments.map(g => g.to)];
      ends.push(...corners.map(here));
      extras.push(...shapeSnapPoints(s).map(here));
      const outline = shapeOutline(s, 16).map(here);
      for (let i = 1; i < outline.length; i++) segments.push([outline[i - 1], outline[i]]);
    }
    // The edges of solids lying on this plane: a face's own outline.
    for (const solid of solids) {
      const e = solidEdgesOn(plane, solid.edges);
      ends.push(...e.corners);
      segments.push(...e.segments);
      extras.push(...e.segments.filter(([a, b]) => Math.hypot(b.x - a.x, b.y - a.y) > 1).map(([a, b]) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })));
    }
    if (draft?.tool === 'line') {
      ends.push(draft.start);
      let prev = draft.start;
      for (const seg of draft.segments) {
        ends.push(seg.to);
        if (seg.kind === 'line') segments.push([prev, seg.to]);
        prev = seg.to;
      }
    }
    return { ends, extras, segments };
  }, [doc, draft, plane, solids]);

  const snappedAt = (clientX: number, clientY: number) => {
    const scene = sceneRef.current;
    if (!scene || !doc) return null;
    const raw = scene.planePoint(clientX, clientY, plane);
    if (!raw) return null;
    const pxPerMm = scene.pxPerMm();
    const from = draft?.tool === 'line' ? draftLastPoint(draft) : draft?.tool === 'rect' ? draft.a : draft?.tool === 'circle' ? draft.center
      : draft?.tool === 'spin' || draft?.tool === 'mirror' ? draft.a : draft?.tool === 'move' ? draft.from : draft?.tool === 'rotate' ? draft.pivot : undefined;
    const lock = ((draft?.tool === 'line' && !draft.arcThrough) || (draft?.tool !== 'line' && draft?.tool !== 'rect' && draft?.tool !== 'circle' && !!from))
      && (mods.current.ctrl || lockAngles);
    return snapPoint({
      raw, pxPerMm, step: gridStep(doc.units, pxPerMm), targets: snapTargets, from,
      free: mods.current.alt, shapes: mods.current.shift || snapShapes, angleStep: lock ? ANGLE_STEP_DEG : null,
    });
  };

  /** Where the typed sizes put the next point (line, move), the other corner (rectangle) or the
   *  edge (circle), using the pointer for what is not typed; null when nothing usable is typed. */
  const typedPoint = (d: Draft | null): Vec2 | null => {
    if (!doc || !d) return null;
    const units = doc.units;
    const ptr = hover.current;
    const [a, b] = typed;
    if (d.tool === 'line' || d.tool === 'move') {
      if (d.tool === 'line' && d.arcThrough) return null;
      const last = d.tool === 'line' ? draftLastPoint(d) : d.from;
      if (!last) return null;
      const toward = ptr ? { x: ptr.x - last.x, y: ptr.y - last.y } : { x: 1, y: 0 };
      const len = parseLength(a, units);
      const ang = b.trim() ? parseAngle(b) : null;
      if (len !== null && len > 0) {
        const dir = ang !== null ? levelAngleToward(ang, toward) : ptr && (toward.x || toward.y) ? angleDeg(last, ptr) : 0;
        return pointAt(last, len, dir);
      }
      if (ang !== null && ptr) {
        // An angle alone: along it, as far as the pointer reaches.
        const dir = levelAngleToward(ang, toward);
        const u = pointAt({ x: 0, y: 0 }, 1, dir);
        const t = toward.x * u.x + toward.y * u.y;
        return t > 0 ? pointAt(last, t, dir) : null;
      }
      return null;
    }
    if (d.tool !== 'rect' && d.tool !== 'circle') return null;
    if (d.tool === 'rect') {
      const w = parseLength(a, units), h = parseLength(b, units);
      if (!w && !h) return null;
      const sx = ptr && ptr.x < d.a.x ? -1 : 1, sy = ptr && ptr.y < d.a.y ? -1 : 1;
      return {
        x: w ? d.a.x + sx * Math.abs(w) : ptr?.x ?? d.a.x,
        y: h ? d.a.y + sy * Math.abs(h) : ptr?.y ?? d.a.y,
      };
    }
    const r = parseLength(a, units);
    return r && r > 0 ? { x: d.center.x + r, y: d.center.y } : null;
  };

  /** A typed pull distance, signed: a plain number pulls the way the pointer is pulling, a minus sign flips it. */
  const typedPull = (): number | null => {
    if (!doc) return null;
    const dist = parseLength(typed[0], doc.units);
    if (dist === null || dist === 0) return null;
    return (/^\s*[-−]/.test(typed[0]) ? 1 : Math.sign(pullDistance.current) || 1) * dist;
  };

  /** Whether pulling this shape this far cuts into the solid it was drawn on. */
  const cuts = (shape: SketchShape, distance: number) =>
    distance < 0 && !!shape.onFeatureId && !!doc?.features.some(f => f.id === shape.onFeatureId);

  const copies = () => Math.max(0, Math.min(100, parseInt(copiesText, 10) || 0));

  /** The move, turn or mirror the pointer (or the typed sizes) give, on the plane being drawn on. */
  const draftTransform = (d: Draft | null, at: Vec2 | null): Transform | null => {
    if (!d || !at) return null;
    if (d.tool === 'move' && d.from) {
      const to = typedPoint(d) ?? at;
      const by = sub(toWorld(plane, to), toWorld(plane, d.from));
      return Math.hypot(...by) > 1e-6 ? { kind: 'move', by } : null;
    }
    if (d.tool === 'rotate' && d.pivot) {
      const typedAngle = typed[0].trim() ? parseAngle(typed[0]) : null;
      const angle = typedAngle ?? (Math.hypot(at.x - d.pivot.x, at.y - d.pivot.y) > 1e-6 ? signedDeg(angleDeg(d.pivot, at)) : 0);
      return angle ? { kind: 'rotate', origin: toWorld(plane, d.pivot), axis: frameOf(plane).normal, angle } : null;
    }
    if (d.tool === 'mirror' && d.a) {
      const dir = sub(toWorld(plane, at), toWorld(plane, d.a));
      const n = cross3(dir, frameOf(plane).normal);
      const l = Math.hypot(...n);
      return l > 1e-9 ? { kind: 'mirror', origin: toWorld(plane, d.a), normal: [n[0] / l, n[1] / l, n[2] / l] } : null;
    }
    return null;
  };

  /** The places a transform puts a solid: one, or one per copy. */
  const ghostMatrices = (t: Transform) =>
    t.kind === 'mirror' ? [transformMatrix(t)] : Array.from({ length: Math.max(1, copies()) }, (_, i) => transformMatrix(t, i + 1));

  const pullShape = (d: Draft | null): SketchShape | undefined =>
    d?.tool === 'pull' ? doc?.shapes.find(s => s.id === d.shapeId) : undefined;

  const refreshPreview = () => {
    const scene = sceneRef.current;
    if (!scene || !doc) return;
    const ptr = pointer.current;
    const units = doc.units;
    if (!editable) return;
    const none = { shape: null, snap: null, readout: null, pull: null };
    if (facePick) { scene.setPreview(none); return; }
    if (tool === 'pull') {
      const shape = pullShape(draft);
      if (draft?.tool === 'pull' && shape) {
        if (ptr) {
          const d = scene.pullDistanceAt(ptr.x, ptr.y, shape);
          if (d !== null) {
            const step = gridStep(units, scene.pxPerMm());
            pullDistance.current = mods.current.alt ? d : Math.round(d / step) * step;
          }
        }
        const distance = typedPull() ?? pullDistance.current;
        const cut = cuts(shape, distance);
        const anchor = toWorld(shape.plane, shape.type === 'circle' ? shape.center : shape.start);
        scene.setPreview({
          shape: null, snap: null,
          readout: { at: anchor, text: `${cut ? 'Cut ' : ''}${formatLength(cut ? -distance : distance, units)}` },
          pull: { shape, distance, replacesFeatureId: draft.featureId, cut },
        });
      } else {
        scene.setPreview(none);
      }
      return;
    }
    if (tool === 'spin' && draft?.tool === 'spin') {
      const shape = doc.shapes.find(s => s.id === draft.shapeId);
      const snapped = ptr ? snappedAt(ptr.x, ptr.y) : null;
      if (snapped) hover.current = snapped.p;
      if (!shape || !snapped) { scene.setPreview(none); return; }
      const typedAngle = parseFloat(typed[0]);
      scene.setPreview({
        ...none,
        snap: { p: snapped.p, plane, kind: snapped.kind, guides: snapped.guides },
        spin: draft.a ? { shape, axis: [draft.a, snapped.p], angle: Number.isFinite(typedAngle) && typedAngle !== 0 ? typedAngle : 360 } : null,
      });
      return;
    }
    if (draft?.tool === 'photo-scale' || draft?.tool === 'photo-move') {
      const raw = ptr ? scene.planePoint(ptr.x, ptr.y, plane) : null;
      if (raw) hover.current = raw;
      const base = draft.tool === 'photo-scale' ? draft.a : draft.from;
      const end = draft.tool === 'photo-scale' && draft.b ? draft.b : raw;
      const snap = raw ? { p: raw, plane, kind: 'free' as const } : null;
      if (!base || !end) { scene.setPreview({ ...none, snap }); return; }
      const len = Math.hypot(end.x - base.x, end.y - base.y);
      scene.setPreview({
        ...none, snap,
        line: { plane, a: base, b: end },
        readout: { at: toWorld(plane, end), text: draft.tool === 'photo-scale' ? `now ${formatLength(len, units)}` : formatLength(len, units) },
      });
      return;
    }
    if (draft?.tool === 'move' || draft?.tool === 'rotate' || draft?.tool === 'mirror') {
      const snapped = ptr ? snappedAt(ptr.x, ptr.y) : null;
      if (snapped) hover.current = snapped.p;
      const at = snapped?.p ?? hover.current;
      const base = draft.tool === 'move' ? draft.from : draft.tool === 'rotate' ? draft.pivot : draft.a;
      const snap = snapped ? { p: snapped.p, plane, kind: snapped.kind, guides: snapped.guides } : null;
      if (!base || !at) { scene.setPreview({ ...none, snap }); return; }
      const t = draftTransform(draft, at);
      const ghost = t ? { solidId: draft.solidId, matrices: ghostMatrices(t) } : null;
      let readout: { at: Vec3; text: string } | null = null;
      let angle: ScenePreviewAngle = null;
      let line: { plane: SketchPlane; a: Vec2; b: Vec2; extend?: boolean } | null = null;
      if (t?.kind === 'move') {
        const to = typedPoint(draft) ?? at;
        const fromLevel = Math.round(angleFromLevel(base, to) * 10) / 10;
        readout = { at: toWorld(plane, to), text: `${formatLength(Math.hypot(...t.by), units)}  ${fromLevel}°` };
        angle = { plane, at: base, levelDeg: to.x < base.x - 1e-9 ? 180 : 0, dirDeg: angleDeg(base, to), text: `${fromLevel}°` };
        line = { plane, a: base, b: to };
      } else if (t?.kind === 'rotate') {
        readout = { at: toWorld(plane, at), text: `${Math.round(t.angle * 10) / 10}°` };
        angle = { plane, at: base, levelDeg: 0, dirDeg: (t.angle + 360) % 360, text: `${Math.round(t.angle * 10) / 10}°` };
      } else if (t?.kind === 'mirror') {
        line = { plane, a: base, b: at, extend: true };
      }
      scene.setPreview({ ...none, snap, readout, angle, line, ghost });
      return;
    }
    if (!isDrawTool(tool)) { scene.setPreview(none); return; }
    // The pointer's snapped point; while the pointer is off the view (in the
    // size box), the last one it had, so typed sizes still preview.
    const snapped = ptr ? snappedAt(ptr.x, ptr.y) : null;
    if (snapped) hover.current = snapped.p;
    if (!snapped && !(draft && hover.current)) { scene.setPreview(none); return; }
    const typedAt = typedPoint(draft);
    const at = typedAt ?? snapped?.p ?? hover.current!;
    const shape = draftPreview(draft, at);
    let readout: { at: [number, number, number]; text: string } | null = null;
    let angle: { plane: SketchPlane; at: Vec2; levelDeg: number; dirDeg: number; text: string } | null = null;
    if (draft?.tool === 'line' && !draft.arcThrough) {
      const last = draftLastPoint(draft);
      const len = Math.hypot(at.x - last.x, at.y - last.y);
      if (len > 0) {
        const fromLevel = Math.round(angleFromLevel(last, at) * 10) / 10;
        readout = { at: toWorld(plane, at), text: `${formatLength(len, units)}  ${fromLevel}°` };
        angle = { plane, at: last, levelDeg: at.x < last.x - 1e-9 ? 180 : 0, dirDeg: angleDeg(last, at), text: `${fromLevel}°` };
      }
    } else if (draft?.tool === 'rect') {
      readout = { at: toWorld(plane, at), text: `${formatLength(Math.abs(at.x - draft.a.x), units)} × ${formatLength(Math.abs(at.y - draft.a.y), units)}` };
    } else if (draft?.tool === 'circle') {
      readout = { at: toWorld(plane, at), text: `R ${formatLength(Math.hypot(at.x - draft.center.x, at.y - draft.center.y), units)}` };
    }
    scene.setPreview({
      shape, readout, pull: null, angle,
      snap: snapped && !typedAt ? { p: snapped.p, plane, kind: snapped.kind, guides: snapped.guides } : null,
    });
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
    if (step.commit && doc) {
      // A shape drawn on a face belongs to that face's solid.
      const shape = work.onFeatureId && samePlane(step.commit.plane, work.plane) ? { ...step.commit, onFeatureId: work.onFeatureId } : step.commit;
      commitDoc({ ...doc, shapes: [...doc.shapes, shape] });
    }
  };

  /** Backspace while drawing: take back the last point (a rectangle or circle starts over). */
  const stepBack = () => {
    const d = draftRef.current;
    if (!d) return;
    setTyped(['', '']);
    setDraft(d.tool === 'line' ? lineBack(d) : null);
  };

  const commitPull = (distance: number) => {
    const d = draftRef.current;
    if (!doc || d?.tool !== 'pull') return;
    if (Math.abs(distance) < 1e-3) { toast('Pull it out some distance first.', { type: 'warning' }); return; }
    if (d.featureId) {
      commitDoc(setPullDistance(doc, d.featureId, distance));
    } else {
      commitDoc({ ...doc, features: [...doc.features, { id: uuidv4(), type: 'pull' as const, shapeId: d.shapeId, distance }] });
    }
    setDraft(null);
    setTyped(['', '']);
    pullDistance.current = 0;
  };

  const startPull = (picked: Selection) => {
    if (!doc || !picked) return;
    const pulled = usedShapeIds(doc);
    if ('refId' in picked) return;
    if ('featureId' in picked) {
      const f = doc.features.find(ff => ff.id === picked.featureId);
      if (!f) return;
      if (f.type !== 'pull') { toast('Change that step in the step list.', { type: 'info' }); return; }
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
    if (sceneRef.current?.facesPlane(shape.plane)) setView('iso');
  };

  /** The closed, unused shape a Spin or Run starts from, or a message saying why not. */
  const profileFrom = (picked: Selection): SketchShape | string => {
    if (!doc || !picked) return 'Click a closed shape.';
    if (!('shapeId' in picked)) return 'Click a shape (an outline), not a solid or photo.';
    const shape = doc.shapes.find(s => s.id === picked.shapeId);
    if (!shape || usedShapeIds(doc).has(shape.id)) return 'Click a closed shape.';
    if (!canPull(shape)) return 'Only a closed shape can be used. Close it by ending on its first point.';
    return shape;
  };

  const startSpin = (picked: Selection) => {
    const shape = profileFrom(picked);
    if (typeof shape === 'string') { toast(shape, { type: 'warning' }); return; }
    setDraft({ tool: 'spin', shapeId: shape.id });
    setSelection({ shapeId: shape.id });
    // The axis is drawn in the shape's own plane, looking straight at it.
    setWork({ plane: shape.plane, onFeatureId: shape.onFeatureId });
    sceneRef.current?.setWorkPlane(shape.plane);
    if (!sceneRef.current?.facesPlane(shape.plane)) setView(viewForPlane(shape.plane));
  };

  const commitSpin = (d: Extract<Draft, { tool: 'spin' }>, b: Vec2) => {
    const shape = doc?.shapes.find(s => s.id === d.shapeId);
    if (!doc || !shape || !d.a || Math.hypot(b.x - d.a.x, b.y - d.a.y) < 1e-6) return;
    const typedAngle = typed[0].trim() ? parseFloat(typed[0].replace('°', '')) : 360;
    if (!Number.isFinite(typedAngle) || typedAngle === 0 || Math.abs(typedAngle) > 360) { toast('Type an angle from 1 to 360.', { type: 'warning' }); return; }
    if (!axisClearOfShape(shape, [d.a, b])) { toast('The axis runs through the shape. Put it to one side (it may run along an edge).', { type: 'warning' }); return; }
    commitDoc({ ...doc, features: [...doc.features, { id: uuidv4(), type: 'spin', shapeId: shape.id, axis: [d.a, b], angle: typedAngle }] });
    setDraft(null);
    setTyped(['', '']);
    setSelection(null);
    setView('iso');
  };

  const startRun = (picked: Selection) => {
    const shape = profileFrom(picked);
    if (typeof shape === 'string') { toast(shape, { type: 'warning' }); return; }
    setDraft({ tool: 'run', shapeId: shape.id });
    setSelection({ shapeId: shape.id });
  };

  const commitRun = (d: Extract<Draft, { tool: 'run' }>, picked: Selection) => {
    if (!doc) return;
    const path = picked && 'shapeId' in picked ? doc.shapes.find(s => s.id === picked.shapeId) : undefined;
    if (!path || usedShapeIds(doc).has(path.id)) { toast('Click the path to run along (a line, arc or outline).', { type: 'warning' }); return; }
    if (path.id === d.shapeId) { toast('Click a different shape for the path.', { type: 'warning' }); return; }
    const id = uuidv4();
    const next: SketchDoc = { ...doc, features: [...doc.features, { id, type: 'run', shapeId: d.shapeId, pathId: path.id }] };
    const why = planSolids(next).skipped.get(id);
    if (why) { toast(why, { type: 'warning' }); return; }
    commitDoc(next);
    setDraft(null);
    setSelection(null);
    if (sceneRef.current?.currentView !== 'iso') setView('iso');
  };

  /** The solid a pick landed on, or (failing a pick) the one the current selection picks out. */
  const solidAt = (clientX: number, clientY: number): string | null => {
    const picked = sceneRef.current?.pick(clientX, clientY, 'solids');
    return picked && 'solid' in picked ? picked.solid.solidId : null;
  };
  const selectedSolid = (): string | null => {
    if (!selection || !('featureId' in selection)) return null;
    const holding = plan.solids.filter(sol => sol.featureIds.includes(selection.featureId));
    return holding.length === 1 ? holding[0].id : null;
  };

  const startSolidTool = (t: ToolId, solidId: string) => {
    if (t === 'combine') setDraft({ tool: 'combine', targetId: solidId });
    else if (t === 'move') setDraft({ tool: 'move', solidId });
    else if (t === 'rotate') setDraft({ tool: 'rotate', solidId });
    else if (t === 'mirror') setDraft({ tool: 'mirror', solidId });
    setSelection(null);
  };

  const commitTransform = (d: Extract<Draft, { tool: 'move' | 'rotate' | 'mirror' }>, t: Transform) => {
    if (!doc) return;
    const id = uuidv4();
    const n = t.kind === 'mirror' ? (mirrorKeep ? 1 : 0) : copies();
    commitDoc({ ...doc, features: [...doc.features, { id, type: 'move', targetId: d.solidId, transform: t, copies: n }] });
    setDraft(null);
    setTyped(['', '']);
    setSelection(null);
  };

  // ── Export ────────────────────────────────────────────────────────────────
  const exportName = () => sketchTitle(meta?.name);

  /** The drawing sheet for the export dialog's choices (what is on screen now, saved or not). */
  const makePdf = async (o: PdfOptions): Promise<Blob> => {
    if (!doc) throw new Error('The sketch is still opening.');
    const specs: ViewSpec[] = (['front', 'top', 'side', 'iso'] as SheetView[]).filter(v => o.views[v]).map(v => {
      if (v === 'iso' && o.isoFrom === 'current' && sceneRef.current) {
        const a = sceneRef.current.currentViewAxes();
        return viewSpec('iso', a.dir, a.xAxis, false);
      }
      // The 3D view shows only the edges you would see; flat views can show hidden ones dashed.
      return viewSpec(v, SHEET_VIEWS[v].dir, SHEET_VIEWS[v].xAxis, v !== 'iso' && o.hidden);
    });
    const projected = await projectViews(doc, specs);
    if (projected.fatal) throw new Error(`The 3D engine could not draw the views: ${projected.fatal}`);
    const settings = await getSettings().catch(() => ({} as Record<string, string>));
    let logo: string | undefined = settings.logoUrl || undefined;
    if (logo && !logo.startsWith('data:')) {
      try {
        const blob = await (await fetch(logo)).blob();
        logo = await new Promise<string>(r => { const fr = new FileReader(); fr.onload = () => r(fr.result as string); fr.readAsDataURL(blob); });
      } catch { logo = undefined; }
    }
    const pdf = buildSketchPdf({
      title: exportName(),
      projectName,
      company: { name: settings.companyName || settings.appName, logoDataUrl: logo },
      notes: o.notes,
      units: doc.units,
      paper: o.paper,
      scale: o.scale === 'auto' ? undefined : scalesFor(doc.units).find(sc => sc.label === o.scale),
      showDims: o.dims,
      isoSize: o.isoSize,
      date: new Date(),
      views: specs.map((sp, i) => ({
        name: sp.name as SheetView,
        label: SHEET_VIEWS[sp.name as SheetView].label,
        projected: projected.views[i] ?? { name: sp.name, visible: [], hidden: [] },
        loose: looseShapeLines(doc, sp),
        labels: sp.name === 'iso' ? [] : viewLabels(doc, plan, sp),
      })),
    });
    return pdf.output('blob');
  };

  const saveExport = async (blob: Blob, name: string) => {
    await saveBinaryFile(uuidv4(), blob, {
      kind: 'sketch-export', name, projectId: meta?.projectId ?? undefined,
      sourceType: 'sketch', sourceId: fileId,
    });
    toast(`Saved to Documents as "${name}".`, { type: 'success' });
  };

  /** Lays a picked picture on the plane being drawn on, in the middle of the view, filling most of it. */
  const addReference = async (row: { id: string; name: string }) => {
    const scene = sceneRef.current;
    if (!doc || !scene) return;
    try {
      const img = await loadReferenceImage(row.id);
      setRefImages(prev => new Map(prev).set(row.id, img));
      const { center, width } = scene.viewOn(plane);
      const ref = {
        id: uuidv4(), fileId: row.id, name: row.name, plane, center, width: width * 0.6,
        aspect: img.height / Math.max(1, img.width), rotation: 0, opacity: 0.6,
      };
      commitDoc({ ...doc, refs: [...doc.refs, ref] });
      setSelection({ refId: ref.id });
      setShowSteps(true);
      toast('Photo added. Use Set scale with a length you know so it measures true.', { type: 'success' });
    } catch {
      toast('That picture could not be opened.', { type: 'error' });
    }
  };

  /** Set scale or Move on a reference photo: looking straight at its plane, clicks land on it. */
  const startPhotoDraft = (kind: 'photo-scale' | 'photo-move', refId: string) => {
    const ref = doc?.refs.find(r => r.id === refId);
    if (!ref) return;
    setToolState('select');
    setTyped(['', '']);
    setWork({ plane: ref.plane });
    sceneRef.current?.setWorkPlane(ref.plane);
    if (!sceneRef.current?.facesPlane(ref.plane)) setView(viewForPlane(ref.plane));
    setSelection({ refId });
    setDraft(kind === 'photo-scale' ? { tool: 'photo-scale', refId } : { tool: 'photo-move', refId });
  };

  const updateRef = (refId: string, change: (r: SketchDoc['refs'][number]) => SketchDoc['refs'][number]) => {
    if (!doc) return;
    commitDoc({ ...doc, refs: doc.refs.map(r => (r.id === refId ? change(r) : r)) });
  };

  const handleClick = (clientX: number, clientY: number) => {
    const scene = sceneRef.current;
    if (!scene || !doc) return;
    if (editable && facePick) { pickFace(clientX, clientY); return; }
    if (editable && (draft?.tool === 'photo-scale' || draft?.tool === 'photo-move')) {
      // Points on the photo itself, not snapped to the grid.
      const p = scene.planePoint(clientX, clientY, plane);
      if (!p) return;
      if (draft.tool === 'photo-scale') {
        if (!draft.a) setDraft({ ...draft, a: p });
        else if (!draft.b) { setDraft({ ...draft, b: p }); requestAnimationFrame(() => typedRef.current?.focus()); }
      } else if (!draft.from) {
        setDraft({ ...draft, from: p });
      } else {
        const by = { x: p.x - draft.from.x, y: p.y - draft.from.y };
        updateRef(draft.refId, r => ({ ...r, center: { x: r.center.x + by.x, y: r.center.y + by.y } }));
        setDraft(null);
      }
      return;
    }
    if (!editable || tool === 'select') {
      setSelection(selectionOf(doc, scene.pick(clientX, clientY)));
      return;
    }
    if (tool === 'pull') {
      if (draft?.tool === 'pull') commitPull(typedPull() ?? pullDistance.current);
      else startPull(selectionOf(doc, scene.pick(clientX, clientY)));
      return;
    }
    if (tool === 'spin') {
      if (draft?.tool !== 'spin') { startSpin(selectionOf(doc, scene.pick(clientX, clientY))); return; }
      const snapped = snappedAt(clientX, clientY);
      if (!snapped) return;
      if (!draft.a) setDraft({ ...draft, a: snapped.p });
      else commitSpin(draft, snapped.p);
      return;
    }
    if (tool === 'run') {
      const picked = selectionOf(doc, scene.pick(clientX, clientY));
      if (draft?.tool !== 'run') startRun(picked);
      else commitRun(draft, picked);
      return;
    }
    if (SOLID_TOOLS.includes(tool)) {
      if (!draft || draft.tool !== tool) {
        const solidId = solidAt(clientX, clientY);
        if (solidId) startSolidTool(tool, solidId);
        else toast('Click a solid.', { type: 'info' });
        return;
      }
      if (draft.tool === 'combine') {
        const other = solidAt(clientX, clientY);
        if (!other) { toast('Click the second solid.', { type: 'info' }); return; }
        if (other === draft.targetId) { toast('Click a different solid.', { type: 'info' }); return; }
        const id = uuidv4();
        commitDoc({ ...doc, features: [...doc.features, { id, type: 'combine', mode: combineMode, targetId: draft.targetId, toolId: other }] });
        setDraft(null);
        setSelection(null);
        return;
      }
      const snapped = snappedAt(clientX, clientY);
      if (!snapped) return;
      if (draft.tool === 'move' && !draft.from) { setDraft({ ...draft, from: snapped.p }); return; }
      if (draft.tool === 'rotate' && !draft.pivot) { setDraft({ ...draft, pivot: snapped.p }); return; }
      if (draft.tool === 'mirror' && !draft.a) { setDraft({ ...draft, a: snapped.p }); return; }
      if (draft.tool !== 'move' && draft.tool !== 'rotate' && draft.tool !== 'mirror') return;
      const t = draftTransform(draft, snapped.p);
      if (t) commitTransform(draft, t);
      return;
    }
    const snapped = snappedAt(clientX, clientY);
    if (!snapped) return;
    const id = () => uuidv4();
    if (tool === 'line') {
      applyStep(lineClick(draft, snapped.p, plane, arcMode, id));
      // An arc is usually a one-off between straight lines: after one, back to lines.
      if (arcMode && draft?.tool === 'line' && draft.arcThrough) setArcMode(false);
    }
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
      if (b.trim() && parseAngle(b) === null) return toast('Type the angle in degrees, e.g. 45.', { type: 'warning' });
      const len = parseLength(a, units);
      if (a.trim() && (len === null || len <= 0)) return bad('length');
      const to = typedPoint(d);
      if (!to) return bad('length');
      const last = draftLastPoint(d);
      applyStep(lineTyped(d, Math.hypot(to.x - last.x, to.y - last.y), angleDeg(last, to), id));
    } else if (d?.tool === 'rect') {
      const w = parseLength(a, units), h = parseLength(b, units);
      if ((a.trim() && !w) || (b.trim() && !h)) return bad('width and height');
      const to = typedPoint(d);
      if (!to) return bad('width and height');
      applyStep(rectTyped(d, Math.abs(to.x - d.a.x), Math.abs(to.y - d.a.y), to, id));
    } else if (d?.tool === 'circle') {
      const r = parseLength(a, units);
      if (!r || r <= 0) return bad('radius');
      applyStep(circleTyped(d, r, id));
    } else if (d?.tool === 'pull') {
      const dist = typedPull();
      if (dist === null) return bad('distance');
      commitPull(dist);
    } else if (d?.tool === 'spin') {
      if (!d.a || !hover.current) return toast('Click two points on the axis to spin round.', { type: 'info' });
      commitSpin(d, hover.current);
    } else if (d?.tool === 'photo-scale') {
      const len = parseLength(a, units);
      if (!d.a || !d.b || len === null || len <= 0) return bad('length');
      updateRef(d.refId, r => scaleReference(r, d.a!, d.b!, len));
      setDraft(null);
      setTyped(['', '']);
      toast(`Scaled: that length is now ${formatLength(len, units)}.`, { type: 'success' });
    } else if (d?.tool === 'move' || d?.tool === 'rotate') {
      if (d.tool === 'rotate' && typed[0].trim() && parseAngle(typed[0]) === null) return toast('Type the angle in degrees, e.g. 90.', { type: 'warning' });
      const t = draftTransform(d, hover.current);
      if (!t) return toast(d.tool === 'move' ? 'Click where to move it from, then type how far.' : 'Click the point to turn round, then type the angle.', { type: 'info' });
      commitTransform(d, t);
    }
  };

  const deleteSelection = () => {
    if (!doc || !selection) return;
    if ('featureId' in selection) {
      const f = doc.features.find(ff => ff.id === selection.featureId);
      if (!f) return;
      // A solid made from a shape goes with its shape (and whatever was drawn on its faces);
      // a join, cut, move or copy is undone by deleting its step.
      commitDoc(isShapeFeature(f) ? removeShape(doc, f.shapeId) : removeFeature(doc, f.id));
    } else if ('refId' in selection) {
      // The photo comes off the sketch; its file stays in Documents.
      commitDoc({ ...doc, refs: doc.refs.filter(r => r.id !== selection.refId) });
    } else {
      commitDoc(removeShape(doc, selection.shapeId));
    }
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
        if (facePick) setFacePick(false);
        else if (draft) setDraft(null);
        else if (selection) setSelection(null);
        else if (tool !== 'select') setTool('select');
        break;
      case 'Enter':
        if (draft?.tool === 'line') applyStep(lineFinish(draft, () => uuidv4()));
        break;
      case 'Backspace':
      case 'Delete':
        if (draft) stepBack();
        else if (selection) deleteSelection();
        break;
      case 'a': case 'A': if (tool === 'line') setArcMode(m => !m); break;
      case 'v': case 'V': setTool('select'); break;
      case 'l': case 'L': setTool('line'); break;
      case 'r': case 'R': setTool('rect'); break;
      case 'c': case 'C': setTool('circle'); break;
      case 'p': case 'P': setTool('pull'); break;
      case 's': case 'S': setTool('spin'); break;
      case 'f': case 'F': setTool('run'); break;
      case 'j': case 'J': setTool('combine'); break;
      case 'm': case 'M': setTool('move'); break;
      case 't': case 'T': setTool('rotate'); break;
      case 'i': case 'I': setTool('mirror'); break;
      default: return;
    }
    e.preventDefault();
  };
  useEffect(() => {
    const on = (e: KeyboardEvent) => keyRef.current(e);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);
  // Shift, Ctrl and Alt change the snapping as soon as they go down or up, without moving the pointer.
  const modsChanged = useRef<() => void>(() => {});
  modsChanged.current = () => refreshPreview();
  useEffect(() => {
    const on = (e: KeyboardEvent) => {
      if (e.key !== 'Shift' && e.key !== 'Control' && e.key !== 'Meta' && e.key !== 'Alt') return;
      mods.current = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey };
      modsChanged.current();
    };
    const reset = () => { mods.current = { shift: false, ctrl: false, alt: false }; modsChanged.current(); };
    window.addEventListener('keydown', on);
    window.addEventListener('keyup', on);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', on);
      window.removeEventListener('keyup', on);
      window.removeEventListener('blur', reset);
    };
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
  const readMods = (e: React.PointerEvent) => { mods.current = { shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey, alt: e.altKey }; };
  const onPointerDown = (e: React.PointerEvent) => {
    activePointers.current.add(e.pointerId);
    pointer.current = { x: e.clientX, y: e.clientY };
    readMods(e);
    if (e.pointerType === 'mouse' && e.button !== 0) { down.current = null; return; }
    down.current = activePointers.current.size === 1 ? { id: e.pointerId, x: e.clientX, y: e.clientY } : null;
    refreshPreview();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    pointer.current = { x: e.clientX, y: e.clientY };
    readMods(e);
    refreshPreview();
  };
  const onPointerUp = (e: React.PointerEvent) => {
    activePointers.current.delete(e.pointerId);
    readMods(e);
    const d = down.current;
    down.current = null;
    if (!d || d.id !== e.pointerId) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_SLOP_PX) return;
    handleClick(e.clientX, e.clientY);
  };
  const onPointerLeave = () => {
    pointer.current = null;
    if (editable && isDrawTool(tool) && !draft) sceneRef.current?.setPreview({ shape: null, snap: null, readout: null, pull: null });
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
    draft?.tool === 'line' && !draft.arcThrough ? [{ label: 'Length', placeholder: units === 'metric' ? '250' : `1' 4 1/2"` }, { label: 'Angle °', placeholder: 'from level' }]
    : draft?.tool === 'rect' ? [{ label: 'Width', placeholder: units === 'metric' ? '600' : `2'` }, { label: 'Height', placeholder: units === 'metric' ? '90' : '3 1/2' }]
    : draft?.tool === 'circle' ? [{ label: 'Radius', placeholder: units === 'metric' ? '50' : '2' }]
    : draft?.tool === 'pull' ? [{ label: 'Distance', placeholder: units === 'metric' ? '300' : `1'` }]
    : draft?.tool === 'spin' ? [{ label: 'Angle °', placeholder: '360' }]
    : draft?.tool === 'move' && draft.from ? [{ label: 'Length', placeholder: units === 'metric' ? '250' : `1' 4 1/2"` }, { label: 'Angle °', placeholder: 'from level' }]
    : draft?.tool === 'rotate' && draft.pivot ? [{ label: 'Angle °', placeholder: '90' }]
    : draft?.tool === 'photo-scale' && draft.b ? [{ label: 'Real length', placeholder: units === 'metric' ? '600' : `2' 6"` }]
    : [];
  const draftHint = draft?.tool === 'spin' ? (draft.a ? 'Click the second point of the axis.' : 'Click the first point of the line to spin round.')
    : draft?.tool === 'run' ? 'Now click the path to run it along.'
    : draft?.tool === 'combine' ? (combineMode === 'join' ? 'Now click the solid to join to it.' : 'Now click the solid to cut away from it.')
    : draft?.tool === 'move' ? (draft.from ? 'Click where it goes, or type how far.' : 'Click the point to move it from.')
    : draft?.tool === 'rotate' ? (draft.pivot ? 'Click or type the angle (counter-clockwise).' : 'Click the point to turn it round.')
    : draft?.tool === 'mirror' ? (draft.a ? 'Click the second point of the mirror line.' : 'Click the first point of the mirror line.')
    : draft?.tool === 'photo-scale' ? (draft.b ? 'How long is that really?' : draft.a ? 'Click the other end of it.' : 'Click one end of a length you know on the photo (zoom in for accuracy).')
    : draft?.tool === 'photo-move' ? (draft.from ? 'Click where that point should go.' : 'Click a point on the photo.')
    : null;

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
        {doc && (
          <Button variant="secondary" onClick={() => setExportOpen(true)} data-testid="sketch-export" size="sm" title="A drawing sheet (PDF) of the views">
            <FileDown size={15} /><span className="hidden sm:inline">Export</span>
          </Button>
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
              title="Arc: the next click sets the curve, the one after its end; then it is back to lines (A)"
              aria-label="Arc"
              aria-pressed={arcMode && tool === 'line'}
              className={`flex size-10 items-center justify-center rounded-lg transition-colors ${arcMode && tool === 'line' ? 'bg-fuchsia-600 text-white' : 'text-ink-soft hover:bg-hover hover:text-ink'}`}
            >
              <Spline size={18} />
            </button>
            {toolButton('rect', 'Rectangle', <RectangleHorizontal size={18} />, 'R')}
            {toolButton('circle', 'Circle', <Circle size={18} />, 'C')}
            {toolButton('pull', 'Pull into 3D', <ArrowUpFromLine size={18} />, 'P')}
            {toolButton('spin', 'Spin round a line', <Rotate3d size={18} />, 'S')}
            {toolButton('run', 'Run along a path', <Route size={18} />, 'F')}
            <div className="my-1 h-px w-8 bg-edge" />
            {toolButton('combine', 'Join or cut solids', <Combine size={18} />, 'J')}
            {toolButton('move', 'Move or copy', <Move size={18} />, 'M')}
            {toolButton('rotate', 'Rotate or copy round', <RotateCw size={18} />, 'T')}
            {toolButton('mirror', 'Mirror', <FlipHorizontal2 size={18} />, 'I')}
            <div className="my-1 h-px w-8 bg-edge" />
            <button type="button" data-testid="sketch-add-photo" onClick={() => setPhotoPicker(true)}
              title="Add a reference photo, scan or print to trace over" aria-label="Add a reference photo"
              className="flex size-10 items-center justify-center rounded-lg text-ink-soft transition-colors hover:bg-hover hover:text-ink">
              <ImagePlus size={18} />
            </button>
            <div className="my-1 h-px w-8 bg-edge" />
            <button
              type="button"
              data-testid="sketch-snap-shapes"
              onClick={() => setSnapShapes(v => !v)}
              title="Line up with what is drawn: ends, midpoints, centres, along lines and level or plumb with existing points (or hold Shift)"
              aria-label="Line up with what is drawn"
              aria-pressed={snapShapes}
              className={`flex size-10 items-center justify-center rounded-lg transition-colors ${snapShapes ? 'bg-cyan-600 text-white' : 'text-ink-soft hover:bg-hover hover:text-ink'}`}
            >
              <Magnet size={18} />
            </button>
            <button
              type="button"
              data-testid="sketch-lock-angles"
              onClick={() => setLockAngles(v => !v)}
              title={`Lock lines to every ${ANGLE_STEP_DEG}° (or hold Ctrl)`}
              aria-label="Lock angles"
              aria-pressed={lockAngles}
              className={`flex size-10 items-center justify-center rounded-lg transition-colors ${lockAngles ? 'bg-cyan-600 text-white' : 'text-ink-soft hover:bg-hover hover:text-ink'}`}
            >
              <TriangleRight size={18} />
            </button>
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
            className={`absolute inset-0 ${editable && facePick ? 'cursor-pointer' : editable && (isDrawTool(tool) || draft) ? 'cursor-crosshair' : 'cursor-default'}`}
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
                <button key={p} type="button" data-testid={`sketch-plane-${p}`} onClick={() => setPlane(p)} aria-pressed={plane === p && !facePick}
                  className={`rounded-md px-2 py-1 font-medium ${plane === p && !facePick ? 'bg-accent-600 text-white' : 'text-ink-soft hover:bg-hover'}`}>
                  {PLANE_LABELS[p]}
                </button>
              ))}
              <button type="button" data-testid="sketch-plane-face"
                onClick={() => {
                  if (facePick) { setFacePick(false); return; }
                  setDraft(null);
                  setTyped(['', '']);
                  setFacePick(true);
                }}
                disabled={solids.length === 0}
                title={solids.length === 0 ? 'Pull a shape into a solid first, then draw on its faces' : 'Draw on a flat face of a solid: click this, then click the face'}
                aria-pressed={facePick || typeof plane !== 'string'}
                className={`rounded-md px-2 py-1 font-medium disabled:opacity-40 ${facePick || typeof plane !== 'string' ? 'bg-accent-600 text-white' : 'text-ink-soft hover:bg-hover'}`}>
                Face
              </button>
            </div>
          )}

          <div className="pointer-events-auto absolute right-3 top-3 flex items-center gap-1 rounded-lg border border-edge bg-raised/95 p-1 text-xs shadow-sm">
            {(['top', 'front', 'side'] as ViewName[]).map(v => (
              <button key={v} type="button" onClick={() => setView(v)} aria-pressed={view === v} data-testid={`sketch-view-${v}`}
                className={`rounded-md px-2 py-1 font-medium capitalize ${view === v ? 'bg-sunken text-ink' : 'text-ink-soft hover:bg-hover'}`}>{v}</button>
            ))}
            <button type="button" onClick={() => setView('iso')} aria-pressed={view === 'iso'} title="3D view" data-testid="sketch-view-iso"
              className={`flex items-center gap-1 rounded-md px-2 py-1 font-medium ${view === 'iso' ? 'bg-sunken text-ink' : 'text-ink-soft hover:bg-hover'}`}><Box size={13} />3D</button>
            <button type="button" onClick={togglePerspective} aria-pressed={perspective} data-testid="sketch-perspective"
              title={perspective ? 'Perspective is on in the 3D view (further away looks smaller). Click for a flat 3D view.' : 'Turn on perspective for the 3D view'}
              className={`rounded-md px-2 py-1 font-medium ${perspective ? 'bg-sunken text-ink' : 'text-ink-soft hover:bg-hover'}`}>Perspective</button>
            <div className="mx-0.5 h-4 w-px bg-edge" />
            <button type="button" onClick={() => doc && sceneRef.current?.fit(doc, solids)} title="Fit everything in view" aria-label="Fit"
              className="rounded-md p-1 text-ink-soft hover:bg-hover"><Maximize size={14} /></button>
            <button type="button" onClick={() => setShowDims(s => !s)} title={showDims ? 'Hide dimensions' : 'Show dimensions'} aria-label="Dimensions"
              aria-pressed={showDims} className="rounded-md p-1 text-ink-soft hover:bg-hover">{showDims ? <Eye size={14} /> : <EyeOff size={14} />}</button>
            <button type="button" onClick={() => setShowSteps(v => !v)} aria-pressed={showSteps} data-testid="sketch-steps-toggle"
              title={showSteps ? 'Hide the steps' : 'Show the steps'}
              className={`flex items-center gap-1 rounded-md px-1.5 py-1 font-medium ${showSteps ? 'bg-sunken text-ink' : 'text-ink-soft hover:bg-hover'}`}>
              <ListOrdered size={14} />{doc?.features.length ? doc.features.length : ''}
            </button>
          </div>

          {showSteps && doc && (
            <div className="pointer-events-none absolute bottom-20 right-3 top-14 flex flex-col items-end gap-2">
              <SketchSteps
                doc={doc}
                plan={plan}
                selectedId={selection && 'featureId' in selection ? selection.featureId : null}
                editable={editable}
                onSelect={id => { setDraft(null); setSelection(id ? { featureId: id } : null); }}
                onChange={next => commitDoc(next)}
                onClose={() => setShowSteps(false)}
                onError={m => toast(m, { type: 'warning' })}
              />
              <SketchRefs
                refs={doc.refs}
                units={doc.units}
                selectedId={selection && 'refId' in selection ? selection.refId : null}
                editable={editable}
                onSelect={id => { setDraft(null); setSelection(id ? { refId: id } : null); }}
                onUpdate={updateRef}
                onRemove={id => { commitDoc({ ...doc, refs: doc.refs.filter(r => r.id !== id) }); setSelection(null); setDraft(null); }}
                onScale={id => startPhotoDraft('photo-scale', id)}
                onMove={id => startPhotoDraft('photo-move', id)}
              />
            </div>
          )}

          {doc && (
            <SketchExportModal
              open={exportOpen}
              onClose={() => setExportOpen(false)}
              units={doc.units}
              makePdf={makePdf}
              onDownload={blob => downloadBlob(blob, `${exportName()} - drawing.pdf`)}
              onSave={blob => saveExport(new Blob([blob], { type: 'application/pdf' }), `${exportName()} - drawing.pdf`)}
            />
          )}

          <FilePickerModal
            open={photoPicker}
            onClose={() => setPhotoPicker(false)}
            title="Add a reference photo"
            accept="image-pdf"
            multi={false}
            defaultTab="upload"
            initialProjectIds={meta?.projectId ? [meta.projectId] : undefined}
            upload={{ kind: 'sketch-photo', projectId: meta?.projectId ?? undefined, sourceType: 'sketch', sourceId: fileId }}
            onPick={rows => { setPhotoPicker(false); if (rows[0]) void addReference(rows[0]); }}
          />

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
            <div className="pointer-events-none absolute inset-x-3 bottom-3 flex justify-center">
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
                          onKeyDown={e => {
                            if (e.key === 'Escape') { setTyped(['', '']); (e.target as HTMLInputElement).blur(); }
                            // Backspace in an empty box steps back, as it does on the drawing.
                            else if (e.key === 'Backspace' && !typed[0] && !typed[1]) { e.preventDefault(); stepBack(); }
                          }}
                          placeholder={f.placeholder}
                          inputMode="text"
                          className="w-24 rounded-md border border-edge bg-raised px-2 py-1 text-sm text-ink placeholder:text-ink-faint focus:outline-none focus:ring-2 focus:ring-accent-500"
                        />
                      </label>
                    ))}
                    <Button type="submit" size="sm">Enter</Button>
                  </form>
                ) : (
                  <span className="text-xs text-ink-soft">{facePick ? FACE_PICK_HINT : draftHint ?? TOOL_HINTS[tool]}</span>
                )}
                {typedFields.length > 0 && draftHint && <span className="text-xs text-ink-faint">{draftHint}</span>}
                {tool === 'combine' && (
                  <span className="flex items-center gap-0.5 rounded-md border border-edge p-0.5 text-xs">
                    {(['join', 'cut'] as const).map(m => (
                      <button key={m} type="button" data-testid={`sketch-combine-${m}`} onClick={() => setCombineMode(m)} aria-pressed={combineMode === m}
                        className={`rounded px-2 py-0.5 font-medium ${combineMode === m ? 'bg-accent-600 text-white' : 'text-ink-soft hover:bg-hover'}`}>
                        {m === 'join' ? 'Join' : 'Cut'}
                      </button>
                    ))}
                  </span>
                )}
                {(tool === 'move' || tool === 'rotate') && (
                  <label className="flex items-center gap-1.5 text-xs text-ink-soft" title="0 moves the solid itself; more leaves it and makes that many copies, each one step further on">
                    Copies
                    <input value={copiesText} onChange={e => setCopiesText(e.target.value.replace(/[^0-9]/g, ''))} inputMode="numeric" data-testid="sketch-copies"
                      className="w-12 rounded-md border border-edge bg-raised px-2 py-1 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-accent-500" />
                  </label>
                )}
                {tool === 'mirror' && (
                  <label className="flex items-center gap-1.5 text-xs text-ink-soft">
                    <input type="checkbox" checked={mirrorKeep} onChange={e => setMirrorKeep(e.target.checked)} data-testid="sketch-mirror-keep" />
                    Keep the original
                  </label>
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
