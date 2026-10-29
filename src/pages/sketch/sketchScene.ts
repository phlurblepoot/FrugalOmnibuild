// src/pages/sketch/sketchScene.ts
// The sketch editor's 3D view (three.js): a camera looking from Top, Front,
// Side, straight at the work plane (a face), or from a 3D angle, flat or in
// perspective; the grid on the work plane; the sketch's shapes and solids;
// dimension labels; and the in-progress preview (snap guides, the angle being
// drawn, a pull's ghost). World units are millimetres with z up, as in the
// sketch file and OpenCascade.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { LineSegments2 } from 'three/examples/jsm/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/examples/jsm/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import {
  arcPoints, circleThrough, cuttingPulls, formatLength, frameOf, recipePieces, referenceCorners, shapeOutline, toWorld,
  usedShapeIds, type RecipePiece, type ReferencePhoto, type SketchDoc, type SketchPlane, type SketchShape, type SketchUnits, type SolidPlan, type Vec2, type Vec3,
} from './sketchModel';
import { gridStep, majorEvery, type SnapKind } from './sketchSnap';
import type { SolidMesh } from './geometryTypes';
import type { ReferenceImage } from './referenceImage';
import { edgeCount, edgeLine, edgeRefPoint, edgesOfFace, faceOfTriangle } from './sketchEdges';

/** 'plane' looks straight at the work plane (a face of a solid). */
export type ViewName = 'top' | 'front' | 'side' | 'iso' | 'plane';

/** The view that looks straight at a plane. */
export const viewForPlane = (plane: SketchPlane): ViewName =>
  typeof plane === 'string' ? ({ ground: 'top', front: 'front', side: 'side' } as const)[plane] : 'plane';

// Camera direction (from the target) and screen-up for each view. Top looks
// straight down with y up the screen; Front looks along +y; Side along −x;
// the 3D view from the front-right, above.
const VIEWS: Record<Exclude<ViewName, 'plane'>, { dir: Vec3; up: Vec3 }> = {
  top: { dir: [0, 0, 1], up: [0, 1, 0] },
  front: { dir: [0, -1, 0], up: [0, 0, 1] },
  side: { dir: [1, 0, 0], up: [0, 0, 1] },
  iso: { dir: [1, -1.2, 0.9], up: [0, 0, 1] },
};
const CAMERA_DISTANCE = 100_000;
const FOV_DEG = 40;
const TAN_HALF_FOV = Math.tan((FOV_DEG * Math.PI) / 360);

export interface SceneContent {
  doc: SketchDoc;
  /** How the steps make solids (for labelling each piece). */
  plan: SolidPlan;
  solids: SolidMesh[];
  selectedShapeId: string | null;
  selectedFeatureId: string | null;
  /** A solid a tool is working on, shown as picked. */
  activeSolidId?: string | null;
  showDims: boolean;
  /** Reference photos, the pictures loaded so far (by file id), and the one picked. */
  refImages?: Map<string, ReferenceImage>;
  selectedRefId?: string | null;
}

export interface ScenePreview {
  shape: SketchShape | null;
  /** The snapped point, and the points its level or plumb guides run from. */
  snap: { p: Vec2; plane: SketchPlane; kind: SnapKind; guides?: Vec2[] } | null;
  /** Live readout beside the pointer (e.g. the length being drawn). */
  readout: { at: Vec3; text: string } | null;
  /** A pull being dragged: the shape, how far, the solid it replaces (if
   *  any), and whether it cuts into the solid it was drawn on. */
  pull: { shape: SketchShape; distance: number; replacesFeatureId?: string; cut?: boolean } | null;
  /** The angle of the line being drawn, measured from level: a dashed level
   *  line from the corner toward `levelDeg` (0 or 180), and an arc to the line. */
  angle?: { plane: SketchPlane; at: Vec2; levelDeg: number; dirDeg: number; text: string } | null;
  /** A spin being set up: the shape, its axis (one point, or both), and how far round. */
  spin?: { shape: SketchShape; axis: [Vec2, Vec2 | null]; angle: number } | null;
  /** A solid being moved, turned or mirrored: see-through copies of it at each place it will go
   *  (4×4 column-major matrices). */
  ghost?: { solidId: string; matrices: number[][] } | null;
  /** A dashed line on a plane: a move's direction, or (extended both ways) a mirror line. */
  line?: { plane: SketchPlane; a: Vec2; b: Vec2; extend?: boolean } | null;
  /** Edges picked to round or bevel, and the one under the pointer (segments, xyz xyz …). */
  edges?: { picked: Float32Array[]; hover: Float32Array | null } | null;
}

/** An edge of a solid under the pointer. */
export interface EdgeHit {
  solidId: string;
  /** Which of the solid's edges (see edgeRuns). */
  index: number;
  /** A point on it away from its ends, which finds it again when the solid is rebuilt. */
  point: Vec3;
  line: Float32Array;
}

/** The edges to pick from: a solid's as shown, or (while a rounding is previewed) as they were before it. */
export interface EdgeSource { solidId: string; edges: Float32Array; edgeRuns: Uint32Array }

/** A solid under the pointer: which one, where, and the face it was hit on. */
export interface SolidHit {
  /** The step that made the solid, every step in it, and the pulls still where they were drawn. */
  solidId: string;
  featureIds: string[];
  pullIds: string[];
  point: Vec3;
  /** Out of the solid. */
  normal: Vec3;
  /** Whether the face is flat (only flat faces can be drawn on). */
  planar: boolean;
}

export type Pick = { shapeId: string } | { solid: SolidHit } | { refId: string } | null;

interface Theme { background: number; line: number; selected: number; preview: number; gridMinor: number; gridMajor: number; solid: number; edge: number }
const LIGHT: Theme = { background: 0xf8fafc, line: 0x1e293b, selected: 0x2563eb, preview: 0xc026d3, gridMinor: 0xe2e8f0, gridMajor: 0xcbd5e1, solid: 0xe7e5e4, edge: 0x334155 };
const DARK: Theme = { background: 0x0f172a, line: 0xe2e8f0, selected: 0x60a5fa, preview: 0xe879f9, gridMinor: 0x1e293b, gridMajor: 0x334155, solid: 0xa8a29e, edge: 0x0f172a };
const GUIDE_COLOR = 0x0891b2;
const CUT_COLOR = 0xdc2626;

const v3 = (p: Vec3) => new THREE.Vector3(p[0], p[1], p[2]);

