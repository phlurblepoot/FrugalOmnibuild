import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Stage, Layer, Image as KonvaImage, Line, Circle, Text, Group, Rect, Shape, Label, Tag } from 'react-konva';
import { Html } from 'react-konva-utils';
import { Trash2, Edit2, X, Check, ZoomIn, ZoomOut, RotateCcw, Maximize2 } from 'lucide-react';
import useImage from 'use-image';
import { v4 as uuidv4 } from 'uuid';
import type Konva from 'konva';
import { Point, Measurement, MeasurementSegment, Tool, ScaleConfig, MeasurementTakeoff, ScaleRegion } from '../types';
import { calculateDistance, calculatePolylineLength, measurementAreaPx, measurementRings, formatMeasurement, generateArcPoints, expandArcPoints, calculateSurfaceAreaPx, isPointInPolygon, calculateRealValue, convertUnit, formatRealValue, UNIT_LABELS } from '../utils/math';
import { segmentPixelQuantity, describeQuantity, segmentLabelText, labelAnchor, placeSegmentLabel, LABEL_FONT_SIZE, LABEL_PADDING } from '../utils/segmentValue';
import { measurementMultiplier, formatMultiplied } from '../utils/multiplier';
import type { TakeoffTotals } from '../pages/project/proposal/proposalGenerator';
import { createWorker } from 'tesseract.js';
import { useToast } from './Toast';
import { useTheme } from '../context/ThemeContext';
import { lerpStep, lerp1D, isCursorIdle } from '../utils/presence';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
// @ts-ignore
import pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { getCachedPdfDocument, getCachedPageBitmap, putCachedPageBitmap } from '../utils/pdfDocCache';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

// Records the render scale a cached bitmap was produced at, keyed the same
// way as pdfDocCache's bitmap cache (`${sourcePdfUrl}#${sourcePdfPageNum}`).
// A page flip that hits the bitmap cache needs this to seed `lastRenderScaleRef`
// correctly so the zoom re-render path doesn't mistake an already-current-zoom
// bitmap for a stale one. This is a PdfCanvas-local pairing (not part of the
// cache module's public contract), so it lives here rather than in
// pdfDocCache.ts.
const bitmapRenderScaleByKey = new Map<string, number>();

// ─────────────────────────────────────────────────────────────────────────
// Remote presence cursor (Task 12 — presentation only, no protocol change).
// Smoothed via a per-cursor rAF lerp loop: one independent loop per cursor
// rather than one shared scheduler, because a page's session list is small
// (a handful at most) so N cheap rAF callbacks cost nothing, and each cursor
// can start/stop its own loop purely from its own activity with no shared
// bookkeeping. Position and fade-opacity are both driven imperatively via
// Konva refs — never through React x/y/opacity props — so a parent
// re-render (e.g. the idle-fade state flip) can never stomp the in-flight
// lerped position with a stale prop value.
// ─────────────────────────────────────────────────────────────────────────

const CURSOR_IDLE_MS = 30_000;
const CURSOR_IDLE_OPACITY = 0.3;
const NAME_TAG_PAD_X = 8;
const NAME_TAG_HEIGHT = 20;

interface RemoteCursorProps {
  user: { id: string; name: string; color: string; cursor: { x: number; y: number }; lastActive?: number };
  stageScale: number;
  reducedMotion: boolean;
}

const RemoteCursor: React.FC<RemoteCursorProps> = React.memo(({ user, stageScale, reducedMotion }) => {
  const groupRef = useRef<Konva.Group>(null);
  const textRef = useRef<Konva.Text>(null);
  const posRef = useRef({ x: user.cursor.x, y: user.cursor.y });
  const opacityRef = useRef(isCursorIdle(user.lastActive, Date.now()) ? CURSOR_IDLE_OPACITY : 1);
  const rafRef = useRef<number | null>(null);
  // Always holds the latest target so a loop already in flight (started on
  // an earlier render) reads current values each frame instead of a stale
  // closure over the render that scheduled it.
  const latestRef = useRef({ x: user.cursor.x, y: user.cursor.y, opacity: 1 });

  const [tagWidth, setTagWidth] = useState(() => user.name.length * 7 + NAME_TAG_PAD_X * 2);
  const [isIdle, setIsIdle] = useState(() => isCursorIdle(user.lastActive, Date.now()));

  // Measure the actual glyph width so the pill fits the name exactly,
  // instead of the old `name.length * 7 + 8` guess.
  useLayoutEffect(() => {
    const w = textRef.current?.width();
    if (w) setTagWidth(w + NAME_TAG_PAD_X * 2);
  }, [user.name]);

  // Idle detection: `lastActive` only changes on an actual cursor-move
  // event, so noticing 30s of *silence* (no further prop updates at all)
  // needs a timer, not just a dependency check.
  useEffect(() => {
    const now = Date.now();
    setIsIdle(isCursorIdle(user.lastActive, now));
    const last = user.lastActive ?? now;
    const timer = setTimeout(() => setIsIdle(true), Math.max(0, last + CURSOR_IDLE_MS - now));
    return () => clearTimeout(timer);
  }, [user.lastActive]);

  const targetOpacity = isIdle ? CURSOR_IDLE_OPACITY : 1;
  latestRef.current = { x: user.cursor.x, y: user.cursor.y, opacity: targetOpacity };

  // reducedMotion: bind straight to the latest values, no easing, and stop
  // any in-flight lerp loop.
  useLayoutEffect(() => {
    if (!reducedMotion) return;
    if (rafRef.current != null) { cancelAnimationFrame(rafRef.current); rafRef.current = null; }
    posRef.current = { x: user.cursor.x, y: user.cursor.y };
    opacityRef.current = targetOpacity;
    groupRef.current?.position(posRef.current);
    groupRef.current?.opacity(targetOpacity);
    groupRef.current?.getLayer()?.batchDraw();
  }, [reducedMotion, user.cursor.x, user.cursor.y, targetOpacity]);

  // Smoothed motion: snap to whatever position/opacity has been reached so
  // far (avoids a flash back to a stale value on re-render), then (re)start
  // the rAF loop if it isn't already running. The loop stops itself once
  // both position and opacity have snapped to target — and restarts
  // automatically the next time this effect's deps change.
  useLayoutEffect(() => {
    if (reducedMotion) return;
    groupRef.current?.position(posRef.current);
    groupRef.current?.opacity(opacityRef.current);
    if (rafRef.current != null) return;
    const tick = () => {
      const nextPos = lerpStep(posRef.current, latestRef.current, 0.25, 0.5);
      const nextOpacity = lerp1D(opacityRef.current, latestRef.current.opacity, 0.25, 0.01);
      posRef.current = nextPos;
      opacityRef.current = nextOpacity;
      const g = groupRef.current;
      if (g) {
        g.position(nextPos);
        g.opacity(nextOpacity);
        g.getLayer()?.batchDraw();
      }
      const settled = nextPos.x === latestRef.current.x && nextPos.y === latestRef.current.y
        && nextOpacity === latestRef.current.opacity;
      rafRef.current = settled ? null : requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  }, [reducedMotion, user.cursor.x, user.cursor.y, targetOpacity]);

  useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
  }, []);

  return (
    <Group ref={groupRef} name="remote-cursor">
      <Line
        points={[0, 0, 10, 10, 4, 10, 0, 14]}
        closed
        fill={user.color}
        stroke="white"
        strokeWidth={1 / stageScale}
        scaleX={1 / stageScale}
        scaleY={1 / stageScale}
      />
      <Group y={16 / stageScale} scaleX={1 / stageScale} scaleY={1 / stageScale}>
        <Rect
          width={tagWidth}
          height={NAME_TAG_HEIGHT}
          cornerRadius={NAME_TAG_HEIGHT / 2}
          fill={user.color}
          opacity={0.85}
          shadowColor="black"
          shadowBlur={4}
          shadowOpacity={0.25}
          shadowOffsetY={1}
        />
        <Text
          ref={textRef}
          text={user.name}
          fontSize={10}
          fill="white"
          fontStyle="bold"
          x={NAME_TAG_PAD_X}
          y={(NAME_TAG_HEIGHT - 12) / 2}
        />
      </Group>
    </Group>
  );
});
RemoteCursor.displayName = 'RemoteCursor';

interface PdfCanvasProps {
  imageUrl: string;
  imageWidth: number;
  imageHeight: number;
  currentTool: Tool;
  scaleConfig: ScaleConfig | null;
  measurements: Measurement[];
  pageMeasurements?: Measurement[];
  takeoffs: MeasurementTakeoff[];
  /**
   * computeTakeoffTotals rows for `takeoffs`: what a selected segment's dollars
   * are prorated against (the Takeoffs tab's rule). Without a row the segment
   * label shows its quantity only.
   */
  takeoffCostTotals?: TakeoffTotals[];
  onAddMeasurement: (measurement: Measurement) => void;
  onUpdateMeasurement: (id: string, measurement: Partial<Measurement>) => void;
  onDeleteMeasurement: (id: string) => void;
  onSetScale: (pixelDistance: number) => void;
  selectedMeasurementId: string | null;
  selectedSegmentIdx?: number | null;
  onSelectMeasurement: (id: string | null) => void;
  onSelectSegment?: (id: string, segIdx: number) => void;
  onCancel?: () => void;
  isMultiRegion?: boolean;
  scaleRegions?: ScaleRegion[];
  selectedRegionId?: string | null;
  onSelectRegion?: (id: string | null) => void;
  onAddRegion?: (region: ScaleRegion) => void;
  onUpdateRegion?: (id: string, region: Partial<ScaleRegion>) => void;
  onDeleteRegion?: (id: string) => void;
  calibratingRegionId?: string | null;
  remoteUsers?: any[];
  onCursorMove?: (x: number, y: number) => void;
  currentUserId?: string;
  resumeMeasurement?: Measurement | null;
  resumeSegmentIdx?: number;
  onMeasurementResumed?: () => void;
  showLegend?: boolean;
  showLegendTotals?: boolean;
  legendPosition?: { x: number, y: number };
  legendScale?: number;
  legendScaleX?: number;
  legendScaleY?: number;
  legendFontSize?: number;
  legendWidth?: number;
  onUpdateLegend?: (updates: { position?: { x: number, y: number }, scale?: number, scaleX?: number, scaleY?: number, fontSize?: number, width?: number }) => void;
  searchTerm?: string;
  /**
   * Vector source for the page. When set, the canvas renders this PDF page
   * directly via pdf.js (crisp at every zoom) and uses its embedded text for
   * search. When omitted, the legacy `imageUrl` raster path is used.
   */
  sourcePdfUrl?: string;
  sourcePdfPageNum?: number;
  /**
   * Thumbnail image for this page, shown (stretched to imageWidth/Height, at
   * reduced opacity) as a placeholder while the source PDF is still
   * downloading/rendering — otherwise a vector page is blank white for
   * however long the source PDF takes to fetch (can be 60s+ on a slow LAN
   * for a large plan-set sheet).
   */
  thumbnailUrl?: string;
  /**
   * Other pages in the same project that this page can link to. Any text on
   * the current page whose string matches one of these page numbers becomes
   * a clickable hotspot in pan mode. Vector-only — legacy raster pages have
   * no text positions to detect references against.
   */
  linkablePages?: Array<{ pageId: string; pageNumber: string }>;
  onPageReferenceClick?: (pageId: string) => void;
  onUndo?: () => void;
  onRedo?: () => void;
  onCopy?: () => void;
  onPaste?: () => void;
  hasCopied?: boolean;
  multiSelectedIds?: Set<string>;
  onMultiSelectToggle?: (id: string, type: string) => void;
  onClearMultiSelect?: () => void;
  isMultiSelectMode?: boolean;
  /**
   * Frozen-history / phone read-only mode. When true, existing measurements are
   * fully non-editable: no dragging segments or vertices, no vertex insertion,
   * no delete/edit context menu, and the legend can't be moved. Pan / zoom /
   * select-to-view stay fully functional. Threaded from CanvasView's `readOnly`.
   */
  readOnly?: boolean;
  /**
   * Fires whenever the in-progress click-by-click drawing buffer transitions
   * between empty and non-empty (including mid-arc). CanvasView uses this to
   * gate live backfill/reload (Task 5) so a foreign refresh never clobbers an
   * unfinished shape the user is mid-draw on.
   */
  onDrawingActiveChange?: (active: boolean) => void;
}

