// src/pages/sketch/sketchScene.ts
// The sketch editor's 3D view (three.js): an orthographic camera looking from
// Top, Front, Side or a 3D angle; the grid on the work plane; the sketch's
// shapes and solids; dimension labels; and the in-progress preview. World
// units are millimetres with z up, as in the sketch file and OpenCascade.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import {
  PLANES, arcPoints, circleThrough, formatLength, pulledShapeIds, shapeOutline, toWorld,
  type PlaneId, type SketchDoc, type SketchShape, type SketchUnits, type Vec2, type Vec3,
} from './sketchModel';
import { gridStep, majorEvery, type SnapKind } from './sketchSnap';
import type { SolidMesh } from './geometryTypes';

export type ViewName = 'top' | 'front' | 'side' | 'iso';
export const VIEW_FOR_PLANE: Record<PlaneId, ViewName> = { ground: 'top', front: 'front', side: 'side' };

// Camera direction (from the target) and screen-up for each view. Top looks
// straight down with y up the screen; Front looks along +y; Side along −x;
// the 3D view from the front-right, above.
const VIEWS: Record<ViewName, { dir: Vec3; up: Vec3 }> = {
  top: { dir: [0, 0, 1], up: [0, 1, 0] },
  front: { dir: [0, -1, 0], up: [0, 0, 1] },
  side: { dir: [1, 0, 0], up: [0, 0, 1] },
  iso: { dir: [1, -1.2, 0.9], up: [0, 0, 1] },
};
const CAMERA_DISTANCE = 100_000;

export interface SceneContent {
  doc: SketchDoc;
  solids: SolidMesh[];
  selectedShapeId: string | null;
  selectedFeatureId: string | null;
  showDims: boolean;
}

export interface ScenePreview {
  shape: SketchShape | null;
  snap: { p: Vec2; plane: PlaneId; kind: SnapKind } | null;
  /** Live readout beside the pointer (e.g. the length being drawn). */
  readout: { at: Vec3; text: string } | null;
  /** A pull being dragged: the shape, how far, and the solid it replaces (if any). */
  pull: { shape: SketchShape; distance: number; replacesFeatureId?: string } | null;
}

export type Pick = { shapeId: string } | { featureId: string } | null;

interface Theme { background: number; line: number; selected: number; preview: number; gridMinor: number; gridMajor: number; solid: number; edge: number }
const LIGHT: Theme = { background: 0xf8fafc, line: 0x1e293b, selected: 0x2563eb, preview: 0xc026d3, gridMinor: 0xe2e8f0, gridMajor: 0xcbd5e1, solid: 0xe7e5e4, edge: 0x334155 };
const DARK: Theme = { background: 0x0f172a, line: 0xe2e8f0, selected: 0x60a5fa, preview: 0xe879f9, gridMinor: 0x1e293b, gridMajor: 0x334155, solid: 0xa8a29e, edge: 0x0f172a };

const v3 = (p: Vec3) => new THREE.Vector3(p[0], p[1], p[2]);

/** The matrix taking sketch-plane coordinates (x, y, along-normal) to the world. */
const planeMatrix = (plane: PlaneId): THREE.Matrix4 => {
  const f = PLANES[plane];
  return new THREE.Matrix4().makeBasis(v3(f.xDir), v3(f.yDir), v3(f.normal)).setPosition(v3(f.origin));
};

const threeShape = (s: SketchShape): THREE.Shape => {
  const pts = shapeOutline(s, 32);
  return new THREE.Shape(pts.map(p => new THREE.Vector2(p.x, p.y)));
};

const labelEl = (text: string, cls: 'dim' | 'readout' | 'pull'): HTMLDivElement => {
  const el = document.createElement('div');
  el.textContent = text;
  el.className = `sketch-label sketch-label-${cls}`;
  return el;
};