/** The matrix taking sketch-plane coordinates (x, y, along-normal) to the world. */
const planeMatrix = (plane: SketchPlane): THREE.Matrix4 => {
  const f = frameOf(plane);
  return new THREE.Matrix4().makeBasis(v3(f.xDir), v3(f.yDir), v3(f.normal)).setPosition(v3(f.origin));
};

const threeShape = (s: SketchShape): THREE.Shape => {
  const pts = shapeOutline(s, 32);
  return new THREE.Shape(pts.map(p => new THREE.Vector2(p.x, p.y)));
};

const labelEl = (text: string, cls: 'dim' | 'readout' | 'pull' | 'cut' | 'angle'): HTMLDivElement => {
  const el = document.createElement('div');
  el.textContent = text;
  el.className = `sketch-label sketch-label-${cls}`;
  return el;
};

export class SketchScene {
  private renderer: THREE.WebGLRenderer;
  private labels: CSS2DRenderer;
  private scene = new THREE.Scene();
  private ortho: THREE.OrthographicCamera;
  private persp: THREE.PerspectiveCamera;
  private camera: THREE.OrthographicCamera | THREE.PerspectiveCamera;
  private perspective = false;
  private controls: OrbitControls;
  private grid = new THREE.Group();
  private content = new THREE.Group();
  private preview = new THREE.Group();
  private raycaster = new THREE.Raycaster();
  private theme: Theme;
  private frameHeight = 1200; // mm visible top to bottom at zoom 1
  private view: ViewName = 'iso';
  private workPlane: SketchPlane = 'ground';
  private units: SketchUnits = 'imperial';
  private pickables: THREE.Object3D[] = [];
  private renderQueued = false;
  private resizeObserver: ResizeObserver;
  /** Called when the zoom or view changes, so the editor can re-snap to the new grid. */
  onCameraChange: (() => void) | null = null;