export const PdfCanvas: React.FC<PdfCanvasProps> = ({
  imageUrl,
  imageWidth,
  imageHeight,
  currentTool,
  scaleConfig,
  measurements,
  pageMeasurements,
  takeoffs,
  takeoffCostTotals,
  onAddMeasurement,
  onUpdateMeasurement,
  onDeleteMeasurement,
  onSetScale,
  selectedMeasurementId,
  selectedSegmentIdx = null,
  onSelectMeasurement,
  onSelectSegment,
  onCancel,
  isMultiRegion = false,
  scaleRegions = [],
  selectedRegionId,
  onSelectRegion,
  onAddRegion,
  onUpdateRegion,
  onDeleteRegion,
  calibratingRegionId,
  remoteUsers = [],
  onCursorMove,
  currentUserId,
  resumeMeasurement,
  resumeSegmentIdx = -1,
  onMeasurementResumed,
  showLegend = false,
  showLegendTotals = true,
  legendPosition = { x: 20, y: 20 },
  legendScale = 2,
  legendScaleX,
  legendScaleY,
  legendFontSize = 24,
  legendWidth,
  onUpdateLegend,
  searchTerm,
  sourcePdfUrl,
  sourcePdfPageNum,
  thumbnailUrl,
  linkablePages,
  onPageReferenceClick,
  onUndo,
  onRedo,
  onCopy,
  onPaste,
  hasCopied,
  multiSelectedIds,
  onMultiSelectToggle,
  onClearMultiSelect,
  isMultiSelectMode = false,
  readOnly = false,
  onDrawingActiveChange,
}) => {
  const { toast } = useToast();
  const { reducedMotion } = useTheme();
  // The subtract (cutout) tool draws exactly like the area tool — same clicks,
  // arcs, preview and finalize gestures — it only differs in what finalizeSegment
  // does with the polygon. Sites that decide *drawing mechanics* test this;
  // sites that create or style a NEW measurement stay area-only.
  const isAreaLikeTool = currentTool === 'area' || currentTool === 'subtract';
  // `useImage` is the legacy raster path; new vector-source pages populate
  // `pdfImage` instead. `image` (used by the existing code below) resolves to
  // whichever one is current — that lets the Konva background, zoom-fit logic,
  // and search effect stay agnostic to the source.
  const [legacyImage] = useImage(imageUrl);
  const [pdfImage, setPdfImage] = useState<HTMLCanvasElement | null>(null);
  const image = pdfImage ?? legacyImage;
  // Placeholder shown in the KonvaImage slot while `pdfImage` is still
  // rendering — see `thumbnailUrl` prop doc.
  const [thumbImage] = useImage(thumbnailUrl || '');
  const [pdfLoadProgress, setPdfLoadProgress] = useState<{ loaded: number; total: number } | null>(null);
  // Bumped whenever `pdfPageRef.current` is (re)assigned. On a bitmap-cache
  // hit `pdfImage` is set instantly while the page proxy is still resolving
  // in the background — effects that read `pdfPageRef.current` (zoom
  // re-render, page-reference detection, search) key off `pdfImage`/other
  // state changes to know when to re-check, and would otherwise fire once,
  // find the ref still null, and never retry once it's actually populated.
  // Including this tick in their dependency arrays closes that gap.
  const [pdfPageReadyTick, setPdfPageReadyTick] = useState(0);

  // Vector PDF rendering pipeline. When `sourcePdfUrl` is set the page is
  // rendered on demand into an offscreen canvas at a resolution that tracks
  // the current stage zoom, then handed to Konva as the background image.
  const pdfProxyRef = useRef<any>(null);
  const pdfPageRef = useRef<any>(null);
  const lastRenderScaleRef = useRef<number>(0);
  const renderTaskRef = useRef<any>(null);
  const rerenderTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isRenderingRef = useRef(false);

  const stageRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  const [stageScale, setStageScale] = useState(1);
  const [stagePos, setStagePos] = useState({ x: 0, y: 0 });
  const stageScaleRef = useRef(1);
  const stagePosRef = useRef({ x: 0, y: 0 });

  useEffect(() => {
    stageScaleRef.current = stageScale;
  }, [stageScale]);

  useEffect(() => {
    stagePosRef.current = stagePos;
  }, [stagePos]);

  const [dimensions, setDimensions] = useState({ width: 0, height: 0 });
  
  const [activePoints, setActivePoints] = useState<Point[]>([]);
  const [mousePos, setMousePos] = useState<Point | null>(null);
  const [isMiddleMouseDown, setIsMiddleMouseDown] = useState(false);
  const isMiddleMouseDownRef = useRef(false);
  const lastMousePosRef = useRef<{x: number, y: number} | null>(null);

  // Cursor-move throttle: coalesce to one onCursorMove per animation frame,
  // and skip frames where the pointer barely moved (min-distance gate).
  // Without this, fast mouse movement floods the collab socket with a
  // cursor-move emit per native mousemove event. latestCursorPosRef is
  // updated on every mousemove (multiple can fire before a frame elapses),
  // so the rAF callback always reads the freshest position rather than
  // closing over whichever event happened to schedule the frame.
  const cursorRafRef = useRef<number | null>(null);
  const lastCursorRef = useRef<{ x: number; y: number } | null>(null);
  const latestCursorPosRef = useRef<{ x: number; y: number } | null>(null);
  useEffect(() => {
    return () => {
      if (cursorRafRef.current !== null) cancelAnimationFrame(cursorRafRef.current);
    };
  }, []);

  const [arcMode, setArcMode] = useState<'inactive' | 'waiting_mid' | 'waiting_end'>('inactive');
  const [arcMidPoint, setArcMidPoint] = useState<Point | null>(null);
  const [activeArcMidIndices, setActiveArcMidIndices] = useState<number[]>([]);
  
  const [draggingPoint, setDraggingPoint] = useState<{ mId: string, idx: number, x: number, y: number, segIdx?: number } | null>(null);
  // Live offset of a segment subgroup being dragged (segIdx -1 = primary).
  // Konva already translates the dragged subgroup's own children, so this is
  // only consumed by the compound punch-out Shape, which lives in the OUTER
  // group and would otherwise stay put until the drag commits.
  const [draggingSegment, setDraggingSegment] = useState<{ mId: string, segIdx: number, dx: number, dy: number } | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number; measurementId: string | null } | null>(null);

  const [resumeMeasurementId, setResumeMeasurementId] = useState<string | null>(null);
  // Which segment is being resumed: -1 = primary (m.points), 0+ = m.segments[i].
  const [resumingSegmentIdx, setResumingSegmentIdx] = useState<number>(-1);
  const [searchHighlights, setSearchHighlights] = useState<{x0: number, y0: number, x1: number, y1: number}[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  // Bounding boxes of text on this page that reference other pages in the
  // project — populated from the source PDF's text layer after the page
  // loads. Clicking one in pan mode navigates to that page.
  const [pageRefs, setPageRefs] = useState<Array<{ pageId: string; x: number; y: number; width: number; height: number }>>([]);
  const [hoveredRefIdx, setHoveredRefIdx] = useState<number | null>(null);

  const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

  useEffect(() => {
    if (resumeMeasurement) {
      setActivePoints(resumeMeasurement.points);
      setActiveArcMidIndices(resumeMeasurement.arcMidIndices || []);
      setResumeMeasurementId(resumeMeasurement.id);
      setResumingSegmentIdx(resumeSegmentIdx);
      setArcMode('inactive');
      setArcMidPoint(null);
      onMeasurementResumed?.();
    }
  }, [resumeMeasurement, resumeSegmentIdx, onMeasurementResumed]);

  // Single choke point for the mid-GESTURE signal (Task 5, widened in fix
  // round 1): covers not just new-shape drawing (activePoints/arcMode) but
  // every other in-flight interaction a foreign reload/backfill could
  // clobber mid-gesture — dragging an existing vertex (draggingPoint),
  // dragging a whole segment (draggingSegment), and having started a resume
  // of an existing measurement's drawing (resumeMeasurementId; note a fresh
  // blank measurement from confirmNewMeasurement starts with points: [], so
  // activePoints alone wouldn't catch that case — the resume id must be
  // checked independently, not folded into "activePoints.length > 0").
  useEffect(() => {
    onDrawingActiveChange?.(
      activePoints.length > 0 ||
      arcMode !== 'inactive' ||
      draggingPoint !== null ||
      draggingSegment !== null ||
      resumeMeasurementId !== null
    );
  }, [activePoints, arcMode, draggingPoint, draggingSegment, resumeMeasurementId, onDrawingActiveChange]);

  const lastDistRef = useRef<number>(0);
  const lastCenterRef = useRef<Point | null>(null);
  const zoomRafRef = useRef<number | null>(null);

  // Long-press → context menu (touch tablets). A timer armed on touchstart over
  // a measurement opens the existing context menu (delete/copy/paste) at the
  // touch point; any move or lift cancels it. Mirrors the desktop right-click.
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);
  const cancelLongPress = () => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
  };
  useEffect(() => () => cancelLongPress(), []);

  useEffect(() => {
    const updateDimensions = () => {
      if (containerRef.current) {
        setDimensions({
          width: containerRef.current.offsetWidth,
          height: containerRef.current.offsetHeight,
        });
      }
    };
    
    updateDimensions();
    
    const observer = new ResizeObserver(() => {
      updateDimensions();
    });
    
    if (containerRef.current) {
      observer.observe(containerRef.current);
    }
    
    return () => {
      observer.disconnect();
    };
  }, []);

  useEffect(() => {
    const handleGlobalMouseUp = (e: MouseEvent) => {
      if (e.button === 1) {
        setIsMiddleMouseDown(false);
        isMiddleMouseDownRef.current = false;
        lastMousePosRef.current = null;
      }
    };
    window.addEventListener('mouseup', handleGlobalMouseUp);
    return () => window.removeEventListener('mouseup', handleGlobalMouseUp);
  }, []);

  useEffect(() => {
    if (!contextMenu) return;
    const close = () => setContextMenu(null);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', close);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', close);
    };
  }, [contextMenu]);

  // Fit image to screen initially. didFitRef guarantees this runs only on the
  // first frame the background appears — without it, every pdf.js re-render
  // (which can swap `image` references during zoom) would reset the view.
  const didFitRef = useRef(false);
  useEffect(() => {
    if (didFitRef.current) return;
    if (image && dimensions.width > 0 && dimensions.height > 0) {
      const scaleX = dimensions.width / imageWidth;
      const scaleY = dimensions.height / imageHeight;
      const initialScale = Math.min(scaleX, scaleY) * 0.9; // 90% of screen

      setStageScale(initialScale);
      setStagePos({
        x: (dimensions.width - imageWidth * initialScale) / 2,
        y: (dimensions.height - imageHeight * initialScale) / 2,
      });
      didFitRef.current = true;
    }
  }, [image, dimensions, imageWidth, imageHeight]);

  // ── Vector PDF page loading + on-demand rendering ────────────────────────────
  // Load the source PDF & target page once per (url, pageNum). The parent
  // remounts this component via `key={page.id}` on navigation, so this effect
  // runs fresh on every page flip — but the parsed document and rendered
  // bitmap are cached at module scope (src/utils/pdfDocCache.ts) across those
  // remounts, so a flip back to a recently-viewed page is instant instead of
  // re-parsing the PDF and re-rendering the page from scratch. The bitmap
  // cache is keyed by `${sourcePdfUrl}#${sourcePdfPageNum}` — the only stable
  // page identity available to this component (it isn't handed the page id
  // itself, only its vector source + page number).
  useEffect(() => {
    if (!sourcePdfUrl || !sourcePdfPageNum) {
      pdfPageRef.current = null;
      pdfProxyRef.current = null;
      setPdfImage(null);
      setPdfLoadProgress(null);
      lastRenderScaleRef.current = 0;
      return;
    }
    let cancelled = false;
    const bitmapKey = `${sourcePdfUrl}#${sourcePdfPageNum}`;

    // Resolves the (possibly cached) document + target page and populates
    // pdfProxyRef/pdfPageRef. Needed on BOTH the hit and miss paths — the
    // zoom re-render path, text search, and cross-page-reference detection
    // all key off the live page proxy, not just the displayed bitmap.
    const loadProxyAndPage = async (): Promise<any | null> => {
      try {
        // onProgress reports byte counts of the PDF download itself (total
        // is 0/unknown until the server sends Content-Length) — surfaced as
        // the "Loading sheet…" overlay while pdfImage is still null. On a
        // shared cache hit (another caller already triggered the load, or it
        // already resolved) this fires rarely-to-never, which is correct: a
        // cache hit has nothing new to report progress on.
        const proxy = await getCachedPdfDocument(sourcePdfUrl, ({ loaded, total }) => {
          if (!cancelled) setPdfLoadProgress({ loaded, total });
        });
        if (cancelled) return null;
        const page = await proxy.getPage(sourcePdfPageNum);
        if (cancelled) return null;
        pdfProxyRef.current = proxy;
        pdfPageRef.current = page;
        setPdfPageReadyTick(t => t + 1);
        return page;
      } catch (err: any) {
        if (err?.name !== 'RenderingCancelledException') {
          console.error('Failed to load source PDF', err);
        }
        return null;
      }
    };

    const cachedBitmap = getCachedPageBitmap(bitmapKey);
    if (cachedBitmap) {
      // Cache hit: display immediately, no progress overlay. The proxy/page
      // still resolve in the background (via loadProxyAndPage below) but
      // must never block or replace this image with a blank frame meanwhile.
      setPdfLoadProgress(null);
      lastRenderScaleRef.current = bitmapRenderScaleByKey.get(bitmapKey) ?? 2.0;
      setPdfImage(cachedBitmap);
      void loadProxyAndPage();
      return () => { cancelled = true; };
    }

    // Cache miss: full load + render, same pipeline as before, then populate
    // both caches so the next visit to this page (or others sharing this
    // source PDF) is fast.
    setPdfLoadProgress({ loaded: 0, total: 0 });
    (async () => {
      const page = await loadProxyAndPage();
      if (cancelled) return;
      if (!page) { setPdfLoadProgress(null); return; }
      try {
        // Initial render at base scale (2.0× matches imageWidth/imageHeight).
        const canvas = document.createElement('canvas');
        const viewport = page.getViewport({ scale: 2.0 });
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        const ctx = canvas.getContext('2d')!;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        renderTaskRef.current = page.render({ canvasContext: ctx, viewport } as any);
        await renderTaskRef.current.promise;
        if (cancelled) return;
        lastRenderScaleRef.current = 2.0;
        bitmapRenderScaleByKey.set(bitmapKey, 2.0);
        putCachedPageBitmap(bitmapKey, canvas);
        setPdfImage(canvas);
        setPdfLoadProgress(null);
      } catch (err: any) {
        if (err?.name !== 'RenderingCancelledException') {
          console.error('Failed to render source PDF page', err);
        }
        if (!cancelled) setPdfLoadProgress(null);
      }
    })();
    return () => {
      cancelled = true;
      if (renderTaskRef.current) { try { renderTaskRef.current.cancel(); } catch { /* noop */ } }
    };
  }, [sourcePdfUrl, sourcePdfPageNum]);

  // Normalize page numbers once so the text-item match below is a simple
  // map lookup. Trim + uppercase keeps it forgiving but avoids the false
  // positives a full substring match would cause (e.g. matching "A1" inside
  // "DETAIL A1 OF SHEET").
  const normalizedPageMap = useMemo(() => {
    const m = new Map<string, string>();
    if (!linkablePages) return m;
    for (const p of linkablePages) {
      const key = (p.pageNumber || '').trim().toUpperCase();
      if (key && !m.has(key)) m.set(key, p.pageId);
    }
    return m;
  }, [linkablePages]);

  // Detect cross-page references on this page. Runs once the page proxy is
  // loaded (signalled by pdfImage becoming non-null, OR — on a bitmap-cache
  // hit, where pdfImage is set before the proxy resolves — by
  // pdfPageReadyTick ticking once it does) and whenever the set of linkable
  // pages changes. Reuses the cached pdfPageRef — no extra PDF round-trip.
  // Vector pages only; legacy raster pages skip silently.
  useEffect(() => {
    if (!pdfImage || !pdfPageRef.current || normalizedPageMap.size === 0) {
      setPageRefs([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const pdfPage = pdfPageRef.current;
        const viewport = pdfPage.getViewport({ scale: 2.0 });
        const textContent = await pdfPage.getTextContent();
        if (cancelled) return;
        const refs: Array<{ pageId: string; x: number; y: number; width: number; height: number }> = [];
        for (const item of textContent.items as any[]) {
          const str: string = (item.str ?? '').trim();
          if (!str) continue;
          const key = str.toUpperCase();
          const targetId = normalizedPageMap.get(key);
          if (!targetId) continue;
          const tx = item.transform?.[4] ?? 0;
          const ty = item.transform?.[5] ?? 0;
          const w = item.width ?? 0;
          const h = item.height || Math.abs(item.transform?.[3] ?? item.transform?.[0] ?? 12);
          const [vx0, vy0] = viewport.convertToViewportPoint(tx, ty);
          const [vx1, vy1] = viewport.convertToViewportPoint(tx + w, ty + h);
          refs.push({
            pageId: targetId,
            x: Math.min(vx0, vx1),
            y: Math.min(vy0, vy1),
            width: Math.abs(vx1 - vx0),
            height: Math.abs(vy1 - vy0),
          });
        }
        if (!cancelled) setPageRefs(refs);
      } catch (e) {
        console.warn('Failed to detect page references', e);
      }
    })();
    return () => { cancelled = true; };
  }, [pdfImage, pdfPageReadyTick, normalizedPageMap]);

  // Render the page into a fresh canvas sized for the *current* zoom and swap
  // it in atomically — we never mutate the canvas that's on screen, otherwise
  // the page visibly blanks for the duration of the render. Max scale is kept
  // modest (≤4×) so the backing store stays small enough that a single render
  // doesn't block the main thread long enough to look like a freeze.
  //
  // Renders are strictly serialized via `isRenderingRef`. pdf.js cancellation
  // is asynchronous: starting a new render on the same page before the prior
  // task's cancellation has settled lets two render intents collide on the
  // worker, which on slow connections leaves the surviving render hung or
  // blank — the page disappears and never recovers. So we cancel the previous
  // task *and await its settlement* before starting the next one, and only one
  // render is ever in flight. When it finishes we re-check the live zoom and
  // render again if it moved, which guarantees the final zoom level is always
  // rendered no matter how fast the user zoomed.
  const renderPdfAtCurrentScale = useCallback(async () => {
    const page = pdfPageRef.current;
    if (!page || isRenderingRef.current) return;

    // Cap the contribution of devicePixelRatio so HiDPI screens don't push the
    // render scale to memory-heavy territory at moderate zoom levels.
    const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
    const targetScale = Math.max(2.0, Math.min(4.0, 2.0 * stageScaleRef.current * dpr));
    const prev = lastRenderScaleRef.current;
    if (prev > 0 && Math.abs(targetScale - prev) / prev < 0.20) return;

    isRenderingRef.current = true;
    let committed = false;
    try {
      // Tear down any prior task and wait for it to actually settle before
      // touching the page again. The await swallows the cancellation rejection.
      if (renderTaskRef.current) {
        try { renderTaskRef.current.cancel(); } catch { /* noop */ }
        try { await renderTaskRef.current.promise; } catch { /* cancelled */ }
        renderTaskRef.current = null;
      }

      const viewport = page.getViewport({ scale: targetScale });
      const nextCanvas = document.createElement('canvas');
      nextCanvas.width = Math.round(viewport.width);
      nextCanvas.height = Math.round(viewport.height);
      const ctx = nextCanvas.getContext('2d')!;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, nextCanvas.width, nextCanvas.height);

      const task = page.render({ canvasContext: ctx, viewport } as any);
      renderTaskRef.current = task;
      await task.promise;
      if (renderTaskRef.current === task) renderTaskRef.current = null;

      lastRenderScaleRef.current = targetScale;
      setPdfImage(nextCanvas);
      committed = true;
    } catch (err: any) {
      if (err?.name !== 'RenderingCancelledException') {
        console.error('PDF page re-render failed', err);
      }
    } finally {
      isRenderingRef.current = false;
    }

    // The zoom may have moved while we were rendering. Re-check against the
    // live scale and render again if needed — this is what lets the page catch
    // up to the final zoom level after rapid zooming instead of getting stuck
    // on a stale frame. Only chain off a successful commit so a hard render
    // failure can't spin in a tight retry loop.
    if (!committed) return;
    const settledScale = Math.max(2.0, Math.min(4.0, 2.0 * stageScaleRef.current * dpr));
    const settledPrev = lastRenderScaleRef.current;
    if (!(settledPrev > 0 && Math.abs(settledScale - settledPrev) / settledPrev < 0.20)) {
      void renderPdfAtCurrentScale();
    }
  }, []);

  // Debounced so a single drag through many zoom levels only kicks off once the
  // user pauses. The renderer itself reads the live scale, so a render queued
  // here always targets wherever the zoom ended up. `pdfPageReadyTick` is in
  // the deps so that a bitmap-cache-hit page flip (where `pdfImage` is set
  // before `pdfPageRef.current` has resolved) gets a chance to re-check once
  // the page proxy actually arrives — otherwise a zoom that happens in that
  // window would bail on the ref-not-ready guard below and never retry.
  useEffect(() => {
    if (!pdfImage || !pdfPageRef.current) return;
    if (rerenderTimerRef.current) clearTimeout(rerenderTimerRef.current);
    rerenderTimerRef.current = setTimeout(() => { void renderPdfAtCurrentScale(); }, 250);
    return () => {
      if (rerenderTimerRef.current) clearTimeout(rerenderTimerRef.current);
    };
  }, [stageScale, pdfImage, pdfPageReadyTick, renderPdfAtCurrentScale]);

  // Cleanup on unmount. The document proxy is NOT destroyed here — it's owned
  // by the module-level document cache (pdfDocCache.ts) now, shared across
  // PdfCanvas remounts, and destroyed only on its own LRU eviction.
  useEffect(() => () => {
    if (renderTaskRef.current) { try { renderTaskRef.current.cancel(); } catch { /* noop */ } }
    pdfProxyRef.current = null;
    pdfPageRef.current = null;
  }, []);

  useEffect(() => {
    let isActive = true;
    const runSearch = async () => {
      if (!searchTerm) {
        setSearchHighlights([]);
        return;
      }
      const lowerSearchTerm = searchTerm.toLowerCase();
      const searchWords = lowerSearchTerm.split(/\s+/).filter(Boolean);
      if (searchWords.length === 0) {
        setSearchHighlights([]);
        return;
      }

      // Vector path: use embedded text positions from pdf.js — instant and
      // exact, no OCR worker needed. Items are matched in their entirety
      // (each text item is typically a single word or short run), which keeps
      // the bounding box reliable without splitting glyph-by-glyph.
      const page = pdfPageRef.current;
      if (page) {
        setIsSearching(true);
        try {
          const viewport = page.getViewport({ scale: 2.0 });
          const textContent = await page.getTextContent();
          if (!isActive) return;
          const highlights: { x0: number; y0: number; x1: number; y1: number }[] = [];
          for (const item of textContent.items as any[]) {
            const str: string = (item.str || '').toLowerCase();
            if (!str) continue;
            if (!searchWords.some(sw => str.includes(sw))) continue;
            // PDF coords: transform = [a, b, c, d, e, f]; (e, f) is the baseline origin.
            // Use viewport.convertToViewportPoint to map to the same canvas coord space
            // that measurements live in (imageWidth × imageHeight at scale 2.0).
            const tx = item.transform?.[4] ?? 0;
            const ty = item.transform?.[5] ?? 0;
            const w = item.width ?? 0;
            const h = item.height ?? Math.abs(item.transform?.[3] ?? 12);
            const [vx0, vy0] = viewport.convertToViewportPoint(tx, ty);
            const [vx1, vy1] = viewport.convertToViewportPoint(tx + w, ty + h);
            highlights.push({
              x0: Math.min(vx0, vx1),
              y0: Math.min(vy0, vy1),
              x1: Math.max(vx0, vx1),
              y1: Math.max(vy0, vy1),
            });
          }
          if (isActive) setSearchHighlights(highlights);
        } catch (err) {
          console.error('Vector search failed:', err);
        } finally {
          if (isActive) setIsSearching(false);
        }
        return;
      }

      // Legacy raster path: OCR the page image. Only used for projects that
      // predate the vector pipeline and don't have a source PDF stored.
      if (!imageUrl) {
        setSearchHighlights([]);
        return;
      }
      setIsSearching(true);
      let worker: any = null;
      try {
        worker = await createWorker('eng');
        if (!isActive) return;
        const ret = await worker.recognize(imageUrl, {}, { blocks: true });
        if (!isActive) return;

        const data = ret?.data;
        const words = data?.words || [];

        const highlights = words
          .filter(w => {
            const wordText = w?.text?.toLowerCase() || '';
            return searchWords.some(sw => wordText.includes(sw));
          })
          .map(w => w.bbox);
        setSearchHighlights(highlights);
      } catch (error) {
        console.error('OCR search failed:', error);
      } finally {
        if (worker) await worker.terminate();
        if (isActive) {
          setIsSearching(false);
        }
      }
    };
    runSearch();
    return () => {
      isActive = false;
    };
  }, [searchTerm, imageUrl, pdfImage, pdfPageReadyTick]);

  const handleWheel = (e: any) => {
    e.evt.preventDefault();
    
    const stage = stageRef.current;
    if (!stage) return;

    const oldScale = stageScaleRef.current;
    const pointer = stage.getPointerPosition();
    if (!pointer) return;

    const mousePointTo = {
      x: (pointer.x - stagePosRef.current.x) / oldScale,
      y: (pointer.y - stagePosRef.current.y) / oldScale,
    };

    // Smoother zoom for trackpads by taking deltaY into account
    // deltaY is usually around 100 for a mouse wheel notch, but much smaller for trackpad
    const zoomSpeed = 0.0015;
    const delta = -e.evt.deltaY;
    const newScale = oldScale * Math.exp(delta * zoomSpeed);
    
    // Limit scale
    const limitedScale = Math.max(0.01, Math.min(newScale, 50));
    
    setStageScale(limitedScale);
    setStagePos({
      x: pointer.x - mousePointTo.x * limitedScale,
      y: pointer.y - mousePointTo.y * limitedScale,
    });
  };

  const handleZoomIn = () => {
    const oldScale = stageScaleRef.current;
    const oldPos = stagePosRef.current;
    const newScale = oldScale * 1.2;
    const center = { x: dimensions.width / 2, y: dimensions.height / 2 };
    const mousePointTo = {
      x: (center.x - oldPos.x) / oldScale,
      y: (center.y - oldPos.y) / oldScale,
    };
    setStageScale(newScale);
    setStagePos({
      x: center.x - mousePointTo.x * newScale,
      y: center.y - mousePointTo.y * newScale,
    });
  };

  const handleZoomOut = () => {
    const oldScale = stageScaleRef.current;
    const oldPos = stagePosRef.current;
    const newScale = oldScale / 1.2;
    const center = { x: dimensions.width / 2, y: dimensions.height / 2 };
    const mousePointTo = {
      x: (center.x - oldPos.x) / oldScale,
      y: (center.y - oldPos.y) / oldScale,
    };
    setStageScale(newScale);
    setStagePos({
      x: center.x - mousePointTo.x * newScale,
      y: center.y - mousePointTo.y * newScale,
    });
  };

  const handleResetView = () => {
    if (image && dimensions.width > 0 && dimensions.height > 0) {
      const scaleX = dimensions.width / imageWidth;
      const scaleY = dimensions.height / imageHeight;
      const initialScale = Math.min(scaleX, scaleY) * 0.9;
      
      setStageScale(initialScale);
      setStagePos({
        x: (dimensions.width - imageWidth * initialScale) / 2,
        y: (dimensions.height - imageHeight * initialScale) / 2,
      });
    }
  };

  const getRelativePointerPosition = (node: any) => {
    const transform = node.getAbsoluteTransform().copy();
    transform.invert();
    const pos = node.getStage().getPointerPosition();
    return transform.point(pos);
  };

  const handleMouseMove = (e: any) => {
    const stage = stageRef.current;
    if (!stage) return;
    
    const pos = getRelativePointerPosition(stage.getLayers()[0]);
    if (pos) {
      setMousePos(pos);
      latestCursorPosRef.current = pos;
      if (onCursorMove && cursorRafRef.current === null) {
        cursorRafRef.current = requestAnimationFrame(() => {
          cursorRafRef.current = null;
          const p = latestCursorPosRef.current;
          if (!p) return;
          const last = lastCursorRef.current;
          if (!last || Math.abs(p.x - last.x) + Math.abs(p.y - last.y) >= 2) {
            lastCursorRef.current = { x: p.x, y: p.y };
            onCursorMove(p.x, p.y);
          }
        });
      }
    }

    if (isMiddleMouseDown && lastMousePosRef.current) {
      // Prevent default to stop any built-in browser behavior like auto-scrolling
      if (e.evt && e.evt.preventDefault) {
        e.evt.preventDefault();
      }
      const dx = e.evt.clientX - lastMousePosRef.current.x;
      const dy = e.evt.clientY - lastMousePosRef.current.y;
      setStagePos(prev => ({ x: prev.x + dx, y: prev.y + dy }));
      lastMousePosRef.current = { x: e.evt.clientX, y: e.evt.clientY };
      return;
    }

    if (currentTool === 'pan' || activePoints.length === 0) return;
  };

  const handleMouseDown = (e: any) => {
    if (e.evt.button === 1) {
      e.evt.preventDefault();
      setIsMiddleMouseDown(true);
      isMiddleMouseDownRef.current = true;
      lastMousePosRef.current = { x: e.evt.clientX, y: e.evt.clientY };
      return;
    }
    if (currentTool === 'pan') return;
    
    if (e.target !== stageRef.current && e.target.name() !== 'backgroundImage') {
      // If we are not currently drawing, don't start a new drawing when clicking a shape
      if (activePoints.length === 0) {
        return;
      }
    } else {
      // Clicked on background. Only deselect for non-drawing tools — drawing
      // a new segment must keep the selected measurement so the segment is
      // appended to it. (Drawing tools enter this branch for the very first
      // click of a segment, where activePoints is still empty.)
      const isDrawingTool = currentTool === 'length' || isAreaLikeTool;
      if (activePoints.length === 0 && !isDrawingTool) {
        if (!e.evt.ctrlKey && !e.evt.metaKey && !isMultiSelectMode) {
          onSelectMeasurement(null);
          onClearMultiSelect?.();
        }
      }
    }

    const stage = stageRef.current;
    const pos = getRelativePointerPosition(stage.getLayers()[0]);
    
    if (currentTool === 'region') {
      if (activePoints.length > 0) {
        const lastPoint = activePoints[activePoints.length - 1];
        const dist = calculateDistance(lastPoint, pos);
        if (dist < 10 / stageScale) {
          if (activePoints.length > 2) {
            const newRegion: ScaleRegion = {
              id: uuidv4(),
              name: `Region ${scaleRegions.length + 1}`,
              points: [...activePoints],
              scaleConfig: null,
              color: '#8b5cf6', // Purple for regions
            };
            onAddRegion?.(newRegion);
          }
          setActivePoints([]);
          setMousePos(null);
          return;
        }
      }
      setActivePoints([...activePoints, pos]);
      return;
    }

    if (currentTool === 'scale') {
      if (activePoints.length === 0) {
        setActivePoints([pos]);
      } else if (activePoints.length === 1) {
        const newPoints = [...activePoints, pos];
        const dist = calculateDistance(newPoints[0], newPoints[1]);
        onSetScale(dist);
        setActivePoints([]);
        setMousePos(null);
      }
    } else if (currentTool === 'count') {
      // Check if multi-region and if point is in a region
      let regionId: string | undefined = undefined;
      if (isMultiRegion) {
        const region = scaleRegions.find(r => isPointInPolygon(pos, r.points));
        if (!region) {
          toast('In multi-region mode, measurements must be started inside a defined region.', { type: 'warning' });
          return;
        }
        regionId = region.id;
      }

      const newMeasurement: Measurement = {
        id: uuidv4(),
        type: 'count',
        points: [pos],
        color: '#f59e0b', // Amber color for count
        name: `Count ${measurements.length + 1}`,
        regionId,
      };
      onAddMeasurement(newMeasurement);
    } else if (currentTool === 'length' || isAreaLikeTool) {
      if (activePoints.length === 0 && isMultiRegion) {
        const region = scaleRegions.find(r => isPointInPolygon(pos, r.points));
        if (!region) {
          toast('In multi-region mode, measurements must be started inside a defined region.', { type: 'warning' });
          return;
        }
      }

      if (arcMode === 'waiting_mid') {
        setArcMidPoint(pos);
        setArcMode('waiting_end');
        return;
      } else if (arcMode === 'waiting_end') {
        const midPoint = arcMidPoint!;
        const endPoint = pos;
        // Store only 3 points (start is already last in activePoints), record mid index
        const arcMidIdx = activePoints.length; // index of mid in the new array
        const newPoints = [...activePoints, midPoint, endPoint];
        setActivePoints(newPoints);
        setActiveArcMidIndices(prev => [...prev, arcMidIdx]);
        setArcMode('inactive');
        setArcMidPoint(null);
        return;
      }

      // If clicking very close to the last point, finish the current segment
      if (activePoints.length > 0) {
        const lastPoint = activePoints[activePoints.length - 1];
        const dist = calculateDistance(lastPoint, pos);
        const threshold = (window.innerWidth < 768 ? 20 : 10) / stageScale;
        if (dist < threshold) {
          finalizeSegment();
          return;
        }
      }
      setActivePoints([...activePoints, pos]);
    }
  };

  const handleMouseUp = (e: any) => {
    if (e.evt.button === 1) {
      setIsMiddleMouseDown(false);
      lastMousePosRef.current = null;
    }
  };

  const handleTouchStart = (e: any) => {
    const stage = stageRef.current;
    if (!stage) return;

    // Always prevent default to stop browser-level panning/scrolling
    // when interacting with the canvas
    if (e.evt.cancelable) {
      e.evt.preventDefault();
    }

    if (e.evt.touches.length === 2) {
      // Pinch to zoom
      const touch1 = e.evt.touches[0];
      const touch2 = e.evt.touches[1];
      lastDistRef.current = calculateDistance(
        { x: touch1.clientX, y: touch1.clientY },
        { x: touch2.clientX, y: touch2.clientY }
      );
      lastCenterRef.current = {
        x: (touch1.clientX + touch2.clientX) / 2,
        y: (touch1.clientY + touch2.clientY) / 2,
      };
    } else if (e.evt.touches.length === 1) {
      handleMouseDown(e);
    }
  };

  const handleTouchMove = (e: any) => {
    const stage = stageRef.current;
    if (!stage) return;

    if (e.evt.cancelable) {
      e.evt.preventDefault();
    }

    if (e.evt.touches.length === 2) {
      const touch1 = e.evt.touches[0];
      const touch2 = e.evt.touches[1];
      const dist = calculateDistance(
        { x: touch1.clientX, y: touch1.clientY },
        { x: touch2.clientX, y: touch2.clientY }
      );
      const center = {
        x: (touch1.clientX + touch2.clientX) / 2,
        y: (touch1.clientY + touch2.clientY) / 2,
      };

      if (lastDistRef.current > 0 && lastCenterRef.current) {
        const oldScale = stageScaleRef.current;
        const oldPos = stagePosRef.current;
        const scaleFactor = dist / lastDistRef.current;
        const newScale = Math.max(0.01, Math.min(oldScale * scaleFactor, 50));

        // Pan + zoom: canvas point under lastCenter should appear at center
        const lastCenter = lastCenterRef.current;
        const mousePointTo = {
          x: (lastCenter.x - oldPos.x) / oldScale,
          y: (lastCenter.y - oldPos.y) / oldScale,
        };
        const newPos = {
          x: center.x - mousePointTo.x * newScale,
          y: center.y - mousePointTo.y * newScale,
        };

        // Update refs synchronously so the next touchmove (which may fire
        // before React commits) reads the correct baseline — otherwise the
        // stale ref causes every other frame to snap backward, producing stutter.
        stageScaleRef.current = newScale;
        stagePosRef.current = newPos;

        // Apply directly to the Konva stage for immediate visual feedback,
        // bypassing React's render cycle on every touchmove event.
        const stageNode = stage;
        stageNode.scale({ x: newScale, y: newScale });
        stageNode.position(newPos);
        stageNode.batchDraw();

        // Queue a state commit so non-Konva UI (zoom %) reflects the change.
        if (zoomRafRef.current) cancelAnimationFrame(zoomRafRef.current);
        zoomRafRef.current = requestAnimationFrame(() => {
          setStageScale(newScale);
          setStagePos(newPos);
          zoomRafRef.current = null;
        });
      }

      lastDistRef.current = dist;
      lastCenterRef.current = center;
    } else if (e.evt.touches.length === 1) {
      handleMouseMove(e);
    }
  };

  const handleTouchEnd = (e: any) => {
    if (e.evt.cancelable) {
      e.evt.preventDefault();
    }
    lastDistRef.current = 0;
    lastCenterRef.current = null;
    lastMousePosRef.current = null;
    handleMouseUp(e);
  };

  // Handle Escape to cancel drawing
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Don't intercept if user is typing in an input or textarea
      if (
        document.activeElement?.tagName === 'INPUT' ||
        document.activeElement?.tagName === 'TEXTAREA' ||
        document.activeElement?.tagName === 'SELECT'
      ) {
        return;
      }

      if (e.key === 'Escape') {
        cancelDrawing();
      } else if (e.key === 'Enter') {
        if (activePoints.length > 1 && (currentTool === 'length' || isAreaLikeTool || currentTool === 'region')) {
          if (currentTool === 'region') {
            if (activePoints.length > 2) {
              const newRegion: ScaleRegion = {
                id: uuidv4(),
                name: `Region ${scaleRegions.length + 1}`,
                points: [...activePoints],
                scaleConfig: null,
                color: '#8b5cf6',
              };
              onAddRegion?.(newRegion);
            }
          } else {
            finalizeSegment();
          }
        }
      } else if (e.key === 'Backspace') {
        // Backspace ONLY pops the last in-progress point. Delete is owned by
        // CanvasView (delete the selected measurement/segment) and must not
        // touch the drawing state; the two keys are deliberately disjoint.
        if (activePoints.length > 0) {
          e.preventDefault();
          const lastIdx = activePoints.length - 1;
          const lastMidIdx = activeArcMidIndices[activeArcMidIndices.length - 1];
          if (lastMidIdx === lastIdx - 1) {
            // Last two points form an arc end + mid — remove both
            setActivePoints(prev => prev.slice(0, -2));
            setActiveArcMidIndices(prev => prev.slice(0, -1));
          } else {
            setActivePoints(prev => prev.slice(0, -1));
            setActiveArcMidIndices(prev => prev.filter(i => i < lastIdx));
          }
          if (arcMode !== 'inactive') {
            setArcMode('inactive');
            setArcMidPoint(null);
          }
        }
      } else if (e.key.toLowerCase() === 'a') {
        if (activePoints.length > 0 && arcMode === 'inactive' && (currentTool === 'length' || isAreaLikeTool)) {
          setArcMode('waiting_mid');
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [activePoints, currentTool, measurements, onAddMeasurement, arcMode, onCancel, resumeMeasurementId, activeArcMidIndices, selectedMeasurementId]);

  const cancelDrawing = () => {
    setActivePoints([]);
    setMousePos(null);
    setArcMode('inactive');
    setArcMidPoint(null);
    setActiveArcMidIndices([]);
    setResumingSegmentIdx(-1);
    setResumeMeasurementId(null);
    onCancel?.();
  };

  // Finalize the current in-progress segment, save it to the measurement, and
  // leave drawing active so the user can immediately start the next segment.
  // Append target = the currently selected measurement (when its type matches
  // the active tool). Otherwise create a fresh measurement and select it.
  const finalizeSegment = () => {
    // Frozen history / phone read-only: nothing gets written. CanvasView also
    // forces the tool back to pan, so this is belt-and-braces for the write.
    if (readOnly) { cancelDrawing(); return; }
    if (activePoints.length <= 1) return;

    let regionId: string | undefined = undefined;
    if (isMultiRegion) {
      const region = scaleRegions.find(r => isPointInPolygon(activePoints[0], r.points));
      regionId = region?.id;
    }

    const segPoints = [...activePoints];
    const segArcMids: MeasurementSegment['arcMidIndices'] = activeArcMidIndices.length > 0
      ? [...activeArcMidIndices]
      : undefined;
    const isSubtract = currentTool === 'subtract';
    const drawingType = isSubtract ? 'area' : (currentTool as 'length' | 'area');

    if (resumeMeasurementId) {
      const existing = measurements.find(m => m.id === resumeMeasurementId);
      if (resumingSegmentIdx >= 0 && existing) {
        // Resuming an additional segment — rewrite that segment in place.
        // Spread the existing segment so a cutout stays a cutout when its
        // outline is redrawn.
        const newSegments = (existing.segments ?? []).map((s, i) =>
          i === resumingSegmentIdx ? { ...s, points: segPoints, arcMidIndices: segArcMids } : s
        );
        onUpdateMeasurement(resumeMeasurementId, { segments: newSegments });
      } else {
        const updated: Measurement = {
          id: resumeMeasurementId,
          type: drawingType,
          points: segPoints,
          color: existing?.color ?? (drawingType === 'length' ? '#3b82f6' : '#10b981'),
          name: existing?.name ?? `${drawingType === 'length' ? 'Length' : 'Area'} ${measurements.length + 1}`,
          regionId,
          arcMidIndices: segArcMids,
        };
        onUpdateMeasurement(resumeMeasurementId, updated);
      }
      setResumeMeasurementId(null);
      setResumingSegmentIdx(-1);
    } else {
      const selected = selectedMeasurementId
        ? measurements.find(m => m.id === selectedMeasurementId)
        : null;
      const canAppend = !!selected && selected.type === drawingType;

      if (isSubtract) {
        // Cutouts attach to the selected area measurement or nowhere. The
        // toolbar gates the tool on an area measurement selected ON THIS PAGE;
        // this branch is the backstop so a dropped polygon is never silent.
        if (canAppend && selected && selected.points.length > 0 && activePoints.length > 2) {
          const newSeg: MeasurementSegment = { points: segPoints, arcMidIndices: segArcMids, subtract: true };
          onUpdateMeasurement(selected.id, { segments: [...(selected.segments ?? []), newSeg] });
        } else if (!canAppend || !selected || selected.points.length === 0) {
          toast('Cutout discarded — select an area measurement on this page first.', { type: 'warning' });
        }
      } else if (canAppend && selected) {
        if (selected.points.length === 0) {
          // Empty placeholder created via "New Measurement" — fill the first segment.
          onUpdateMeasurement(selected.id, {
            points: segPoints,
            arcMidIndices: segArcMids,
            regionId: selected.regionId ?? regionId,
          });
        } else {
          // Append as an additional segment.
          const newSeg: MeasurementSegment = { points: segPoints, arcMidIndices: segArcMids };
          onUpdateMeasurement(selected.id, {
            segments: [...(selected.segments ?? []), newSeg],
          });
        }
      } else {
        const newId = uuidv4();
        const newMeasurement: Measurement = {
          id: newId,
          type: drawingType,
          points: segPoints,
          color: drawingType === 'length' ? '#3b82f6' : '#10b981',
          name: `${drawingType === 'length' ? 'Length' : 'Area'} ${measurements.length + 1}`,
          regionId,
          arcMidIndices: segArcMids,
        };
        onAddMeasurement(newMeasurement);
        // Promote the new measurement to the selection so subsequent segments
        // append to it.
        onSelectMeasurement(newId);
      }
    }

    setActivePoints([]);
    setMousePos(null);
    setArcMode('inactive');
    setArcMidPoint(null);
    setActiveArcMidIndices([]);
  };

  const renderActiveDrawing = () => {
    if (activePoints.length === 0) return null;

    // Stored points (compact: arcs are 3 points)
    let storedPoints = [...activePoints];
    let previewArcMidIndices = [...activeArcMidIndices];

    if (mousePos) {
      if (arcMode === 'waiting_end' && arcMidPoint) {
        // Preview arc from last active point through arcMidPoint to mousePos
        const arcMidIdx = storedPoints.length; // where mid goes
        storedPoints = [...storedPoints, arcMidPoint, mousePos];
        previewArcMidIndices = [...previewArcMidIndices, arcMidIdx];
      } else {
        storedPoints.push(mousePos);
      }
    }

    // Expand arcs for display
    const displayPoints = expandArcPoints(storedPoints, previewArcMidIndices);
    const flatPoints = displayPoints.flatMap(p => [p.x, p.y]);
    const arcMidSet = new Set(activeArcMidIndices);

    // A cutout previews in its parent measurement's color so it reads as part
    // of that shape rather than as a new one.
    const selectedColor = selectedMeasurementId
      ? measurements.find(mm => mm.id === selectedMeasurementId)?.color
      : undefined;
    const color = currentTool === 'scale' ? '#ef4444'
      : currentTool === 'length' ? '#3b82f6'
      : currentTool === 'region' ? '#8b5cf6'
      : currentTool === 'subtract' ? (selectedColor ?? '#10b981')
      : '#10b981';

    return (
      <Group>
        <Line
          points={flatPoints}
          stroke={color}
          strokeWidth={4 / stageScale}
          lineJoin="round"
          lineCap="round"
          dash={
            currentTool === 'scale' ? [5 / stageScale, 5 / stageScale]
            : currentTool === 'subtract' ? [8 / stageScale, 6 / stageScale]
            : undefined
          }
          closed={(isAreaLikeTool || currentTool === 'region') && activePoints.length > 2 && arcMode === 'inactive'}
          // No fill while subtracting — the hole is what's being removed, so a
          // solid preview over the parent area would read backwards.
          fill={(currentTool === 'area' || currentTool === 'region') ? `${color}40` : undefined}
        />
        {activePoints.map((p, i) => (
          <Circle
            key={i}
            x={p.x}
            y={p.y}
            radius={arcMidSet.has(i) ? 3 / stageScale : 4 / stageScale}
            fill={arcMidSet.has(i) ? '#f97316' : color}
          />
        ))}
        {arcMidPoint && (
          <Circle
            x={arcMidPoint.x}
            y={arcMidPoint.y}
            radius={4 / stageScale}
            fill="#ef4444"
          />
        )}
      </Group>
    );
  };

  const getSelectedMeasurementCenter = () => {
    if (!selectedMeasurementId) return null;
    const m = measurements.find(m => m.id === selectedMeasurementId);
    if (!m || m.points.length === 0) return null;

    let centerX = 0, centerY = 0;
    if (m.type === 'count') {
      centerX = m.points[0].x;
      centerY = m.points[0].y;
    } else if (m.type === 'length') {
      if (m.points.length < 2) return m.points[0];
      const midIdx = Math.floor((m.points.length - 1) / 2);
      centerX = (m.points[midIdx].x + m.points[midIdx + 1].x) / 2;
      centerY = (m.points[midIdx].y + m.points[midIdx + 1].y) / 2;
    } else {
      m.points.forEach(p => { centerX += p.x; centerY += p.y; });
      centerX /= m.points.length;
      centerY /= m.points.length;
    }
    return { x: centerX, y: centerY };
  };

  const renderMeasurements = () => {
    return measurements
      .filter(m => m.id !== resumeMeasurementId)
      .filter(m => m.points.length > 0 || (m.segments && m.segments.length > 0))
      .map((m) => {
      // Find region scale if applicable
      let currentScale = scaleConfig;
      if (isMultiRegion && m.regionId) {
        const region = scaleRegions.find(r => r.id === m.regionId);
        if (region?.scaleConfig) {
          currentScale = region.scaleConfig;
        }
      }

      // Resolve a segment's points with any in-progress vertex drag applied
      // (segIdx undefined = primary). Shared by the Lines below and the
      // compound punch-out Shape so they stay in sync during vertex drags.
      const adjustPoints = (rawPoints: Point[], segIdx?: number) => rawPoints.map((p, pi) => {
        if (draggingPoint && draggingPoint.mId === m.id && draggingPoint.segIdx === segIdx && draggingPoint.idx === pi) {
          return { x: draggingPoint.x, y: draggingPoint.y };
        }
        return { x: p.x, y: p.y };
      });

      // Compact points (including arc control mid-points)
      const points = adjustPoints(m.points);

      // Expanded display points (arcs interpolated to smooth curves)
      const displayPoints = expandArcPoints(points, m.arcMidIndices);
      const flatPoints = displayPoints.flatMap(p => [p.x, p.y]);

      // Drag-adjusted geometry for the punch-out Shape and cutout math —
      // built once per measurement so it matches what the Lines render.
      const hasHoles = m.type === 'area' && (m.segments ?? []).some(s => s.subtract);
      const adjustedSegments = (m.segments ?? []).map((s, segIdx) => ({
        ...s,
        points: adjustPoints(s.points, segIdx),
      }));

      // Apply a segment subgroup's in-progress drag offset. ONLY the compound
      // Shape gets this: it sits outside the dragged subgroup, whereas the
      // Lines are inside it and Konva translates them natively — feeding them
      // the same offset would move them twice.
      const withSegmentDrag = (pts: Point[], segIdx: number) => {
        const d = draggingSegment;
        if (!d || d.mId !== m.id || d.segIdx !== segIdx || (d.dx === 0 && d.dy === 0)) return pts;
        return pts.map(p => ({ x: p.x + d.dx, y: p.y + d.dy }));
      };
      const adjustedGeometry = {
        points: withSegmentDrag(points, -1),
        arcMidIndices: m.arcMidIndices,
        segments: adjustedSegments.map((s, segIdx) => ({ ...s, points: withSegmentDrag(s.points, segIdx) })),
      };

      // Calculate center for text (use display points for position)
      let centerX = 0, centerY = 0;
      if (m.type === 'count') {
        centerX = points[0].x;
        centerY = points[0].y;
      } else if (m.type === 'length') {
        const midIdx = Math.floor((displayPoints.length - 1) / 2);
        centerX = (displayPoints[midIdx].x + displayPoints[Math.min(midIdx + 1, displayPoints.length - 1)].x) / 2;
        centerY = (displayPoints[midIdx].y + displayPoints[Math.min(midIdx + 1, displayPoints.length - 1)].y) / 2;
      } else {
        displayPoints.forEach(p => { centerX += p.x; centerY += p.y; });
        centerX /= displayPoints.length;
        centerY /= displayPoints.length;
      }

      // All expanded segment display points (primary + additional)
      const allSegDisplayPoints = [
        displayPoints,
        ...(m.segments ?? []).map(s => expandArcPoints(s.points, s.arcMidIndices)),
      ];

      let text = '';
      const takeoff = takeoffs.find(t => t.id === m.takeoffId);
      const isSurfaceArea = takeoff?.type === 'area' && m.type === 'length';
      // A multiplied measurement shows its math: "1250.00 sq ft × 4 = 5000.00 sq ft".
      const multiplier = measurementMultiplier(m);

      if (m.type === 'count') {
        text = '1';
      } else if (isSurfaceArea) {
        const pxArea = allSegDisplayPoints.reduce((sum, pts) =>
          sum + calculateSurfaceAreaPx(pts, m.heights || [], m.isTwoSided || false, currentScale), 0);
        const pxLen = allSegDisplayPoints.reduce((sum, pts) => sum + calculatePolylineLength(pts), 0);
        const areaText = formatMultiplied(pxArea, multiplier, v => formatMeasurement(v, 'area', currentScale, takeoff));
        const lenText = formatMeasurement(pxLen, 'length', currentScale, takeoff);
        text = `${areaText}\nLength: ${lenText}`;
      } else if (m.type === 'length') {
        const pxLen = allSegDisplayPoints.reduce((sum, pts) => sum + calculatePolylineLength(pts), 0);
        text = formatMultiplied(pxLen, multiplier, v => formatMeasurement(v, 'length', currentScale, takeoff));
      } else {
        // `points` (not displayPoints) — the helper expands arcs itself, and
        // this keeps the label live while a vertex is being dragged.
        const pxArea = measurementAreaPx({ points, arcMidIndices: m.arcMidIndices, segments: m.segments });
        text = formatMultiplied(pxArea, multiplier, v => formatMeasurement(v, 'area', currentScale, takeoff));
      }

      const isSelected = selectedMeasurementId === m.id;
      // null = whole measurement selected (highlight all segments)
      // -1 = primary segment only; 0+ = that extra segment only
      const isPrimarySelected = isSelected && (selectedSegmentIdx === null || selectedSegmentIdx === -1);
      const isSegmentSelected = (segIdx: number) => isSelected && (selectedSegmentIdx === null || selectedSegmentIdx === segIdx);
      const isMultiSelected = multiSelectedIds?.has(m.id) ?? false;
      const isDrawingTool = currentTool === 'length' || isAreaLikeTool || currentTool === 'count';

      // While ONE segment of a multi-segment measurement is selected, that
      // segment also gets its own value label (quantity · $), built from the
      // same drag-adjusted geometry the Lines draw so it stays live during a
      // vertex drag. It sits on the segment, or just below the total label
      // when it would collide with it. A single-shape measurement's segment IS
      // the measurement, so its total label already says it.
      const selectedSeg = !isSelected || selectedSegmentIdx === null || m.type === 'count' || !m.segments?.length ? undefined
        : selectedSegmentIdx === -1 ? { points, arcMidIndices: m.arcMidIndices }
        : adjustedSegments[selectedSegmentIdx];
      let segmentLabel: { text: string; x: number; y: number } | null = null;
      if (selectedSeg && selectedSeg.points.length > 0) {
        const segText = segmentLabelText(describeQuantity(
          segmentPixelQuantity(m, selectedSeg, takeoff?.type, currentScale),
          { scale: currentScale, takeoff, totals: takeoffCostTotals?.find(t => t.id === m.takeoffId), pageUnit: scaleConfig?.unit, multiplier },
        ));
        const pos = placeSegmentLabel({
          segmentAnchor: labelAnchor(m.type, expandArcPoints(selectedSeg.points, selectedSeg.arcMidIndices)),
          segmentText: segText,
          totalAnchor: { x: centerX, y: centerY },
          totalText: text,
          isPrimary: selectedSegmentIdx === -1,
          stageScale,
        });
        segmentLabel = { text: segText, ...pos };
      }
      // Selection-highlight amber behind dark text, scaled like the total label.
      const renderSegmentLabel = () => segmentLabel && (
        <Label x={segmentLabel.x} y={segmentLabel.y} listening={false} name="segment-value-label">
          <Tag
            fill="#fbbf24"
            stroke="#b45309"
            strokeWidth={1 / stageScale}
            cornerRadius={4 / stageScale}
            shadowColor="black"
            shadowBlur={6 / stageScale}
            shadowOpacity={0.35}
          />
          <Text
            text={segmentLabel.text}
            fontSize={LABEL_FONT_SIZE / stageScale}
            fontStyle="bold"
            fill="#000"
            padding={LABEL_PADDING / stageScale}
            align="center"
          />
        </Label>
      );

      // Per-segment click — falls through to whole-measurement select if no handler is wired.
      const handleSegmentClick = (e: any, segIdx: number) => {
        e.cancelBubble = true;
        if (activePoints.length > 0) return;
        if (e.evt?.ctrlKey || e.evt?.metaKey || isMultiSelectMode) {
          onMultiSelectToggle?.(m.id, m.type);
          return;
        }
        onClearMultiSelect?.();
        if (onSelectSegment) onSelectSegment(m.id, segIdx);
        else onSelectMeasurement(m.id);
      };

      // Shared drag handlers used by each segment subgroup. Each subgroup is
      // independently draggable so multi-segment measurements move per segment
      // rather than as a single rigid shape.
      // segIdx: -1 = primary segment, 0+ = that extra segment. Tracking the
      // live offset only matters when a punch-out Shape has to follow along.
      const trackSegmentDrag = (e: any, segIdx: number) => {
        if (!hasHoles || e.target !== e.currentTarget) return;
        setDraggingSegment({ mId: m.id, segIdx, dx: e.target.x(), dy: e.target.y() });
      };
      const segmentDragStart = (e: any, segIdx: number) => {
        if (readOnly || (e.evt && e.evt.button !== 0) || isMiddleMouseDownRef.current) {
          e.target.stopDrag();
          return;
        }
        e.cancelBubble = true;
        trackSegmentDrag(e, segIdx);
      };
      const segmentDragMove = (e: any, segIdx: number) => {
        if (readOnly) return;
        e.cancelBubble = true;
        trackSegmentDrag(e, segIdx);
      };

      // Double-click on a segment line inserts a new vertex at the click,
      // ordered between the surrounding vertices.
      const insertVertexAtClick = (segPts: Point[]): Point[] | null => {
        if (readOnly) return null;
        const stage = stageRef.current;
        const pos = getRelativePointerPosition(stage.getLayers()[0]);
        if (!pos || segPts.length < 2) return null;
        const isArea = m.type === 'area';
        const pairs: [Point, Point][] = isArea
          ? segPts.map((p, i) => [p, segPts[(i + 1) % segPts.length]] as [Point, Point])
          : segPts.slice(0, -1).map((p, i) => [p, segPts[i + 1]] as [Point, Point]);
        let bestIdx = 0;
        let bestDist = Infinity;
        pairs.forEach(([a, b], i) => {
          const dx = b.x - a.x, dy = b.y - a.y;
          const lenSq = dx * dx + dy * dy;
          let t = lenSq > 0 ? ((pos.x - a.x) * dx + (pos.y - a.y) * dy) / lenSq : 0;
          t = Math.max(0, Math.min(1, t));
          const cx = a.x + t * dx, cy = a.y + t * dy;
          const d = Math.hypot(pos.x - cx, pos.y - cy);
          if (d < bestDist) { bestDist = d; bestIdx = i; }
        });
        const newPoints = [...segPts];
        newPoints.splice(bestIdx + 1, 0, pos);
        return newPoints;
      };

      return (
        <Group
          key={m.id}
          listening={!isDrawingTool}
          onClick={(e) => {
            e.cancelBubble = true;
            if (activePoints.length === 0) {
              if (e.evt.ctrlKey || e.evt.metaKey || isMultiSelectMode) {
                onMultiSelectToggle?.(m.id, m.type);
              } else {
                onClearMultiSelect?.();
                onSelectMeasurement(m.id);
              }
            }
          }}
          onTap={(e) => {
            e.cancelBubble = true;
            // A long-press already opened the context menu — don't also select.
            if (longPressFiredRef.current) { longPressFiredRef.current = false; return; }
            if (activePoints.length === 0) {
              if (isMultiSelectMode) {
                onMultiSelectToggle?.(m.id, m.type);
              } else {
                onSelectMeasurement(m.id);
              }
            }
          }}
          onContextMenu={(e) => {
            e.evt.preventDefault();
            e.cancelBubble = true;
            // Read-only history: no edit/delete menu on measurements.
            if (readOnly) return;
            setContextMenu({ x: e.evt.clientX, y: e.evt.clientY, measurementId: m.id });
          }}
          onTouchStart={(e) => {
            // Read-only history: no long-press edit/delete menu.
            if (readOnly) { cancelLongPress(); return; }
            // Arm long-press only for a single-finger touch (two fingers = pinch
            // zoom). Capture the touch point now; fire the context menu after the
            // hold delay if the finger hasn't moved or lifted.
            if (e.evt.touches && e.evt.touches.length !== 1) { cancelLongPress(); return; }
            const touch = e.evt.touches?.[0];
            if (!touch) { cancelLongPress(); return; }
            const x = touch.clientX;
            const y = touch.clientY;
            longPressFiredRef.current = false;
            cancelLongPress();
            longPressTimerRef.current = setTimeout(() => {
              longPressFiredRef.current = true;
              longPressTimerRef.current = null;
              setContextMenu({ x, y, measurementId: m.id });
            }, 500);
          }}
          onTouchMove={cancelLongPress}
          onTouchEnd={cancelLongPress}
          name="measurement-group"
        >
          {hasHoles && (
            <Shape
              listening={false}
              sceneFunc={(ctx, shape) => {
                ctx.beginPath();
                for (const ring of measurementRings(adjustedGeometry)) {
                  ring.points.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x, p.y) : ctx.lineTo(p.x, p.y)));
                  ctx.closePath();
                }
                ctx.fillStrokeShape(shape); // nonzero rule + reversed hole winding = real hole
              }}
              fill={`${isMultiSelected ? '#f59e0b' : m.color}${isPrimarySelected ? '60' : isMultiSelected ? '50' : '40'}`}
            />
          )}
          {m.type === 'count' ? (
            <Group
              x={points[0].x}
              y={points[0].y}
              draggable={!readOnly && currentTool === 'pan' && !isMiddleMouseDown}
              onDragStart={(e) => segmentDragStart(e, -1)}
              onDragMove={(e) => segmentDragMove(e, -1)}
              onDragEnd={(e) => {
                // I2 fix: clear the drag flag BEFORE the readOnly check — if
                // readOnly flips mid-drag (phone breakpoint, revision goes
                // superseded), an early return above this line would leave
                // draggingPoint/draggingSegment stuck non-null forever,
                // permanently blocking the mid-gesture reload/backfill guard.
                setDraggingSegment(null);
                if (readOnly) return;
                e.cancelBubble = true;
                onUpdateMeasurement(m.id, { points: [{ x: e.target.x(), y: e.target.y() }] });
              }}
            >
              {isSelected && (
                <Circle
                  radius={20 / stageScale}
                  stroke="#fbbf24"
                  strokeWidth={3 / stageScale}
                  dash={[6 / stageScale, 4 / stageScale]}
                  opacity={0.95}
                  listening={false}
                />
              )}
              <Circle
                radius={isSelected ? 14 / stageScale : 12 / stageScale}
                fill={m.color}
                opacity={0.8}
                shadowColor={isSelected ? '#fbbf24' : undefined}
                shadowBlur={isSelected ? 16 / stageScale : 0}
                shadowOpacity={isSelected ? 0.9 : 0}
              />
              <Line
                points={[-6 / stageScale, 0, 6 / stageScale, 0]}
                stroke="#fff"
                strokeWidth={3 / stageScale}
              />
              <Line
                points={[0, -6 / stageScale, 0, 6 / stageScale]}
                stroke="#fff"
                strokeWidth={3 / stageScale}
              />
            </Group>
          ) : (
            <Group
              draggable={!readOnly && currentTool === 'pan' && !isMiddleMouseDown}
              onDragStart={(e) => segmentDragStart(e, -1)}
              onDragMove={(e) => segmentDragMove(e, -1)}
              onClick={(e) => handleSegmentClick(e, -1)}
              onTap={(e) => handleSegmentClick(e, -1)}
              onDragEnd={(e) => {
                // I2 fix: see the count-marker onDragEnd above — clear the
                // drag flag before any early return so it can never stick.
                setDraggingSegment(null);
                if (readOnly) return;
                // Ignore drag-ends that bubbled up from a child (e.g. a vertex circle).
                if (e.target !== e.currentTarget) return;
                e.cancelBubble = true;
                const dx = e.target.x();
                const dy = e.target.y();
                e.target.x(0);
                e.target.y(0);
                const newPoints = m.points.map(p => ({ x: p.x + dx, y: p.y + dy }));
                onUpdateMeasurement(m.id, { points: newPoints });
              }}
            >
              {isPrimarySelected && (
                <Line
                  points={flatPoints}
                  stroke="#fbbf24"
                  strokeWidth={14 / stageScale}
                  opacity={0.55}
                  lineJoin="round"
                  lineCap="round"
                  closed={m.type === 'area'}
                  dash={[14 / stageScale, 8 / stageScale]}
                  listening={false}
                />
              )}
              <Line
                points={flatPoints}
                stroke={isMultiSelected ? '#f59e0b' : m.color}
                strokeWidth={isPrimarySelected ? 8 / stageScale : isMultiSelected ? 7 / stageScale : 5 / stageScale}
                hitStrokeWidth={20 / stageScale}
                lineJoin="round"
                lineCap="round"
                closed={m.type === 'area'}
                fill={m.type === 'area' && !hasHoles ? `${isMultiSelected ? '#f59e0b' : m.color}${isPrimarySelected ? '60' : isMultiSelected ? '50' : '40'}` : undefined}
                shadowColor={isMultiSelected ? '#f59e0b' : isPrimarySelected ? '#fbbf24' : undefined}
                shadowBlur={isMultiSelected ? 14 / stageScale : isPrimarySelected ? 18 / stageScale : 0}
                shadowOpacity={isMultiSelected ? 0.7 : isPrimarySelected ? 0.85 : 0}
                onDblClick={(e) => {
                  e.cancelBubble = true;
                  const newPoints = insertVertexAtClick(m.points);
                  if (newPoints) onUpdateMeasurement(m.id, { points: newPoints });
                }}
                onDblTap={(e) => {
                  e.cancelBubble = true;
                  const newPoints = insertVertexAtClick(m.points);
                  if (newPoints) onUpdateMeasurement(m.id, { points: newPoints });
                }}
              />
              {points.map((p, i) => (
                <Circle
                  key={i}
                  x={p.x}
                  y={p.y}
                  radius={isPrimarySelected ? 8 / stageScale : 6 / stageScale}
                  fill={m.color}
                  stroke={isPrimarySelected ? '#fff' : undefined}
                  strokeWidth={isPrimarySelected ? 2 / stageScale : 0}
                  draggable={!readOnly && currentTool === 'pan' && !isMiddleMouseDown}
                  onDragStart={(e) => {
                    if (readOnly || (e.evt && e.evt.button !== 0) || isMiddleMouseDownRef.current) {
                      e.target.stopDrag();
                      return;
                    }
                    e.cancelBubble = true;
                    setDraggingPoint({ mId: m.id, idx: i, x: p.x, y: p.y });
                  }}
                  onDragMove={(e) => {
                    if (readOnly) return;
                    e.cancelBubble = true;
                    setDraggingPoint({ mId: m.id, idx: i, x: e.target.x(), y: e.target.y() });
                  }}
                  onDragEnd={(e) => {
                    // I2 fix: clear before the readOnly early return (see above).
                    setDraggingPoint(null);
                    if (readOnly) return;
                    e.cancelBubble = true;
                    const newPoints = [...m.points];
                    newPoints[i] = { x: e.target.x(), y: e.target.y() };

                    // Reset the circle's position so it doesn't double-apply the offset
                    e.target.x(p.x);
                    e.target.y(p.y);

                    onUpdateMeasurement(m.id, { points: newPoints });
                  }}
                  hitStrokeWidth={10 / stageScale}
                />
              ))}
              {/* Text label is anchored to the primary segment so it tracks
                  the segment's drag transform. */}
              {text && (
                <Group x={centerX} y={centerY} listening={false}>
                  <Text
                    text={text}
                    fontSize={14 / stageScale}
                    fill="#fff"
                    padding={4 / stageScale}
                    align="center"
                    offsetY={10 / stageScale}
                  />
                  <Text
                    text={text}
                    fontSize={14 / stageScale}
                    fill="#000"
                    padding={4 / stageScale}
                    align="center"
                    offsetY={10 / stageScale}
                    stroke="#fff"
                    strokeWidth={2 / stageScale}
                    fillAfterStrokeEnabled
                  />
                </Group>
              )}
              {selectedSegmentIdx === -1 && renderSegmentLabel()}
            </Group>
          )}
          {(m.segments ?? []).map((seg, segIdx) => {
            // Drag-adjusted points, shared with the compound Shape above via adjustPoints.
            const segPts = adjustedSegments[segIdx].points;
            const segDisplayPts = expandArcPoints(segPts, seg.arcMidIndices);
            const segFlat = segDisplayPts.flatMap(p => [p.x, p.y]);
            return (
              <Group
                key={`extra-seg-${segIdx}`}
                draggable={!readOnly && currentTool === 'pan' && !isMiddleMouseDown}
                onDragStart={(e) => segmentDragStart(e, segIdx)}
                onDragMove={(e) => segmentDragMove(e, segIdx)}
                onClick={(e) => handleSegmentClick(e, segIdx)}
                onTap={(e) => handleSegmentClick(e, segIdx)}
                onDragEnd={(e) => {
                  // I2 fix: clear before the readOnly early return (see above).
                  setDraggingSegment(null);
                  if (readOnly) return;
                  // Ignore drag-ends that bubbled up from a child (e.g. a vertex circle).
                  if (e.target !== e.currentTarget) return;
                  e.cancelBubble = true;
                  const dx = e.target.x();
                  const dy = e.target.y();
                  e.target.x(0);
                  e.target.y(0);
                  const newSegments = (m.segments ?? []).map((s, i) =>
                    i === segIdx
                      ? { ...s, points: s.points.map(p => ({ x: p.x + dx, y: p.y + dy })) }
                      : s
                  );
                  onUpdateMeasurement(m.id, { segments: newSegments });
                }}
              >
                {isSegmentSelected(segIdx) && (
                  <Line
                    points={segFlat}
                    stroke="#fbbf24"
                    strokeWidth={14 / stageScale}
                    opacity={0.55}
                    lineJoin="round"
                    lineCap="round"
                    closed={m.type === 'area'}
                    dash={[14 / stageScale, 8 / stageScale]}
                    listening={false}
                  />
                )}
                <Line
                  points={segFlat}
                  stroke={m.color}
                  strokeWidth={isSegmentSelected(segIdx) ? 8 / stageScale : 5 / stageScale}
                  hitStrokeWidth={20 / stageScale}
                  lineJoin="round"
                  lineCap="round"
                  closed={m.type === 'area'}
                  fill={m.type === 'area' && !hasHoles ? `${m.color}${isSegmentSelected(segIdx) ? '60' : '40'}` : undefined}
                  dash={seg.subtract ? [10 / stageScale, 7 / stageScale] : undefined}
                  shadowColor={isSegmentSelected(segIdx) ? '#fbbf24' : undefined}
                  shadowBlur={isSegmentSelected(segIdx) ? 18 / stageScale : 0}
                  shadowOpacity={isSegmentSelected(segIdx) ? 0.85 : 0}
                  onDblClick={(e) => {
                    e.cancelBubble = true;
                    const newPts = insertVertexAtClick(seg.points);
                    if (!newPts) return;
                    const newSegments = (m.segments ?? []).map((s, i) =>
                      i === segIdx ? { ...s, points: newPts } : s
                    );
                    onUpdateMeasurement(m.id, { segments: newSegments });
                  }}
                  onDblTap={(e) => {
                    e.cancelBubble = true;
                    const newPts = insertVertexAtClick(seg.points);
                    if (!newPts) return;
                    const newSegments = (m.segments ?? []).map((s, i) =>
                      i === segIdx ? { ...s, points: newPts } : s
                    );
                    onUpdateMeasurement(m.id, { segments: newSegments });
                  }}
                />
                {segPts.map((p, pi) => (
                  <Circle
                    key={pi}
                    x={p.x}
                    y={p.y}
                    radius={isSegmentSelected(segIdx) ? 8 / stageScale : 6 / stageScale}
                    fill={m.color}
                    stroke={isSegmentSelected(segIdx) ? '#fff' : undefined}
                    strokeWidth={isSegmentSelected(segIdx) ? 2 / stageScale : 0}
                    draggable={!readOnly && currentTool === 'pan' && !isMiddleMouseDown}
                    onDragStart={(e) => {
                      if (readOnly || (e.evt && e.evt.button !== 0) || isMiddleMouseDownRef.current) {
                        e.target.stopDrag();
                        return;
                      }
                      e.cancelBubble = true;
                      setDraggingPoint({ mId: m.id, idx: pi, segIdx, x: p.x, y: p.y });
                    }}
                    onDragMove={(e) => {
                      if (readOnly) return;
                      e.cancelBubble = true;
                      setDraggingPoint({ mId: m.id, idx: pi, segIdx, x: e.target.x(), y: e.target.y() });
                    }}
                    onDragEnd={(e) => {
                      // I2 fix: clear before the readOnly early return (see above).
                      setDraggingPoint(null);
                      if (readOnly) return;
                      e.cancelBubble = true;
                      const newX = e.target.x();
                      const newY = e.target.y();
                      const newSegments = (m.segments ?? []).map((s, i) => {
                        if (i !== segIdx) return s;
                        const newPts = [...s.points];
                        newPts[pi] = { x: newX, y: newY };
                        return { ...s, points: newPts };
                      });

                      // Reset the circle's position so it doesn't double-apply the offset
                      e.target.x(p.x);
                      e.target.y(p.y);

                      onUpdateMeasurement(m.id, { segments: newSegments });
                    }}
                    hitStrokeWidth={10 / stageScale}
                  />
                ))}
                {/* Inside the segment's subgroup so it follows a segment drag. */}
                {selectedSegmentIdx === segIdx && renderSegmentLabel()}
              </Group>
            );
          })}
        </Group>
      );
    });
  };

  const renderRegions = () => {
    if (!isMultiRegion) return null;
    return scaleRegions.map((r) => {
      const isSelected = r.id === selectedRegionId;
      const isCalibrating = r.id === calibratingRegionId;
      const isVisible = isSelected || isCalibrating || currentTool === 'region';
      const isInteractable = currentTool === 'pan' && isVisible;
      
      const flatPoints = r.points.flatMap(p => [p.x, p.y]);
      
      // Calculate center for text
      let centerX = 0, centerY = 0;
      r.points.forEach(p => { centerX += p.x; centerY += p.y; });
      centerX /= r.points.length;
      centerY /= r.points.length;

      return (
        <Group 
          key={r.id}
          visible={isVisible}
          listening={isInteractable}
          onClick={(e) => {
            if (currentTool === 'pan') {
              e.cancelBubble = true;
              onSelectRegion?.(isSelected ? null : r.id);
            } else if (currentTool === 'scale') {
              e.cancelBubble = true;
            }
          }}
        >
          <Line
            points={flatPoints}
            stroke={r.color}
            strokeWidth={2 / stageScale}
            dash={[10 / stageScale, 5 / stageScale]}
            closed={true}
            fill={`${r.color}15`}
            hitStrokeWidth={20 / stageScale}
          />
          <Group x={centerX} y={centerY}>
            <Text
              text={r.name + (r.scaleConfig ? ` (${r.scaleConfig.label || 'Calibrated'})` : ' (No Scale)')}
              fontSize={16 / stageScale}
              fill={r.color}
              align="center"
              fontStyle="bold"
            />
          </Group>
          {isSelected && r.points.map((p, i) => (
            <Circle
              key={i}
              x={p.x}
              y={p.y}
              radius={4 / stageScale}
              fill={r.color}
              draggable={currentTool === 'pan'}
              onDragMove={(e) => {
                const newPoints = [...r.points];
                newPoints[i] = { x: e.target.x(), y: e.target.y() };
                onUpdateRegion?.(r.id, { points: newPoints });
              }}
              onDragEnd={(e) => {
                e.target.x(p.x);
                e.target.y(p.y);
              }}
            />
          ))}
        </Group>
      );
    });
  };

  const renderLegend = () => {
    if (!showLegend || takeoffs.length === 0) return null;

    const legendItems: { color: string; name: string; total: string }[] = [];

    takeoffs.forEach(takeoff => {
      let totalRealValue = 0;
      let hasMeasurements = false;

      const measurementsToUse = pageMeasurements || measurements;

      measurementsToUse.filter(m => m.takeoffId === takeoff.id).forEach(m => {
        hasMeasurements = true;
        let currentScale = scaleConfig;
        if (isMultiRegion && m.regionId) {
          const region = scaleRegions.find(r => r.id === m.regionId);
          if (region?.scaleConfig) {
            currentScale = region.scaleConfig;
          }
        }

        const allMSegPts = [
          expandArcPoints(m.points, m.arcMidIndices),
          ...(m.segments ?? []).map(s => expandArcPoints(s.points, s.arcMidIndices)),
        ];
        let pixelValue = 0;
        if (takeoff.type === 'length' && m.type === 'length') {
          pixelValue = allMSegPts.reduce((sum, pts) => sum + calculatePolylineLength(pts), 0);
        } else if (takeoff.type === 'area' && m.type === 'area') {
          pixelValue = measurementAreaPx({ points: m.points, arcMidIndices: m.arcMidIndices, segments: m.segments });
        } else if (takeoff.type === 'area' && m.type === 'length') {
          pixelValue = allMSegPts.reduce((sum, pts) =>
            sum + calculateSurfaceAreaPx(pts, m.heights || [], m.isTwoSided || false, currentScale), 0);
        } else if (takeoff.type === 'count' && m.type === 'count') {
          pixelValue = 1;
        }

        if (pixelValue > 0) {
          const realValue = calculateRealValue(pixelValue, takeoff.type as 'length' | 'area' | 'count', currentScale);
          const targetUnit = takeoff.unit || scaleConfig?.unit || 'ft';
          const sourceUnit = currentScale?.unit || 'ft';

          if (takeoff.type === 'count') {
            totalRealValue += realValue;
          } else {
            const cleanTargetUnit = targetUnit.replace('sq ', '');
            totalRealValue += convertUnit(realValue, sourceUnit, cleanTargetUnit, takeoff.type as 'length' | 'area' | 'count') * measurementMultiplier(m);
          }
        }
      });

      if (hasMeasurements) {
        const targetUnit = takeoff.unit || scaleConfig?.unit || 'ft';
        const unitLabel = ` ${UNIT_LABELS[takeoff.type as keyof typeof UNIT_LABELS]?.[targetUnit] || targetUnit}`;
        const formattedTotal = takeoff.type === 'count' 
          ? Math.round(totalRealValue).toString() 
          : totalRealValue.toFixed(2);
        
        legendItems.push({
          color: takeoff.color,
          name: takeoff.name,
          total: showLegendTotals ? `${formattedTotal}${unitLabel}` : ''
        });
      }
    });

    if (legendItems.length === 0) return null;

    const padding = legendFontSize * 0.9;
    const itemHeight = legendFontSize * 1.7;
    const colorBoxSize = legendFontSize;
    const textOffsetX = colorBoxSize + Math.round(legendFontSize * 0.5);
    const width = legendWidth || 500;
    const headerH = padding * 2 + legendFontSize * 1.4;
    const height = headerH + legendItems.length * itemHeight + padding;
    const handleSize = Math.max(12, legendFontSize * 0.6);

    return (
      <Group
        x={legendPosition.x}
        y={legendPosition.y}
        draggable={!readOnly && currentTool === 'pan'}
        onDragEnd={(e) => {
          if (readOnly) return;
          if (e.target === e.currentTarget && onUpdateLegend) {
            onUpdateLegend({ position: { x: e.target.x(), y: e.target.y() } });
          }
        }}
        onMouseEnter={(e) => {
          if (currentTool === 'pan') {
            const container = e.target.getStage()?.container();
            if (container) container.style.cursor = 'grab';
          }
        }}
        onMouseLeave={(e) => {
          const container = e.target.getStage()?.container();
          if (container) container.style.cursor = 'crosshair';
        }}
        onWheel={(e) => {
          if (currentTool === 'pan') {
            e.cancelBubble = true;
            e.evt.preventDefault();
            const scaleBy = 1.05;
            const oldFontSize = legendFontSize;
            const newFontSize = e.evt.deltaY < 0 ? oldFontSize * scaleBy : oldFontSize / scaleBy;
            if (onUpdateLegend) {
              onUpdateLegend({
                fontSize: Math.max(8, Math.min(newFontSize, 120))
              });
            }
          }
        }}
      >
        {/* Shadow / outer card */}
        <Rect
          width={width}
          height={height}
          fill="white"
          stroke="#cbd5e1"
          strokeWidth={1}
          cornerRadius={8}
          shadowColor="black"
          shadowBlur={16}
          shadowOpacity={0.12}
          shadowOffset={{ x: 0, y: 4 }}
        />
        {/* Header background */}
        <Rect
          width={width}
          height={headerH}
          fill="#f1f5f9"
          cornerRadius={[8, 8, 0, 0]}
        />
        {/* Title */}
        <Text
          x={padding}
          y={padding * 0.8}
          text="Legend"
          fontSize={legendFontSize + 2}
          fontStyle="bold"
          fill="#1e293b"
        />
        {/* Separator */}
        <Line
          points={[0, headerH, width, headerH]}
          stroke="#e2e8f0"
          strokeWidth={1}
        />
        {legendItems.map((item, index) => (
          <Group key={index} y={headerH + padding * 0.5 + index * itemHeight}>
            <Rect
              x={padding}
              y={Math.round((itemHeight - colorBoxSize) / 2)}
              width={colorBoxSize}
              height={colorBoxSize}
              fill={item.color}
              cornerRadius={4}
            />
            <Text
              x={padding + textOffsetX}
              y={Math.round((itemHeight - legendFontSize) / 2)}
              text={item.name}
              fontSize={legendFontSize}
              fill="#334155"
              width={width - padding * 2 - textOffsetX - (showLegendTotals ? legendFontSize * 8 : 0)}
              ellipsis={true}
              wrap="none"
            />
            {showLegendTotals && (
              <Text
                x={width - padding - legendFontSize * 8}
                y={Math.round((itemHeight - legendFontSize) / 2)}
                text={item.total}
                fontSize={legendFontSize}
                fill="#0f172a"
                width={legendFontSize * 8}
                align="right"
                fontStyle="bold"
                wrap="none"
              />
            )}
          </Group>
        ))}
        {/* Resize handle — mutates legend size, so hidden in read-only history. */}
        {!readOnly && currentTool === 'pan' && (
          <Rect
            x={width - handleSize}
            y={height - handleSize}
            width={handleSize}
            height={handleSize}
            fill="#3b82f6"
            cornerRadius={[0, 0, 8, 0]}
            draggable
            onDragMove={(e) => {
              e.cancelBubble = true;
              const stage = e.target.getStage();
              if (!stage) return;
              const pointerPos = stage.getPointerPosition();
              if (!pointerPos) return;
              const newWidth = (pointerPos.x - stagePos.x) / stageScale - legendPosition.x;
              const newHeight = (pointerPos.y - stagePos.y) / stageScale - legendPosition.y;
              // height = headerH + items * itemHeight + padding
              // headerH = padding*2 + fontSize*1.4,  itemHeight = fontSize*1.7,  padding = fontSize*0.9
              // height = fontSize*(0.9*2 + 1.4) + items*fontSize*1.7 + fontSize*0.9 = fontSize*(4.1 + items*1.7)
              const newFontSize = newHeight / (4.1 + legendItems.length * 1.7);
              if (onUpdateLegend) {
                onUpdateLegend({
                  width: Math.max(150, newWidth),
                  fontSize: Math.max(8, newFontSize)
                });
              }
              e.target.x(width - handleSize);
              e.target.y(height - handleSize);
            }}
            onDragEnd={(e) => {
              e.cancelBubble = true;
              e.target.x(width - handleSize);
              e.target.y(height - handleSize);
            }}
            onMouseEnter={(e) => {
              const container = e.target.getStage()?.container();
              if (container) container.style.cursor = 'nwse-resize';
            }}
            onMouseLeave={(e) => {
              const container = e.target.getStage()?.container();
              if (container) container.style.cursor = currentTool === 'pan' ? 'grab' : 'crosshair';
            }}
          />
        )}
      </Group>
    );
  };

  return (
    <div ref={containerRef} className="w-full h-full bg-sunken overflow-hidden cursor-crosshair touch-none relative" onContextMenu={e => e.preventDefault()}>
      {contextMenu && (
        <div
          className="fixed z-[200] bg-raised rounded-xl shadow-xl border border-edge py-1 min-w-[160px]"
          style={{ left: contextMenu.x, top: contextMenu.y }}
          onMouseDown={e => e.stopPropagation()}
        >
          {contextMenu.measurementId && (
            <>
              <button
                className="w-full text-left px-4 py-2 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 flex items-center gap-2"
                onClick={() => { onDeleteMeasurement(contextMenu.measurementId!); setContextMenu(null); }}
              >
                <Trash2 size={14} /> Delete
              </button>
              {onCopy && (
                <button
                  className="w-full text-left px-4 py-2 text-sm text-ink hover:bg-hover flex items-center gap-2"
                  onClick={() => { onCopy(); setContextMenu(null); }}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>
                  Copy
                </button>
              )}
              <div className="h-px bg-edge my-1" />
            </>
          )}
          {onUndo && (
            <button
              className="w-full text-left px-4 py-2 text-sm text-ink hover:bg-hover flex items-center gap-2"
              onClick={() => { onUndo(); setContextMenu(null); }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-9-9 9 9 0 0 0-6 2.3L3 13"/></svg>
              Undo
            </button>
          )}
          {onRedo && (
            <button
              className="w-full text-left px-4 py-2 text-sm text-ink hover:bg-hover flex items-center gap-2"
              onClick={() => { onRedo(); setContextMenu(null); }}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 9-9 9 9 0 0 1 6 2.3L21 13"/></svg>
              Redo
            </button>
          )}
          {onPaste && (
            <button
              className="w-full text-left px-4 py-2 text-sm text-ink hover:bg-hover flex items-center gap-2 disabled:opacity-40"
              onClick={() => { onPaste(); setContextMenu(null); }}
              disabled={!hasCopied}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/><rect x="8" y="2" width="8" height="4" rx="1" ry="1"/></svg>
              Paste
            </button>
          )}
          {activePoints.length > 0 && (
            <>
              <div className="h-px bg-edge my-1" />
              <button
                className="w-full text-left px-4 py-2 text-sm text-ink hover:bg-hover"
                onClick={() => { cancelDrawing(); setContextMenu(null); }}
              >
                Cancel Drawing
              </button>
            </>
          )}
        </div>
      )}
      {isSearching && (
        <div className="absolute top-4 left-1/2 -translate-x-1/2 glass-panel border border-edge rounded-full px-4 py-2 shadow-lg z-50 flex items-center gap-2">
          <div className="w-4 h-4 border-2 border-accent-600 border-t-transparent rounded-full animate-spin" />
          <span className="text-sm font-medium text-ink">Searching...</span>
        </div>
      )}
      {!!sourcePdfUrl && !pdfImage && (
        <div className="absolute inset-0 z-40 flex items-center justify-center pointer-events-none">
          <div
            data-testid="pdf-loading-overlay"
            className="flex items-center gap-2 rounded-full bg-raised px-4 py-2 text-sm font-medium text-ink-soft shadow-lg"
          >
            <div className="w-4 h-4 border-2 border-accent-600 border-t-transparent rounded-full animate-spin" />
            <span>
              {pdfLoadProgress && pdfLoadProgress.total
                ? `Loading sheet… ${Math.round((pdfLoadProgress.loaded / pdfLoadProgress.total) * 100)}%`
                : 'Loading sheet…'}
            </span>
          </div>
        </div>
      )}
      {dimensions.width > 0 && dimensions.height > 0 && (
        <>
          {/* Zoom Toolbar */}
          <div className="absolute bottom-20 md:bottom-6 left-1/2 -translate-x-1/2 flex items-center glass-panel border border-edge rounded-full shadow-lg px-2 py-1.5 z-30 gap-1">
            <button
              onClick={handleZoomOut}
              className="p-2 text-ink-soft hover:text-accent-600 hover:bg-hover rounded-full transition-colors"
              title="Zoom Out"
            >
              <ZoomOut size={18} />
            </button>
            
            <div className="px-2 min-w-[60px] text-center text-sm font-semibold text-ink select-none">
              {Math.round(stageScale * 100)}%
            </div>
            
            <button
              onClick={handleZoomIn}
              className="p-2 text-ink-soft hover:text-accent-600 hover:bg-hover rounded-full transition-colors"
              title="Zoom In"
            >
              <ZoomIn size={18} />
            </button>
            
            <div className="w-px h-4 bg-edge mx-1" />
            
            <button
              onClick={handleResetView}
              className="p-2 text-ink-soft hover:text-accent-600 hover:bg-hover rounded-full transition-colors"
              title="Reset View"
            >
              <RotateCcw size={18} />
            </button>
          </div>

          <Stage
          ref={stageRef}
          width={dimensions.width}
          height={dimensions.height}
          onWheel={handleWheel}
          onMouseMove={handleMouseMove}
          onMouseDown={handleMouseDown}
          onMouseUp={handleMouseUp}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onContextMenu={(e) => {
            e.evt.preventDefault();
            setContextMenu({ x: e.evt.clientX, y: e.evt.clientY, measurementId: null });
          }}
          onDblTap={(e) => {
            // Touch equivalent of pressing Enter: double-tapping the empty
            // stage finishes the in-progress length/area segment (or closes a
            // region). Mirrors the keyboard Enter handler. Only acts on the
            // background — double-taps on a Line still insert a vertex.
            const onBackground = e.target === stageRef.current || e.target.name() === 'backgroundImage';
            if (!onBackground) return;
            if (activePoints.length <= 1) return;
            if (currentTool === 'length' || isAreaLikeTool) {
              finalizeSegment();
            } else if (currentTool === 'region' && activePoints.length > 2) {
              const newRegion: ScaleRegion = {
                id: uuidv4(),
                name: `Region ${scaleRegions.length + 1}`,
                points: [...activePoints],
                scaleConfig: null,
                color: '#8b5cf6',
              };
              onAddRegion?.(newRegion);
              setActivePoints([]);
              setMousePos(null);
            }
          }}
          onDragEnd={(e) => {
            if (e.target === e.currentTarget) {
              setStagePos({ x: e.target.x(), y: e.target.y() });
            }
          }}
          draggable={currentTool === 'pan' && !isTouchDevice}
          scaleX={stageScale}
          scaleY={stageScale}
          x={stagePos.x}
          y={stagePos.y}
          className={currentTool === 'pan' || isMiddleMouseDown ? 'cursor-grab active:cursor-grabbing' : 'cursor-crosshair'}
        >
          <Layer>
            {image ? (
              <KonvaImage
                image={image}
                name="backgroundImage"
                width={imageWidth}
                height={imageHeight}
              />
            ) : thumbImage && (
              // Vector page still fetching/rendering its source PDF — show
              // the (already-cached, much smaller) thumbnail in its place so
              // the sheet isn't a blank white rectangle for the duration.
              <KonvaImage
                image={thumbImage}
                name="backgroundImage"
                width={imageWidth}
                height={imageHeight}
                opacity={0.6}
                listening={false}
              />
            )}
            {searchHighlights.map((bbox, i) => (
              <Rect
                key={`highlight-${i}`}
                x={bbox.x0}
                y={bbox.y0}
                width={bbox.x1 - bbox.x0}
                height={bbox.y1 - bbox.y0}
                fill="rgba(255, 255, 0, 0.4)"
                stroke="rgba(255, 200, 0, 0.8)"
                strokeWidth={2 / stageScale}
                cornerRadius={2 / stageScale}
              />
            ))}
            {pageRefs.map((ref, i) => {
              const isHover = hoveredRefIdx === i;
              const interactive = currentTool === 'pan';
              // Small padding makes the hit area + visual a bit larger than
              // the raw glyph bbox, which is usually flush against the
              // letters. Section-marker page numbers are typically tiny, so
              // a few px of slack helps both hover-targeting and visibility.
              const pad = Math.max(2, 4 / stageScale);
              return (
                <Rect
                  key={`pageref-${i}`}
                  x={ref.x - pad}
                  y={ref.y - pad}
                  width={ref.width + pad * 2}
                  height={ref.height + pad * 2}
                  fill={isHover ? 'rgba(59, 130, 246, 0.3)' : 'rgba(59, 130, 246, 0.08)'}
                  stroke="rgba(59, 130, 246, 0.7)"
                  strokeWidth={(isHover ? 2 : 1) / stageScale}
                  cornerRadius={3 / stageScale}
                  listening={interactive}
                  onClick={(e) => {
                    e.cancelBubble = true;
                    onPageReferenceClick?.(ref.pageId);
                  }}
                  onTap={(e) => {
                    e.cancelBubble = true;
                    onPageReferenceClick?.(ref.pageId);
                  }}
                  onMouseEnter={(e) => {
                    setHoveredRefIdx(i);
                    const stage = e.target.getStage();
                    if (stage) stage.container().style.cursor = 'pointer';
                  }}
                  onMouseLeave={(e) => {
                    setHoveredRefIdx(null);
                    const stage = e.target.getStage();
                    if (stage) {
                      // Restore whatever cursor the surrounding tool wants.
                      stage.container().style.cursor =
                        currentTool === 'pan' ? 'grab' : 'crosshair';
                    }
                  }}
                />
              );
            })}
            {renderRegions()}
            {renderMeasurements()}
            {renderActiveDrawing()}
            {renderLegend()}
          </Layer>
          <Layer>
            {/* Remote Cursors. Hide anonymous sessions; each session gets its
                own cursor (a user with two open tabs on this page shows two).
                Position/opacity are smoothed by RemoteCursor via a per-cursor
                rAF lerp loop (reducedMotion binds directly instead) — see
                the component above for the full rationale. */}
            {remoteUsers
              .filter((u: any) => u.id !== currentUserId && u.cursor && u.userId)
              .map((u: any) => (
                <RemoteCursor key={u.id} user={u} stageScale={stageScale} reducedMotion={reducedMotion} />
              ))}
          </Layer>
          {selectedMeasurementId && window.innerWidth < 768 && (
            <Layer>
              {(() => {
                const center = getSelectedMeasurementCenter();
                if (!center) return null;
                
                return (
                  <Html
                    divProps={{
                      style: {
                        position: 'absolute',
                        left: `${center.x * stageScale + stagePos.x}px`,
                        top: `${center.y * stageScale + stagePos.y - 60}px`,
                        transform: 'translateX(-50%)',
                        pointerEvents: 'auto',
                      }
                    }}
                  >
                    <div className="flex items-center gap-1 glass-panel border border-edge rounded-full p-1 shadow-xl z-50 ring-1 ring-black/5">
                      <button
                        onClick={() => onDeleteMeasurement(selectedMeasurementId)}
                        className="p-2.5 text-red-500 hover:bg-red-50 rounded-full active:scale-90 transition-all"
                        title="Delete"
                      >
                        <Trash2 size={20} />
                      </button>
                      <div className="w-px h-5 bg-edge mx-0.5" />
                      <button
                        onClick={() => onSelectMeasurement(null)}
                        className="p-2.5 text-ink-soft hover:bg-hover rounded-full active:scale-90 transition-all"
                        title="Deselect"
                      >
                        <X size={20} />
                      </button>
                    </div>
                  </Html>
                );
              })()}
            </Layer>
          )}
      </Stage>
        </>
      )}
    </div>
  );
};