export class SketchScene {
  private renderer: THREE.WebGLRenderer;
  private labels: CSS2DRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera;
  private controls: OrbitControls;
  private grid = new THREE.Group();
  private content = new THREE.Group();
  private preview = new THREE.Group();
  private raycaster = new THREE.Raycaster();
  private theme: Theme;
  private frameHeight = 1200; // mm visible top to bottom at zoom 1
  private view: ViewName = 'iso';
  private workPlane: PlaneId | null = 'ground';
  private units: SketchUnits = 'imperial';
  private pickables: THREE.Object3D[] = [];
  private renderQueued = false;
  private resizeObserver: ResizeObserver;
  /** Called when the zoom or view changes, so the editor can re-snap to the new grid. */
  onCameraChange: (() => void) | null = null;

  constructor(private container: HTMLElement, opts: { dark: boolean }) {
    this.theme = opts.dark ? DARK : LIGHT;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.domElement.style.display = 'block';
    this.renderer.domElement.style.touchAction = 'none';
    container.appendChild(this.renderer.domElement);
    this.labels = new CSS2DRenderer();
    Object.assign(this.labels.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    container.appendChild(this.labels.domElement);

    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 1, CAMERA_DISTANCE * 3);
    this.camera.up.set(0, 0, 1);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.zoomToCursor = true;
    this.controls.addEventListener('change', () => { this.rebuildGrid(); this.requestRender(); this.onCameraChange?.(); });

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
    this.setView('iso');
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

  setView(view: ViewName): void {
    this.view = view;
    const { dir, up } = VIEWS[view];
    const d = v3(dir).normalize();
    this.camera.up.copy(v3(up));
    this.camera.position.copy(this.controls.target).addScaledVector(d, CAMERA_DISTANCE);
    this.camera.lookAt(this.controls.target);
    // OrbitControls fixes its orbit axis from camera.up when built; the 3D view
    // orbits around z, the flat views do not orbit at all.
    this.controls.enableRotate = view === 'iso';
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.rebuildGrid();
    this.requestRender();
  }

  /** How the pointer drives the view: drawing keeps one finger / the left
   *  button for the tool, otherwise it pans (flat views) or orbits (3D). */
  setNavigation(mode: 'draw' | 'navigate'): void {
    const orbit = this.view === 'iso';
    const leftAction = mode === 'draw' ? -1 : orbit ? THREE.MOUSE.ROTATE : THREE.MOUSE.PAN;
    this.controls.mouseButtons = { LEFT: leftAction as THREE.MOUSE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
    const oneTouch = mode === 'draw' ? -1 : orbit ? THREE.TOUCH.ROTATE : THREE.TOUCH.PAN;
    this.controls.touches = { ONE: oneTouch as THREE.TOUCH, TWO: THREE.TOUCH.DOLLY_PAN };
  }

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
    const inv = this.camera.matrixWorldInverse;
    this.camera.updateMatrixWorld();
    const local = corners.map(c => c.clone().applyMatrix4(inv));
    const w = Math.max(...local.map(c => c.x)) - Math.min(...local.map(c => c.x));
    const h = Math.max(...local.map(c => c.y)) - Math.min(...local.map(c => c.y));
    const aspect = this.aspect();
    const needed = Math.max(h, w / aspect, 1) * 1.35;
    this.camera.zoom = this.frameHeight / needed;
    this.camera.updateProjectionMatrix();
    this.controls.update();
    this.rebuildGrid();
    this.requestRender();
  }

  /** Screen pixels per world millimetre at the current zoom. */
  pxPerMm(): number {
    const h = this.container.clientHeight || 1;
    return (h * this.camera.zoom) / this.frameHeight;
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
    Object.assign(this.camera, { left: -half * a, right: half * a, top: half, bottom: -half });
    this.camera.updateProjectionMatrix();
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
  planePoint(clientX: number, clientY: number, plane: PlaneId): Vec2 | null {
    const ray = this.rayAt(clientX, clientY);
    const f = PLANES[plane];
    const hit = ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(v3(f.normal), v3(f.origin)), new THREE.Vector3());
    if (!hit) return null;
    const rel = hit.sub(v3(f.origin));
    return { x: rel.dot(v3(f.xDir)), y: rel.dot(v3(f.yDir)) };
  }

  /** The shape or solid under the pointer. */
  pick(clientX: number, clientY: number): Pick {
    this.rayAt(clientX, clientY);
    this.raycaster.params.Line = { threshold: 6 / this.pxPerMm() };
    const hits = this.raycaster.intersectObjects(this.pickables, false);
    // Lines and fills before solids at the same depth: a sketch drawn on a face stays pickable.
    const hit = hits.find(h => h.object.userData.shapeId) ?? hits[0];
    if (!hit) return null;
    const { shapeId, featureId } = hit.object.userData as { shapeId?: string; featureId?: string };
    if (featureId) return { featureId };
    if (shapeId) return { shapeId };
    return null;
  }

  /** How far along its plane's normal the pointer is from a shape (for Pull), or null when looking straight down the normal. */
  pullDistanceAt(clientX: number, clientY: number, shape: SketchShape): number | null {
    const ray = this.rayAt(clientX, clientY);
    const outline = shapeOutline(shape, 8);
    const c = outline.reduce((a, p) => ({ x: a.x + p.x / outline.length, y: a.y + p.y / outline.length }), { x: 0, y: 0 });
    const p0 = v3(toWorld(shape.plane, c));
    const n = v3(PLANES[shape.plane].normal);
    const d = ray.direction;
    const b = n.dot(d);
    const denom = 1 - b * b;
    if (denom < 1e-3) return null;
    const w0 = p0.clone().sub(ray.origin);
    return (b * d.dot(w0) - n.dot(w0)) / denom;
  }

  // ── Drawing ───────────────────────────────────────────────────────────────

  setWorkPlane(plane: PlaneId | null): void {
    this.workPlane = plane;
    this.rebuildGrid();
    this.requestRender();
  }

  setContent(c: SceneContent): void {
    this.clear(this.content);
    this.pickables = [];
    this.units = c.doc.units;
    const pulled = pulledShapeIds(c.doc);
    const t = this.theme;

    for (const s of c.doc.shapes) {
      if (pulled.has(s.id)) continue;
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
      const selected = solid.featureId === c.selectedFeatureId;
      const mesh = new THREE.Mesh(g, new THREE.MeshStandardMaterial({
        color: selected ? t.selected : t.solid, roughness: 0.85, metalness: 0,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
      }));
      mesh.userData.featureId = solid.featureId;
      this.content.add(mesh);
      this.pickables.push(mesh);
      const eg = new THREE.BufferGeometry();
      eg.setAttribute('position', new THREE.BufferAttribute(solid.edges, 3));
      this.content.add(new THREE.LineSegments(eg, new THREE.LineBasicMaterial({ color: selected ? t.selected : t.edge })));
      if (c.showDims) {
        const f = c.doc.features.find(ff => ff.id === solid.featureId);
        const shape = f && c.doc.shapes.find(s => s.id === f.shapeId);
        if (f && shape) {
          this.addDims(shape);
          this.addPullDim(shape, f.distance);
        }
      }
    }
    this.requestRender();
  }

  setPreview(p: ScenePreview): void {
    this.clear(this.preview);
    const t = this.theme;
    if (p.shape) {
      const line = this.outlineLine(p.shape, t.preview);
      this.preview.add(line);
      this.addDims(p.shape, this.preview);
    }
    if (p.pull) {
      const depth = Math.abs(p.pull.distance);
      if (depth > 1e-6) {
        const geo = new THREE.ExtrudeGeometry(threeShape(p.pull.shape), { depth, bevelEnabled: false, curveSegments: 24 });
        if (p.pull.distance < 0) geo.translate(0, 0, -depth);
        const ghost = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: t.preview, transparent: true, opacity: 0.45, side: THREE.DoubleSide, depthWrite: false }));
        ghost.applyMatrix4(planeMatrix(p.pull.shape.plane));
        this.preview.add(ghost);
      }
      this.addPullDim(p.pull.shape, p.pull.distance, this.preview);
      // Hide the solid being re-pulled while its ghost stands in for it.
      for (const o of this.content.children) {
        if (o.userData.featureId === p.pull.replacesFeatureId) o.visible = false;
      }
    } else {
      for (const o of this.content.children) o.visible = true;
    }
    if (p.snap) {
      const el = document.createElement('div');
      el.className = `sketch-snap sketch-snap-${p.snap.kind}`;
      const obj = new CSS2DObject(el);
      obj.position.copy(v3(toWorld(p.snap.plane, p.snap.p)));
      this.preview.add(obj);
    }
    if (p.readout) {
      const obj = new CSS2DObject(labelEl(p.readout.text, 'readout'));
      obj.position.copy(v3(p.readout.at));
      obj.center.set(-0.15, 1.4);
      this.preview.add(obj);
    }
    this.requestRender();
  }

  /** A picture of the current view, for a thumbnail. */
  snapshot(): string {
    this.renderNow();
    return this.renderer.domElement.toDataURL('image/png');
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private outlineLine(s: SketchShape, color: number): THREE.Line {
    const pts = shapeOutline(s, 32).map(p => v3(toWorld(s.plane, p)));
    const g = new THREE.BufferGeometry().setFromPoints(pts);
    return new THREE.Line(g, new THREE.LineBasicMaterial({ color }));
  }

  /** Lengths of a shape's straight segments, arc radii and a circle's diameter. */
  private addDims(s: SketchShape, into: THREE.Group = this.content): void {
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
    for (const seg of s.segments) {
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

  private addPullDim(s: SketchShape, distance: number, into: THREE.Group = this.content): void {
    const outline = shapeOutline(s, 8);
    const a = outline[0];
    const n = v3(PLANES[s.plane].normal);
    const pos = v3(toWorld(s.plane, a)).addScaledVector(n, distance / 2);
    const obj = new CSS2DObject(labelEl(`↕ ${formatLength(Math.abs(distance), this.units)}`, 'pull'));
    obj.position.copy(pos);
    into.add(obj);
  }

  private rebuildGrid(): void {
    this.clear(this.grid);
    const t = this.theme;
    const plane = this.workPlane ?? 'ground';
    const pxPerMm = this.pxPerMm();
    const step = gridStep(this.units, pxPerMm);
    const major = majorEvery(this.units, step);
    // Cover what the camera can see of the plane around the target.
    const halfView = (this.frameHeight / this.camera.zoom) * Math.max(this.aspect(), 1) * 1.2;
    const f = PLANES[plane];
    const rel = this.controls.target.clone().sub(v3(f.origin));
    const cx = rel.dot(v3(f.xDir)), cy = rel.dot(v3(f.yDir));
    const n0x = Math.floor((cx - halfView) / step), n1x = Math.ceil((cx + halfView) / step);
    const n0y = Math.floor((cy - halfView) / step), n1y = Math.ceil((cy + halfView) / step);
    if ((n1x - n0x) + (n1y - n0y) > 2000) return;
    const minor: number[] = [], majorPts: number[] = [], axisX: number[] = [], axisY: number[] = [];
    const push = (arr: number[], a: Vec2, b: Vec2) => arr.push(...toWorld(plane, a), ...toWorld(plane, b));
    for (let i = n0x; i <= n1x; i++) {
      const x = i * step;
      push(i === 0 ? axisY : i % major === 0 ? majorPts : minor, { x, y: n0y * step }, { x, y: n1y * step });
    }
    for (let j = n0y; j <= n1y; j++) {
      const y = j * step;
      push(j === 0 ? axisX : j % major === 0 ? majorPts : minor, { x: n0x * step, y }, { x: n1x * step, y });
    }
    const seg = (arr: number[], color: number, opacity = 1) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      const m = new THREE.LineSegments(g, new THREE.LineBasicMaterial({ color, transparent: opacity < 1, opacity, depthWrite: false }));
      m.renderOrder = -1;
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
        m.geometry?.dispose?.();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
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