  constructor(private container: HTMLElement, opts: { dark: boolean; view?: ViewName; perspective?: boolean }) {
    this.theme = opts.dark ? DARK : LIGHT;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.touchAction = 'none';
    container.appendChild(this.renderer.domElement);
    this.labels = new CSS2DRenderer();
    Object.assign(this.labels.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    container.appendChild(this.labels.domElement);

    this.ortho = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, CAMERA_DISTANCE * 3);
    this.ortho.up.set(0, 0, 1);
    this.persp = new THREE.PerspectiveCamera(FOV_DEG, 1, 1, CAMERA_DISTANCE);
    this.persp.up.set(0, 0, 1);
    this.camera = this.ortho;
    this.perspective = !!opts.perspective;
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.zoomToCursor = true;
    this.controls.addEventListener('change', () => {
      this.fitClipping();
      this.rebuildGrid();
      this.requestRender();
      this.onCameraChange?.();
    });

    this.scene.add(new THREE.AmbientLight(0xffffff, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.8);
    sun.position.set(0.6, -1, 1.4);
    this.scene.add(sun);
    const fill = new THREE.DirectionalLight(0xffffff, 0.6);
    fill.position.set(-1, 0.8, 0.3);
    this.scene.add(fill);
    this.scene.add(this.grid, this.content, this.preview);
    this.applyTheme();

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
    this.resize();
    this.setView(opts.view ?? 'iso');
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.clear(this.grid);
    this.clear(this.content);
    this.clear(this.preview);
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labels.domElement.remove();
  }

  setDark(dark: boolean): void {
    this.theme = dark ? DARK : LIGHT;
    this.applyTheme();
  }

  setUnits(units: SketchUnits): void {
    this.units = units;
    this.rebuildGrid();
  }

  // ── Camera ────────────────────────────────────────────────────────────────

  get currentView(): ViewName { return this.view; }

  /** How tall (in mm) the view is at the point it turns around. */
  private visibleHeight(): number {
    if (this.camera === this.persp) return 2 * this.persp.position.distanceTo(this.controls.target) * TAN_HALF_FOV;
    return this.frameHeight / this.ortho.zoom;
  }

  /** Keeps the perspective camera's near and far planes around what it looks at. */
  private fitClipping(): void {
    if (this.camera !== this.persp) return;
    const d = this.persp.position.distanceTo(this.controls.target);
    this.persp.near = Math.max(0.1, d / 500);
    this.persp.far = d * 60 + 10_000;
    this.persp.updateProjectionMatrix();
  }

  private viewFrame(view: ViewName): { dir: THREE.Vector3; up: THREE.Vector3 } {
    if (view === 'plane') {
      const f = frameOf(this.workPlane);
      return { dir: v3(f.normal).normalize(), up: v3(f.yDir) };
    }
    return { dir: v3(VIEWS[view].dir).normalize(), up: v3(VIEWS[view].up) };
  }

  /** Turns to a view, keeping the zoom. The 3D view uses perspective when that is on. */
  setView(view: ViewName): void {
    const height = this.visibleHeight();
    this.view = view;
    const camera = view === 'iso' && this.perspective ? this.persp : this.ortho;
    if (camera !== this.camera) {
      this.camera = camera;
      this.controls.object = camera;
    }
    const { dir, up } = this.viewFrame(view);
    this.camera.up.copy(up);
    const distance = camera === this.persp ? height / (2 * TAN_HALF_FOV) : CAMERA_DISTANCE;
    this.camera.position.copy(this.controls.target).addScaledVector(dir, distance);
    this.camera.lookAt(this.controls.target);
    if (camera === this.ortho) this.ortho.zoom = this.frameHeight / height;
    // OrbitControls fixes its orbit axis from camera.up when built; the 3D view
    // orbits around z, the flat views do not orbit at all.
    this.controls.enableRotate = view === 'iso';
    this.camera.updateProjectionMatrix();
    this.fitClipping();
    this.controls.update();
    this.rebuildGrid();
    this.requestRender();
  }

  /** Perspective (things further away look smaller) for the 3D view; the flat views stay true to size. */
  setPerspective(on: boolean): void {
    if (on === this.perspective) return;
    this.perspective = on;
    if (this.view === 'iso') {
      // Keep looking from the same direction, only the projection changes.
      const dir = this.camera.position.clone().sub(this.controls.target).normalize();
      this.setView('iso');
      const distance = this.camera === this.persp ? this.visibleHeight() / (2 * TAN_HALF_FOV) : CAMERA_DISTANCE;
      this.camera.position.copy(this.controls.target).addScaledVector(dir, distance);
      this.camera.lookAt(this.controls.target);
      this.fitClipping();
      this.controls.update();
      this.requestRender();
    }
  }

  /** Whether the camera looks straight along a plane's normal (so nothing can be pulled toward you). */
  facesPlane(plane: SketchPlane): boolean {
    const look = new THREE.Vector3();
    this.camera.getWorldDirection(look);
    return Math.abs(look.dot(v3(frameOf(plane).normal))) > 0.999;
  }

  /** How the pointer drives the view: drawing keeps one finger / the left
   *  button (and the Pencil) for the tool, otherwise it pans (flat views) or
   *  orbits (3D). With `fingersNavigate` (the Pencil draws), one finger
   *  always moves the view. Two fingers always pinch and pan. */
  setNavigation(mode: 'draw' | 'navigate', fingersNavigate = false): void {
    const orbit = this.view === 'iso';
    const leftAction = mode === 'draw' ? -1 : orbit ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
    this.controls.mouseButtons = { LEFT: leftAction as THREE.MOUSE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    const oneTouch = mode === 'draw' && !fingersNavigate ? -1 : orbit ? THREE.TOUCH.ROTATE : THREE.TOUCH.PAN;
    this.controls.touches = { ONE: oneTouch as THREE.TOUCH, TWO: THREE.TOUCH.DOLLY_PAN };
  }

  /** Stops the view moving (while the Pencil draws, so a resting palm cannot pan it). */
  holdView(hold: boolean): void {
    this.controls.enabled = !hold;
  }

  /** Lifts the live readout well clear of the point, so a fingertip on it does not hide it. */
  setReadoutClearOfFinger(on: boolean): void {
    this.readoutLift = on ? 3.4 : 1.4;
  }
  private readoutLift = 1.4;

  /** Zoom and centre on everything drawn (or a default area when empty). */
  fit(doc: SketchDoc, solids: SolidMesh[]): void {
    const box = new THREE.Box3();
    for (const s of doc.shapes) for (const p of shapeOutline(s, 8)) box.expandByPoint(v3(toWorld(s.plane, p)));
    for (const s of solids) {
      for (let i = 0; i < s.positions.length; i += 3) box.expandByPoint(new THREE.Vector3(s.positions[i], s.positions[i + 1], s.positions[i + 2]));
    }
    if (box.isEmpty()) {
      const half = this.units === 'metric' ? 500 : 609.6;
      box.set(new THREE.Vector3(-half / 4, -half / 4, 0), new THREE.Vector3(half, half, half / 2));
    }
    const center = box.getCenter(new THREE.Vector3());
    this.controls.target.copy(center);
    // The box's extent as seen from the camera, so it fills the view with a margin.
    this.setView(this.view);
    const corners = [0, 1].flatMap(i => [0, 1].flatMap(j => [0, 1].map(k => new THREE.Vector3(
      i ? box.max.x : box.min.x, j ? box.max.y : box.min.y, k ? box.max.z : box.min.z))));
    this.camera.updateMatrixWorld();
    const inv = this.camera.matrixWorldInverse;
    const local = corners.map(c => c.clone().applyMatrix4(inv));
    const w = Math.max(...local.map(c => c.x)) - Math.min(...local.map(c => c.x));
    const h = Math.max(...local.map(c => c.y)) - Math.min(...local.map(c => c.y));
    const needed = Math.max(h, w / this.aspect(), 1) * 1.35;
    if (this.camera === this.persp) {
      const dir = this.persp.position.clone().sub(this.controls.target).normalize();
      this.persp.position.copy(this.controls.target).addScaledVector(dir, needed / (2 * TAN_HALF_FOV) + Math.max(w, h) / 2);
      this.fitClipping();
    } else {
      this.ortho.zoom = this.frameHeight / needed;
    }
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.rebuildGrid();
    this.requestRender();
  }

  /** Which way the camera looks now, as a view for a drawing sheet: `dir` toward the viewer, `xAxis` to the right. */
  currentViewAxes(): { dir: Vec3; xAxis: Vec3 } {
    this.camera.updateMatrixWorld();
    const look = new THREE.Vector3();
    this.camera.getWorldDirection(look);
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion);
    return { dir: [-look.x, -look.y, -look.z], xAxis: [right.x, right.y, right.z] };
  }

  /** Where the middle of the view meets a plane, and how wide the view is there (mm). */
  viewOn(plane: SketchPlane): { center: Vec2; width: number } {
    const r = this.renderer.domElement.getBoundingClientRect();
    const center = this.planePoint(r.left + r.width / 2, r.top + r.height / 2, plane) ?? { x: 0, y: 0 };
    return { center, width: (this.container.clientWidth || 1) / this.pxPerMm() };
  }

  /** Screen pixels per world millimetre (at the point the view turns around). */
  pxPerMm(): number {
    return (this.container.clientHeight || 1) / this.visibleHeight();
  }

  private aspect(): number {
    return (this.container.clientWidth || 1) / (this.container.clientHeight || 1);
  }

  private resize(): void {
    const w = this.container.clientWidth, h = this.container.clientHeight;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.labels.setSize(w, h);
    const a = w / h, half = this.frameHeight / 2;
    Object.assign(this.ortho, { left: -half * a, right: half * a, top: half, bottom: -half });
    this.ortho.updateProjectionMatrix();
    this.persp.aspect = a;
    this.persp.updateProjectionMatrix();
    this.rebuildGrid();
    this.requestRender();
  }

  // ── Picking ───────────────────────────────────────────────────────────────

  private rayAt(clientX: number, clientY: number): THREE.Ray {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    return this.raycaster.ray;
  }

  /** Where the pointer meets a work plane, in that plane's coordinates. */
  planePoint(clientX: number, clientY: number, plane: SketchPlane): Vec2 | null {
    const ray = this.rayAt(clientX, clientY);
    const f = frameOf(plane);
    const hit = ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(v3(f.normal), v3(f.origin)), new THREE.Vector3());
    if (!hit) return null;
    const rel = hit.sub(v3(f.origin));
    return { x: rel.dot(v3(f.xDir)), y: rel.dot(v3(f.yDir)) };
  }

  /** The shape or solid under the pointer (a line within `slopPx` of it counts). */
  pick(clientX: number, clientY: number, only?: 'solids', slopPx = 10): Pick {
    this.rayAt(clientX, clientY);
    const px = this.pxPerMm();
    this.raycaster.params.Line = { threshold: slopPx / px };
    const all = this.raycaster.intersectObjects(only === 'solids' ? this.pickables.filter(o => o.userData.solid) : this.pickables, false);
    // Reference photos only when nothing else is there: they lie behind the drawing.
    const hits = all.filter(h => !h.object.userData.refId);
    if (!hits.length) {
      const photo = all.find(h => h.object.userData.refId);
      return photo ? { refId: photo.object.userData.refId as string } : null;
    }
    // Lines and fills before solids at the same depth: a sketch drawn on a face stays pickable.
    const reach = hits[0].distance + Math.max(0.5, 2 / px);
    const hit = hits.find(h => h.object.userData.shapeId && h.distance <= reach) ?? hits[0];
    const { shapeId, solid } = hit.object.userData as { shapeId?: string; solid?: SolidMesh };
    if (solid) return { solid: this.solidHit(solid, hit) };
    if (shapeId) return { shapeId };
    return null;
  }

  /** The screen position (px from the view's top left) of a world point, and how far it is in front of the camera. */
  private toScreen(p: THREE.Vector3, out: THREE.Vector3): THREE.Vector3 {
    out.copy(p).project(this.camera);
    const w = this.container.clientWidth, h = this.container.clientHeight;
    return out.set((out.x + 1) / 2 * w, (1 - out.y) / 2 * h, out.z);
  }

  /** The nearest edge within `slopPx` of the pointer that is not hidden behind a face, from these
   *  solids' edges (a solid being rounded gives the edges it had before the rounding shown). */
  pickEdge(clientX: number, clientY: number, slopPx: number, sources: EdgeSource[]): EdgeHit | null {
    const r = this.renderer.domElement.getBoundingClientRect();
    const mx = clientX - r.left, my = clientY - r.top;
    const a = new THREE.Vector3(), b = new THREE.Vector3(), sa = new THREE.Vector3(), sb = new THREE.Vector3();
    const near: { d: number; src: EdgeSource; index: number; at: THREE.Vector3 }[] = [];
    for (const src of sources) {
      for (let e = 0; e < edgeCount(src); e++) {
        const line = edgeLine(src, e);
        let best = Infinity, bestAt: THREE.Vector3 | null = null;
        for (let i = 0; i + 5 < line.length; i += 6) {
          a.set(line[i], line[i + 1], line[i + 2]);
          b.set(line[i + 3], line[i + 4], line[i + 5]);
          this.toScreen(a, sa);
          this.toScreen(b, sb);
          if (sa.z > 1 || sb.z > 1) continue;
          const dx = sb.x - sa.x, dy = sb.y - sa.y, len2 = dx * dx + dy * dy;
          const t = len2 ? Math.max(0, Math.min(1, ((mx - sa.x) * dx + (my - sa.y) * dy) / len2)) : 0;
          const d = Math.hypot(sa.x + t * dx - mx, sa.y + t * dy - my);
          if (d < best) { best = d; bestAt = a.clone().lerp(b, t); }
        }
        if (bestAt && best <= slopPx) near.push({ d: best, src, index: e, at: bestAt });
      }
    }
    near.sort((x, y) => x.d - y.d);
    // Not behind a face: nothing solid lies between the camera and the edge.
    const solids = this.pickables.filter(o => o.userData.solid);
    const eps = Math.max(0.5, 1.5 / this.pxPerMm());
    for (const c of near) {
      const screen = this.toScreen(c.at, new THREE.Vector3());
      const ray = this.rayAt(r.left + screen.x, r.top + screen.y);
      const depth = c.at.clone().sub(ray.origin).dot(ray.direction);
      const first = this.raycaster.intersectObjects(solids, false)[0];
      if (first && first.distance < depth - eps) continue;
      const line = edgeLine(c.src, c.index);
      return { solidId: c.src.solidId, index: c.index, point: edgeRefPoint(line), line };
    }
    return null;
  }

  /** The edges (by their index in its source) around the face under the pointer, of the solids given. */
  faceEdgesAt(clientX: number, clientY: number, sources: EdgeSource[]): { solidId: string; edges: number[] } | null {
    this.rayAt(clientX, clientY);
    const solids = this.pickables.filter(o => o.userData.solid && sources.some(src => src.solidId === (o.userData.solid as SolidMesh).solidId));
    const hit = this.raycaster.intersectObjects(solids, false)[0];
    if (!hit) return null;
    const solid = hit.object.userData.solid as SolidMesh;
    const src = sources.find(x => x.solidId === solid.solidId)!;
    const face = faceOfTriangle(solid, hit.faceIndex ?? 0);
    return { solidId: solid.solidId, edges: edgesOfFace({ ...solid, edges: src.edges, edgeRuns: src.edgeRuns }, face) };
  }

  private solidHit(solid: SolidMesh, hit: THREE.Intersection): SolidHit {
    const at = (hit.faceIndex ?? 0) * 3;
    let start = 0, count = solid.indices.length;
    for (let r = 0; r < solid.faceRuns.length; r += 2) {
      if (at >= solid.faceRuns[r] && at < solid.faceRuns[r] + solid.faceRuns[r + 1]) { start = solid.faceRuns[r]; count = solid.faceRuns[r + 1]; break; }
    }
    const nrm = (k: number) => new THREE.Vector3(solid.normals[3 * k], solid.normals[3 * k + 1], solid.normals[3 * k + 2]);
    const n0 = nrm(solid.indices[start]);
    let planar = true;
    for (let i = start; i < start + count && planar; i++) planar = nrm(solid.indices[i]).dot(n0) > 0.99999;
    const n = planar ? n0.normalize() : (hit.face?.normal ?? n0).clone().normalize();
    return {
      solidId: solid.solidId, featureIds: solid.featureIds, pullIds: solid.pullIds,
      point: [hit.point.x, hit.point.y, hit.point.z], normal: [n.x, n.y, n.z], planar,
    };
  }

  /** How far along its plane's normal the pointer is from a shape (for Pull), or null when looking straight down the normal. */
  pullDistanceAt(clientX: number, clientY: number, shape: SketchShape): number | null {
    const ray = this.rayAt(clientX, clientY);
    const outline = shapeOutline(shape, 8);
    const c = outline.reduce((a, p) => ({ x: a.x + p.x / outline.length, y: a.y + p.y / outline.length }), { x: 0, y: 0 });
    const p0 = v3(toWorld(shape.plane, c));
    const n = v3(frameOf(shape.plane).normal);
    const d = ray.direction;
    const b = n.dot(d);
    const denom = 1 - b * b;
    if (denom < 1e-3) return null;
    const w0 = p0.clone().sub(ray.origin);
    return (b * d.dot(w0) - n.dot(w0)) / denom;
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  setWorkPlane(plane: SketchPlane): void {
    this.workPlane = plane;
    this.rebuildGrid();
    this.requestRender();
  }

  private lastContent: SceneContent | null = null;

  setContent(c: SceneContent): void {
    this.lastContent = c;
    this.clear(this.content);
    this.pickables = [];
    this.units = c.doc.units;
    this.addReferences(c.doc.refs, c.refImages, c.selectedRefId ?? null);
    const used = usedShapeIds(c.doc);
    const t = this.theme;
    const pieces = new Map<string, { piece: RecipePiece; cut: boolean }>();
    for (const planned of c.plan.solids) {
      const cutting = cuttingPulls(planned.recipe);
      for (const piece of recipePieces(planned.recipe)) pieces.set(piece.fid, { piece, cut: cutting.has(piece.fid) });
    }

    for (const s of c.doc.shapes) {
      if (used.has(s.id)) continue;
      const selected = s.id === c.selectedShapeId;
      const line = this.outlineLine(s, selected ? t.selected : t.line);
      line.userData.shapeId = s.id;
      this.content.add(line);
      this.pickables.push(line);
      if (s.type === 'circle' || s.closed) {
        const fill = new THREE.Mesh(new THREE.ShapeGeometry(threeShape(s), 24), new THREE.MeshBasicMaterial({
          color: selected ? t.selected : t.preview, transparent: true, opacity: selected ? 0.22 : 0.08, side: THREE.DoubleSide, depthWrite: false,
        }));
        fill.applyMatrix4(planeMatrix(s.plane));
        fill.userData.shapeId = s.id;
        this.content.add(fill);
        this.pickables.push(fill);
      }
      if (c.showDims) this.addDims(s);
    }

    for (const solid of c.solids) {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(solid.positions, 3));
      g.setAttribute('normal', new THREE.BufferAttribute(solid.normals, 3));
      g.setIndex(new THREE.BufferAttribute(solid.indices, 1));
      const selected = (!!c.selectedFeatureId && solid.featureIds.includes(c.selectedFeatureId)) || solid.solidId === c.activeSolidId;
      const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
        color: t.solid, emissive: selected ? t.selected : 0x000000, emissiveIntensity: selected ? 0.18 : 0,
        roughness: 0.85, metalness: 0, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      }));
      mesh.userData.featureIds = solid.featureIds;
      mesh.userData.solid = solid;
      mesh.renderOrder = -2;
      this.content.add(mesh);
      this.pickables.push(mesh);
      const eg = new THREE.BufferGeometry();
      eg.setAttribute('position', new THREE.BufferAttribute(solid.edges, 3));
      const edges = new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: t.edge }));
      edges.userData.featureIds = solid.featureIds;
      edges.renderOrder = -2;
      this.content.add(edges);
      if (c.showDims) {
        for (const id of solid.featureIds) {
          const entry = pieces.get(id);
          if (entry) this.addPieceDims(entry.piece, entry.cut);
        }
      }
    }
    // The selected step's outline (and path), drawn over the solid so it is clear which part is picked.
    const picked = c.selectedFeatureId ? pieces.get(c.selectedFeatureId)?.piece : undefined;
    if (picked) {
      const lines = picked.op === 'pull'
        ? [this.outlineLine(picked.shape, t.selected), this.outlineLine(picked.shape, t.selected, picked.distance)]
        : picked.op === 'run'
          ? [this.outlineLine(picked.shape, t.selected), this.outlineLine(picked.path, t.selected)]
          : [this.outlineLine(picked.shape, t.selected)];
      for (const line of lines) {
        (line.material as THREE.LineBasicMaterial).depthTest = false;
        line.renderOrder = 2;
        this.content.add(line);
      }
    }
    this.requestRender();
  }

  // Each picture's texture, made once and kept while the picture is in use.
  private textures = new Map<HTMLCanvasElement, THREE.CanvasTexture>();

  /** Reference photos: see-through pictures on their planes, behind the grid, the drawing and the solids. */
  private addReferences(refs: ReferencePhoto[], images: Map<string, ReferenceImage> | undefined, selectedId: string | null): void {
    const inUse = new Set<HTMLCanvasElement>();
    for (const r of refs) {
      const img = images?.get(r.fileId);
      if (r.hidden || !img) continue;
      inUse.add(img.canvas);
      let tex = this.textures.get(img.canvas);
      if (!tex) {
        tex = new THREE.CanvasTexture(img.canvas);
        tex.colorSpace = THREE.SRGBColorSpace;
        tex.anisotropy = 4;
        this.textures.set(img.canvas, tex);
      }
      const geo = new THREE.PlaneGeometry(r.width, r.width * r.aspect);
      const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({
        map: tex, transparent: true, opacity: r.opacity, depthWrite: false, side: THREE.DoubleSide, toneMapped: false,
      }));
      mesh.userData.sharedTexture = true;
      mesh.applyMatrix4(new THREE.Matrix4().makeRotationZ((r.rotation * Math.PI) / 180).setPosition(r.center.x, r.center.y, 0));
      mesh.applyMatrix4(planeMatrix(r.plane));
      mesh.renderOrder = -5;
      mesh.userData.refId = r.id;
      this.content.add(mesh);
      this.pickables.push(mesh);
      if (r.id === selectedId) {
        const corners = referenceCorners(r);
        const outline = new THREE.Line(new THREE.BufferGeometry().setFromPoints([...corners, corners[0]].map(p => v3(toWorld(r.plane, p)))),
          new THREE.LineBasicMaterial({ color: this.theme.selected, depthTest: false }));
        outline.renderOrder = 2;
        this.content.add(outline);
      }
    }
    for (const [canvas, tex] of this.textures) {
      if (!inUse.has(canvas)) { tex.dispose(); this.textures.delete(canvas); }
    }
  }

  /** The measurements of one piece of a solid: its profile, and how far it was pulled, spun or run. */
  private addPieceDims(piece: RecipePiece, cut: boolean): void {
    this.addDims(piece.shape);
    if (piece.op === 'pull') {
      this.addPullDim(piece.shape, piece.distance, this.content, cut);
    } else if (piece.op === 'spin') {
      const obj = new CSS2DObject(labelEl(`⟳ ${Math.round(piece.angle * 10) / 10}°`, 'pull'));
      obj.position.copy(v3(piece.origin).addScaledVector(v3(piece.direction), 0.5));
      this.content.add(obj);
    } else {
      this.addDims(piece.path);
    }
  }

  setPreview(p: ScenePreview): void {
    this.clear(this.preview);
    const t = this.theme;
    if (p.shape) {
      const line = this.outlineLine(p.shape, t.preview);
      this.preview.add(line);
      // The line being drawn has its length in the readout already.
      this.addDims(p.shape, this.preview, !!p.angle);
    }
    for (const o of this.content.children) o.visible = true;
    if (p.pull) {
      const depth = Math.abs(p.pull.distance);
      if (depth > 1e-6) {
        const geo = new THREE.ExtrudeGeometry(threeShape(p.pull.shape), { depth, bevelEnabled: false, curveSegments: 24 });
        if (p.pull.distance < 0) geo.translate(0, 0, -depth);
        // A cut shows through the solid it cuts into.
        const ghost = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({
          color: p.pull.cut ? CUT_COLOR : t.preview, transparent: true, opacity: p.pull.cut ? 0.35 : 0.45,
          side: THREE.DoubleSide, depthWrite: false, depthTest: !p.pull.cut,
        }));
        ghost.applyMatrix4(planeMatrix(p.pull.shape.plane));
        ghost.renderOrder = 3;
        this.preview.add(ghost);
      }
      this.addPullDim(p.pull.shape, p.pull.distance, this.preview, p.pull.cut);
      // Hide a solid being re-pulled while its ghost stands in for it (only
      // when it is that pull alone: a solid with parts joined or cut stays).
      for (const o of this.content.children) {
        const ids = o.userData.featureIds as string[] | undefined;
        if (ids && ids.length === 1 && ids[0] === p.pull.replacesFeatureId) o.visible = false;
      }
    }
    if (p.snap) {
      const el = document.createElement('div');
      el.className = `sketch-snap sketch-snap-${p.snap.kind}`;
      const obj = new CSS2DObject(el);
      obj.position.copy(v3(toWorld(p.snap.plane, p.snap.p)));
      this.preview.add(obj);
      for (const g of p.snap.guides ?? []) this.preview.add(this.dashed([g, p.snap.p], p.snap.plane, GUIDE_COLOR));
    }
    if (p.angle) this.addAngle(p.angle);
    if (p.spin) this.addSpinPreview(p.spin);
    if (p.ghost) {
      const src = this.content.children.find(o => (o.userData.solid as SolidMesh | undefined)?.solidId === p.ghost!.solidId) as THREE.Mesh | undefined;
      for (const m of src ? p.ghost.matrices : []) {
        const ghost = new THREE.Mesh(src!.geometry, new THREE.MeshStandardMaterial({
          color: t.preview, transparent: true, opacity: 0.4, side: THREE.DoubleSide, depthWrite: false,
        }));
        ghost.userData.sharedGeometry = true; // the solid's own: not disposed with the preview
        ghost.applyMatrix4(new THREE.Matrix4().fromArray(m));
        ghost.renderOrder = 3;
        this.preview.add(ghost);
      }
    }
    if (p.line) {
      const { a, b } = p.line;
      const len = Math.hypot(b.x - a.x, b.y - a.y);
      if (len > 1e-6) {
        const k = p.line.extend ? Math.max(len, 3000 / Math.max(this.pxPerMm(), 1e-6) / 10) : 0;
        const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len };
        const from = { x: a.x - u.x * k, y: a.y - u.y * k }, to = { x: b.x + u.x * k, y: b.y + u.y * k };
        this.preview.add(this.dashed([from, to], p.line.plane, t.preview));
      }
    }
    if (p.edges) {
      const w = this.container.clientWidth, h = this.container.clientHeight;
      const fat = (lines: Float32Array[], color: number, width: number) => {
        const all = new Float32Array(lines.reduce((n, l) => n + l.length, 0));
        let at = 0;
        for (const l of lines) { all.set(l, at); at += l.length; }
        if (!all.length) return;
        const g = new LineSegmentsGeometry().setPositions(all);
        const m = new LineMaterial({ color, linewidth: width, depthTest: true });
        m.resolution.set(w, h);
        const obj = new LineSegments2(g, m);
        obj.renderOrder = 3;
        this.preview.add(obj);
      };
      if (p.edges.hover) fat([p.edges.hover], t.preview, 3);
      fat(p.edges.picked, t.selected, 4);
    }
    if (p.readout) {
      const obj = new CSS2DObject(labelEl(p.readout.text, 'readout'));
      obj.position.copy(v3(p.readout.at));
      obj.center.set(-0.15, this.readoutLift);
      this.preview.add(obj);
    }
    this.requestRender();
  }

  /** A picture of the current view, for a thumbnail. */
  snapshot(): string {
    this.renderNow();
    return this.renderer.domElement.toDataURL('image/png');
  }

  /**
   * A picture of the view as it is now, `scale` times the size on screen:
   * on white paper (drawn in the light colours, without the grid) or as on
   * screen, with the dimension labels drawn in when asked. Nothing being
   * drawn or previewed is included.
   */
  async exportPng(opts: { scale: number; paper: boolean; labels: boolean }): Promise<Blob> {
    const content = this.lastContent;
    const dark = this.theme === DARK;
    const ratio = this.renderer.getPixelRatio();
    const lightNow = opts.paper && dark;
    try {
      if (lightNow && content) { this.theme = LIGHT; this.setContent({ ...content, selectedShapeId: null, selectedFeatureId: null, selectedRefId: null, activeSolidId: null }); }
      else if (content) this.setContent({ ...content, selectedShapeId: null, selectedFeatureId: null, selectedRefId: null, activeSolidId: null });
      this.preview.visible = false;
      this.grid.visible = !opts.paper;
      this.renderer.setClearColor(opts.paper ? 0xffffff : this.theme.background, 1);
      this.renderer.setPixelRatio(opts.scale);
      this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
      this.renderer.render(this.scene, this.camera);
      const gl = this.renderer.domElement;
      const out = document.createElement('canvas');
      out.width = gl.width;
      out.height = gl.height;
      const ctx = out.getContext('2d')!;
      ctx.drawImage(gl, 0, 0);
      if (opts.labels) this.drawLabels(ctx, opts.scale, opts.paper || !dark);
      return await new Promise<Blob>((resolve, reject) => out.toBlob(b => (b ? resolve(b) : reject(new Error('The picture could not be made.'))), 'image/png'));
    } finally {
      this.renderer.setPixelRatio(ratio);
      this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
      this.preview.visible = true;
      this.grid.visible = true;
      if (lightNow) this.theme = DARK;
      this.applyTheme();
      if (content) this.setContent(content);
    }
  }

  /** The dimension labels, drawn onto a picture where they sit on screen. */
  private drawLabels(ctx: CanvasRenderingContext2D, scale: number, light: boolean): void {
    const w = ctx.canvas.width, h = ctx.canvas.height;
    const v = new THREE.Vector3();
    this.content.traverse(o => {
      if (!(o instanceof CSS2DObject) || !o.visible) return;
      const el = o.element;
      const text = el.textContent ?? '';
      if (!text) return;
      v.setFromMatrixPosition(o.matrixWorld).project(this.camera);
      if (v.z < -1 || v.z > 1) return;
      const x = (v.x + 1) / 2 * w, y = (1 - v.y) / 2 * h;
      const cls = el.className;
      const pull = cls.includes('sketch-label-pull'), cut = cls.includes('sketch-label-cut');
      const fg = pull || cut ? '#ffffff' : light ? '#0f172a' : '#e2e8f0';
      const bg = pull ? '#c026d3' : cut ? '#dc2626' : light ? 'rgba(255,255,255,0.88)' : 'rgba(30,41,59,0.88)';
      const border = pull || cut ? null : light ? '#cbd5e1' : '#334155';
      ctx.font = `600 ${11 * scale}px Inter, system-ui, sans-serif`;
      const tw = ctx.measureText(text).width, padX = 4 * scale, padY = 2 * scale, th = 13 * scale;
      const bx = x - tw / 2 - padX, by = y - th / 2 - padY / 2, bw = tw + 2 * padX, bh = th + padY;
      ctx.beginPath();
      ctx.roundRect(bx, by, bw, bh, 4 * scale);
      ctx.fillStyle = bg;
      ctx.fill();
      if (border) { ctx.lineWidth = scale; ctx.strokeStyle = border; ctx.stroke(); }
      ctx.fillStyle = fg;
      ctx.textBaseline = 'middle';
      ctx.fillText(text, x - tw / 2, y + scale * 0.5);
    });
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  /** A shape's outline, or (with `lift`) the same outline that far along its plane's normal. */
  private outlineLine(s: SketchShape, color: number, lift = 0): THREE.Line {
    const n = v3(frameOf(s.plane).normal).multiplyScalar(lift);
    const pts = shapeOutline(s, 32).map(p => v3(toWorld(s.plane, p)).add(n));
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    return new THREE.Line(g, new THREE.LineBasicMaterial({ color }));
  }

  /** A dashed line through sketch-plane points, dashes about 6 px long whatever the zoom. */
  private dashed(pts: Vec2[], plane: SketchPlane, color: number): THREE.Line {
    const px = this.pxPerMm();
    const g = new THREE.BufferGeometry().setFromPoints(pts.map(p => v3(toWorld(plane, p))));
    const line = new THREE.Line(g, new THREE.LineDashedMaterial({ color, dashSize: 6 / px, gapSize: 4 / px, depthTest: false }));
    line.computeLineDistances();
    line.renderOrder = 4;
    return line;
  }

  /** A spin being set up: the axis (dashed, running on past both points) and
   *  the shape's outline turned round it in steps, as a see-through ghost. */
  private addSpinPreview(sp: NonNullable<ScenePreview['spin']>): void {
    const { shape, axis: [a, b] } = sp;
    if (!b || Math.hypot(b.x - a.x, b.y - a.y) < 1e-6) return;
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy);
    const reach = Math.max(len, ...shapeOutline(shape, 8).map(p => Math.hypot(p.x - a.x, p.y - a.y))) * 1.3;
    const ext = (k: number): Vec2 => ({ x: a.x + (dx / len) * k, y: a.y + (dy / len) * k });
    this.preview.add(this.dashed([ext(-reach * 0.3), ext(reach)], shape.plane, this.theme.preview));
    const origin = v3(toWorld(shape.plane, a));
    const dir = v3(toWorld(shape.plane, b)).sub(origin).normalize();
    const angle = Math.max(-360, Math.min(360, sp.angle));
    const steps = Math.max(2, Math.round(Math.abs(angle) / 15));
    const outline = shapeOutline(shape, 24).map(p => v3(toWorld(shape.plane, p)).sub(origin));
    const rot = new THREE.Matrix4();
    for (let i = 1; i <= steps; i++) {
      rot.makeRotationAxis(dir, (angle * Math.PI / 180) * (i / steps));
      const pts = outline.map(p => p.clone().applyMatrix4(rot).add(origin));
      const g = new THREE.BufferGeometry().setFromPoints(pts);
      const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: this.theme.preview, transparent: true, opacity: i === steps ? 0.9 : 0.35, depthTest: false }));
      line.renderOrder = 3;
      this.preview.add(line);
    }
  }

  /** The angle of the line being drawn: a dashed level line and an arc from it, labelled. */
  private addAngle(a: NonNullable<ScenePreview['angle']>): void {
    const r = 44 / this.pxPerMm();
    const rad = (d: number) => (d * Math.PI) / 180;
    const at = (deg: number, dist: number): Vec2 => ({ x: a.at.x + dist * Math.cos(rad(deg)), y: a.at.y + dist * Math.sin(rad(deg)) });
    this.preview.add(this.dashed([a.at, at(a.levelDeg, r * 1.6)], a.plane, this.theme.preview));
    let sweep = ((a.dirDeg - a.levelDeg) % 360 + 540) % 360 - 180; // the short way round, −180 to 180
    if (Math.abs(sweep) < 0.5) sweep = 0;
    if (sweep !== 0) {
      const steps = Math.max(4, Math.ceil(Math.abs(sweep) / 4));
      const pts = Array.from({ length: steps + 1 }, (_, i) => at(a.levelDeg + (sweep * i) / steps, r));
      const g = new THREE.BufferGeometry().setFromPoints(pts.map(p => v3(toWorld(a.plane, p))));
      const arc = new THREE.Line(g, new THREE.LineBasicMaterial({ color: this.theme.preview, depthTest: false }));
      arc.renderOrder = 4;
      this.preview.add(arc);
    }
    const label = new CSS2DObject(labelEl(a.text, 'angle'));
    label.position.copy(v3(toWorld(a.plane, at(a.levelDeg + sweep / 2, r * 1.45))));
    this.preview.add(label);
  }

  /** Lengths of a shape's straight segments, arc radii and a circle's diameter (all but the last segment's, with `skipLast`). */
  private addDims(s: SketchShape, into: THREE.Group = this.content, skipLast = false): void {
    const add = (p: Vec2, text: string) => {
      const obj = new CSS2DObject(labelEl(text, 'dim'));
      obj.position.copy(v3(toWorld(s.plane, p)));
      into.add(obj);
    };
    if (s.type === 'circle') {
      add({ x: s.center.x, y: s.center.y }, `Ø ${formatLength(s.radius * 2, this.units)}`);
      return;
    }
    let prev = s.start;
    const segments = skipLast ? s.segments.slice(0, -1) : s.segments;
    for (const seg of segments) {
      if (seg.kind === 'line') {
        const len = Math.hypot(seg.to.x - prev.x, seg.to.y - prev.y);
        if (len > 1e-6) add({ x: (prev.x + seg.to.x) / 2, y: (prev.y + seg.to.y) / 2 }, formatLength(len, this.units));
      } else {
        const c = circleThrough(prev, seg.through, seg.to);
        const mid = arcPoints(prev, seg.through, seg.to, 2)[0];
        if (c) add(mid, `R ${formatLength(c.radius, this.units)}`);
      }
      prev = seg.to;
    }
  }

  private addPullDim(s: SketchShape, distance: number, into: THREE.Group = this.content, cut = false): void {
    const outline = shapeOutline(s, 8);
    const a = outline[0];
    const n = v3(frameOf(s.plane).normal);
    const pos = v3(toWorld(s.plane, a)).addScaledVector(n, distance / 2);
    const obj = new CSS2DObject(labelEl(`${cut ? 'Cut' : '↕'} ${formatLength(Math.abs(distance), this.units)}`, cut ? 'cut' : 'pull'));
    obj.position.copy(pos);
    into.add(obj);
  }

  private rebuildGrid(): void {
    this.clear(this.grid);
    const t = this.theme;
    const plane = this.workPlane;
    const pxPerMm = this.pxPerMm();
    const step = gridStep(this.units, pxPerMm);
    const major = majorEvery(this.units, step);
    // Cover what the camera can see of the plane around the target (further in perspective, toward the horizon).
    const halfView = this.visibleHeight() * Math.max(this.aspect(), 1) * (this.camera === this.persp ? 2.5 : 1.2);
    const f = frameOf(plane);
    const rel = this.controls.target.clone().sub(v3(f.origin));
    const cx = rel.dot(v3(f.xDir)), cy = rel.dot(v3(f.yDir));
    const n0x = Math.floor((cx - halfView) / step), n1x = Math.ceil((cx + halfView) / step);
    const n0y = Math.floor((cy - halfView) / step), n1y = Math.ceil((cy + halfView) / step);
    if ((n1x - n0x) + (n1y - n0y) > 2000) return;
    const minor: number[] = [], majorPts: number[] = [], axisX: number[] = [], axisY: number[] = [];
    // In perspective the camera sits close to the grid, and a line running behind
    // it is not drawn at all, so each line is cut back to the part in front of it.
    const persp = this.camera === this.persp;
    const eye = this.camera.position, look = this.camera.getWorldDirection(new THREE.Vector3());
    const minDepth = this.persp.near * 2;
    const depth = (p: Vec3) => (p[0] - eye.x) * look.x + (p[1] - eye.y) * look.y + (p[2] - eye.z) * look.z - minDepth;
    const push = (arr: number[], a: Vec2, b: Vec2) => {
      let pa = toWorld(plane, a), pb = toWorld(plane, b);
      if (persp) {
        const da = depth(pa), db = depth(pb);
        if (da <= 0 && db <= 0) return;
        const cut = (from: Vec3, to: Vec3, df: number, dt: number): Vec3 => {
          const t = df / (df - dt);
          return [from[0] + (to[0] - from[0]) * t, from[1] + (to[1] - from[1]) * t, from[2] + (to[2] - from[2]) * t];
        };
        if (da < 0) pa = cut(pb, pa, db, da);
        else if (db < 0) pb = cut(pa, pb, da, db);
      }
      arr.push(...pa, ...pb);
    };
    for (let i = n0x; i <= n1x; i++) {
      const x = i * step;
      push(i === 0 ? axisY : i % major === 0 ? majorPts : minor, { x, y: n0y * step }, { x, y: n1y * step });
    }
    for (let j = n0y; j <= n1y; j++) {
      const y = j * step;
      push(j === 0 ? axisX : j % major === 0 ? majorPts : minor, { x: n0x * step, y }, { x: n1x * step, y });
    }
    // Looking straight at the work plane, the grid is drawn after the solids so
    // it shows on a face being drawn on (and is still hidden behind solids in
    // front of the plane); at an angle it stays behind every solid.
    const gridOrder = this.facesPlane(plane) ? -1 : -3;
    const seg = (arr: number[], color: number, opacity = 1) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      const m = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: false }));
      m.renderOrder = gridOrder;
      this.grid.add(m);
    };
    seg(minor, t.gridMinor);
    seg(majorPts, t.gridMajor);
    // The plane's own axes in their usual colours: x red, y (or z) green.
    seg(axisX, 0xef4444, 0.7);
    seg(axisY, plane === 'ground' ? 0x22c55e : 0x3b82f6, 0.7);
  }

  private applyTheme(): void {
    this.renderer.setClearColor(this.theme.background, 1);
    this.rebuildGrid();
    this.requestRender();
  }

  private clear(g: THREE.Group): void {
    for (const o of [...g.children]) {
      g.remove(o);
      o.traverse(c => {
        const m = c as THREE.Mesh;
        if (!c.userData.sharedGeometry) m.geometry?.dispose?.();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        // A reference photo's texture is kept (see addReferences); only its material goes.
        if (Array.isArray(mat)) mat.forEach(x => x.dispose()); else mat?.dispose?.();
        if (c instanceof CSS2DObject) c.element.remove();
      });
    }
  }

  requestRender(): void {
    if (this.renderQueued) return;
    this.renderQueued = true;
    requestAnimationFrame(() => {
      this.renderQueued = false;
      this.renderNow();
    });
  }

  private renderNow(): void {
    this.renderer.render(this.scene, this.camera);
    this.labels.render(this.scene, this.camera);
  }
}
