import React, { useState, useEffect, useMemo, useRef } from 'react';
import { useParams, useNavigate, Link, useLocation, useSearchParams } from 'react-router-dom';
import { Hand, Ruler, Square, SquareMinus, Settings, Trash2, Download, ArrowLeft, Layers, Plus, Hash, Undo, Redo, ChevronLeft, ChevronRight, Menu, StickyNote, HelpCircle, BoxSelect, AlignStartVertical, AlignEndVertical, History } from 'lucide-react';
import { useToast } from '../components/Toast';
import { v4 as uuidv4 } from 'uuid';
import { PdfCanvas } from '../components/PdfCanvas';
import { NewTakeoffModal } from '../components/NewTakeoffModal';
import { ScaleCalibrationModal } from '../components/canvas/ScaleCalibrationModal';
import { KeyboardShortcutsModal } from '../components/canvas/KeyboardShortcutsModal';
import { ToolDisabledModal } from '../components/canvas/ToolDisabledModal';
import { MeasurementSidebar } from '../components/canvas/MeasurementSidebar';
import { SelectionInfoBar } from '../components/canvas/SelectionInfoBar';
import { Measurement, MeasurementSegment, ScaleConfig, Tool, Project, ProjectPage, MeasurementTakeoff, TakeoffTemplate, CustomCost } from '../types';
import { calculatePolylineLength, measurementAreaPx, calculateRealValue, parseFeetAndInches, calculateSurfaceAreaPx, convertUnit, evaluateMathExpression, UNIT_LABELS, isPointInPolygon, expandArcPoints } from '../utils/math';
import { getProject, saveProject, getImage, getImageUrl, getTemplates, noteProjectVersion } from '../utils/store';
import { CollaborationProvider, useCollaboration } from '../context/CollaborationContext';
import { useNotes } from '../context/NotesContext';
import { CustomCostRow } from '../components/CustomCostRow';
import { useMeasurementHistory } from '../hooks/useMeasurementHistory';
import { computeRevisionModel, effectiveSheetId } from '../utils/planSets';
import { summarizeSelection } from '../utils/segmentValue';
import { measurementMultiplier, multiplierPatch, multipliersMatch } from '../utils/multiplier';
import { MultiplierModal } from '../components/canvas/MultiplierModal';
import { computeTakeoffTotals } from './project/proposal/proposalGenerator';
import { CLIENT_SESSION_ID } from '../utils/clientSession';
import { NumberInput } from '../components/ui';

const STANDARD_SCALES = [
  { label: '1/32" = 1\'-0"', pixelDistance: 144, realWorldDistance: 32, unit: 'ft' },
  { label: '3/64" = 1\'-0"', pixelDistance: 144, realWorldDistance: 64/3, unit: 'ft' },
  { label: '1/16" = 1\'-0"', pixelDistance: 144, realWorldDistance: 16, unit: 'ft' },
  { label: '3/32" = 1\'-0"', pixelDistance: 144, realWorldDistance: 32/3, unit: 'ft' },
  { label: '1/8" = 1\'-0"', pixelDistance: 144, realWorldDistance: 8, unit: 'ft' },
  { label: '3/16" = 1\'-0"', pixelDistance: 144, realWorldDistance: 16/3, unit: 'ft' },
  { label: '1/4" = 1\'-0"', pixelDistance: 144, realWorldDistance: 4, unit: 'ft' },
  { label: '3/8" = 1\'-0"', pixelDistance: 144, realWorldDistance: 8/3, unit: 'ft' },
  { label: '1/2" = 1\'-0"', pixelDistance: 144, realWorldDistance: 2, unit: 'ft' },
  { label: '3/4" = 1\'-0"', pixelDistance: 144, realWorldDistance: 4/3, unit: 'ft' },
  { label: '1" = 1\'-0"', pixelDistance: 144, realWorldDistance: 1, unit: 'ft' },
  { label: '1 1/2" = 1\'-0"', pixelDistance: 144, realWorldDistance: 2/3, unit: 'ft' },
  { label: '3" = 1\'-0"', pixelDistance: 144, realWorldDistance: 1/3, unit: 'ft' },
  { label: '6" = 1\'-0"', pixelDistance: 144, realWorldDistance: 1/6, unit: 'ft' },
  { label: '1" = 10\'', pixelDistance: 144, realWorldDistance: 10, unit: 'ft' },
  { label: '1" = 20\'', pixelDistance: 144, realWorldDistance: 20, unit: 'ft' },
  { label: '1" = 30\'', pixelDistance: 144, realWorldDistance: 30, unit: 'ft' },
  { label: '1" = 40\'', pixelDistance: 144, realWorldDistance: 40, unit: 'ft' },
  { label: '1" = 50\'', pixelDistance: 144, realWorldDistance: 50, unit: 'ft' },
  { label: '1" = 60\'', pixelDistance: 144, realWorldDistance: 60, unit: 'ft' },
  { label: '1" = 100\'', pixelDistance: 144, realWorldDistance: 100, unit: 'ft' },
  { label: '1" = 200\'', pixelDistance: 144, realWorldDistance: 200, unit: 'ft' },
];

const CanvasViewInner: React.FC = () => {
  const { toast } = useToast();
  const { openNotes } = useNotes();
  const { projectId, pageId } = useParams<{ projectId: string; pageId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const searchTerm = searchParams.get('search') || '';
  
  const { socket, users, sendCursor, sendMeasurementOp, joinCanvas, onMeasurementApplied, setPageName } = useCollaboration();

  const [project, setProject] = useState<Project | null>(null);
  const [page, setPage] = useState<ProjectPage | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  const pageIds = (location.state?.pageIds as string[]) || project?.pages.map(p => p.id) || [];
  const currentPageIndex = pageIds.findIndex(id => id === pageId);
  const prevPageId = currentPageIndex > 0 ? pageIds[currentPageIndex - 1] : null;
  const nextPageId = currentPageIndex !== -1 && currentPageIndex < pageIds.length - 1 ? pageIds[currentPageIndex + 1] : null;

  useEffect(() => {
    if (project && pageId) {
      const currentPage = project.pages.find(p => p.id === pageId);
      if (currentPage) {
        setPageName(currentPage.name);
      }
    }
  }, [project, pageId, setPageName]);
  
  const [currentTool, setCurrentTool] = useState<Tool>('pan');

  // Phone = read-only canvas (Phase 8). Matches the app shell's `isMobile`
  // breakpoint (≤767px). On phones we keep pan / pinch-zoom / tap-select / view
  // and the measurement sidebar, but disable drawing-tool SELECTION
  // (Length/Area/Count/Region/Scale-draw). Tablets (≥md) keep full drawing.
  const [isPhone, setIsPhone] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const handler = (e: MediaQueryListEvent) => setIsPhone(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);
  const [readOnlyBannerDismissed, setReadOnlyBannerDismissed] = useState(false);

  // Task 5: mirrors PdfCanvas's in-progress drawing buffer (activePoints /
  // arc sub-state). Read via a ref (not just the state) so async callbacks
  // (backfill, the entity-changed reload) always see the CURRENT value
  // instead of whatever was captured when the effect/closure was created.
  const [isDrawingActive, setIsDrawingActive] = useState(false);
  const isDrawingActiveRef = useRef(false);
  useEffect(() => { isDrawingActiveRef.current = isDrawingActive; }, [isDrawingActive]);

  // Mirrors `project` for the same stale-closure reason — the entity-changed
  // socket listener (item 6) needs the CURRENT project.version to decide
  // whether an incoming change is foreign or self-echo from our own op traffic.
  const projectRef = useRef<Project | null>(null);
  useEffect(() => { projectRef.current = project; }, [project]);

  // I3 fix: throttles the offline-op warning toast to at most once per 30s,
  // so a burst of ops queued while disconnected doesn't spam a toast per op.
  const lastOfflineToastRef = useRef(0);

  // Fix round 1 (F2): every version-adopting update goes through this so
  // projectRef.current is updated SYNCHRONOUSLY, not just via the passive
  // mirroring effect above. Without this, a measurement op's ack and its
  // paired entity-changed broadcast can both process within the same JS
  // turn (before React re-renders and the effect fires) — the entity-changed
  // gate would then read a stale projectRef.current and schedule a redundant
  // reload. `updater` uses Math.max on version fields itself (callers pass
  // the bump inline) so an out-of-order/duplicate event can never regress
  // the adopted version.
  const applyProjectUpdate = (updater: (prev: Project) => Project) => {
    if (projectRef.current) projectRef.current = updater(projectRef.current);
    setProject(prev => (prev ? updater(prev) : prev));
  };

  // Superseded-revision read-only gate (Plan Set rework Task 8). When the opened
  // page is an OLDER revision of its sheet, it is frozen history: drawing/editing
  // is disabled (mirrors the phone read-only gate), but pan/zoom/view and the
  // frozen measurements still render. The current/unique revision stays fully
  // editable. We derive this positionally via computeRevisionModel(project,'').
  const supersededInfo = useMemo(() => {
    if (!project || !pageId) return { isSuperseded: false, revNumber: 1, currentPageId: null as string | null };
    const model = computeRevisionModel(project, '');
    const isSuperseded = model.status(pageId) === 'superseded';
    const revNumber = model.revisionNumberByPageId.get(pageId) || 1;
    const page = project.pages.find(p => p.id === pageId);
    const currentPageId = page ? (model.latestPageIdBySheet.get(effectiveSheetId(page)) ?? null) : null;
    return { isSuperseded, revNumber, currentPageId };
  }, [project, pageId]);
  const isSupersededRevision = supersededInfo.isSuperseded;

  // Unified read-only flag: phones OR a frozen older revision. Used to gate all
  // drawing-tool selection + drawing/scale handlers below.
  const readOnly = isPhone || isSupersededRevision;

  // If we enter a read-only state (phone width or a superseded revision) while a
  // drawing tool is active, fall back to pan so the canvas stays coherent.
  useEffect(() => {
    if (readOnly && currentTool !== 'pan') setCurrentTool('pan');
  }, [readOnly, currentTool]);
  // Touch devices don't surface `title` tooltips and finish drawing via
  // double-tap rather than a keyboard, so the instruction copy adapts.
  const isTouchDevice = typeof window !== 'undefined' && ('ontouchstart' in window || navigator.maxTouchPoints > 0);
  const finishHint = isTouchDevice ? 'Double-tap to finish.' : 'Double-click or press Enter to finish.';
  const READ_ONLY_MESSAGE = 'Viewing only on small screens — open this page on a tablet or computer to draw takeoffs.';
  const SUPERSEDED_MESSAGE = `Viewing Rev ${supersededInfo.revNumber} — read-only history. Open the current revision to edit takeoffs.`;
  // Re-surface the banner if it was dismissed, so a tap on a locked tool always
  // explains why nothing happened. Superseded revisions take precedence in the
  // message (the page is frozen history regardless of screen size).
  const handlePhoneToolBlocked = () => {
    setReadOnlyBannerDismissed(false);
    setToolDisabledMessage(isSupersededRevision ? SUPERSEDED_MESSAGE : READ_ONLY_MESSAGE);
  };

  const [showScaleModal, setShowScaleModal] = useState(false);
  const [pendingPixelDistance, setPendingPixelDistance] = useState<number>(0);
  const [scaleInput, setScaleInput] = useState('10');
  const [scaleUnit, setScaleUnit] = useState('ft');
  const [calibratingRegionId, setCalibratingRegionId] = useState<string | null>(null);
  
  const [selectedColor, setSelectedColor] = useState('#3b82f6');
  const [selectedTakeoffId, setSelectedTakeoffId] = useState<string | undefined>(undefined);
  const [selectedMeasurementId, setSelectedMeasurementId] = useState<string | null>(null);
  const [selectedRegionId, setSelectedRegionId] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [measurementToDelete, setMeasurementToDelete] = useState<{id: string, targetPageId?: string} | null>(null);

  const [showTakeoffModal, setShowTakeoffModal] = useState(false);
  const [templates, setTemplates] = useState<TakeoffTemplate[]>([]);

  const [editingTakeoff, setEditingTakeoff] = useState<MeasurementTakeoff | null>(null);
  const [takeoffToDelete, setTakeoffToDelete] = useState<MeasurementTakeoff | null>(null);
  const [editTakeoffName, setEditTakeoffName] = useState('');
  const [editTakeoffColor, setEditTakeoffColor] = useState('');
  const [editTakeoffUnit, setEditTakeoffUnit] = useState('');
  const [editTakeoffCostPerUnit, setEditTakeoffCostPerUnit] = useState<string>('');
  const [isEditTakeoffAdvanced, setIsEditTakeoffAdvanced] = useState(false);
  const [editTakeoffCustomCosts, setEditTakeoffCustomCosts] = useState<any[]>([]);

  const [showCurrentPageOnly, setShowCurrentPageOnly] = useState(false);

  const [measurementFilter, setMeasurementFilter] = useState('');
  const [showPageJump, setShowPageJump] = useState(false);
  const [showShortcutsHelp, setShowShortcutsHelp] = useState(false);
  const [resumeMeasurement, setResumeMeasurement] = useState<Measurement | null>(null);
  const [resumeSegmentIdx, setResumeSegmentIdx] = useState<number>(-1);
  // Which segment of the selected measurement is highlighted on canvas.
  // null = whole measurement (sidebar selection); -1 = primary segment; 0+ = m.segments[i].
  const [selectedSegmentIdx, setSelectedSegmentIdx] = useState<number | null>(null);
  const [newMeasurementModal, setNewMeasurementModal] = useState<{ takeoffId: string } | null>(null);
  const [newMeasurementName, setNewMeasurementName] = useState('');
  const [newMeasurementType, setNewMeasurementType] = useState<'length' | 'area'>('area');
  const [multiSelectedIds, setMultiSelectedIds] = useState<Set<string>>(new Set());
  const [isMultiSelectMode, setIsMultiSelectMode] = useState(false);

  // Clear multi-select when switching to a drawing tool
  useEffect(() => {
    if (currentTool === 'length' || currentTool === 'area' || currentTool === 'subtract' || currentTool === 'count' || currentTool === 'scale') {
      setMultiSelectedIds(new Set());
      setIsMultiSelectMode(false);
    }
  }, [currentTool]);
  const [aggregatedMeasurements, setAggregatedMeasurements] = useState<Measurement[]>([]);

  const [heightsModalMeasurementId, setHeightsModalMeasurementId] = useState<string | null>(null);
  const [multiplierModalMeasurementId, setMultiplierModalMeasurementId] = useState<string | null>(null);
  const [toolDisabledMessage, setToolDisabledMessage] = useState<string | null>(null);

  const [isLeftSidebarOpen, setIsLeftSidebarOpen] = useState(false);
  const [isRightSidebarOpen, setIsRightSidebarOpen] = useState(window.innerWidth > 1024);
  const [expandedTakeoffs, setExpandedTakeoffs] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const handleResize = () => {
      if (window.innerWidth < 1024) {
        // Don't automatically close if user explicitly opened it,
        // but for initial load or large resizes it's helpful
      }
    };
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  const handleCopy = () => {
    if (!selectedMeasurementId) return;
    const measurement = aggregatedMeasurements.find(m => m.id === selectedMeasurementId);
    if (measurement) {
      localStorage.setItem('copiedMeasurement', JSON.stringify(measurement));
      toast(`Copied "${measurement.name}"`, { type: 'success', duration: 1500 });
    }
  };

  const handlePaste = () => {
    // Frozen history / phone read-only: pasting would create a new measurement.
    if (readOnly) return;
    const copiedStr = localStorage.getItem('copiedMeasurement');
    if (!copiedStr || !page) return;
    try {
      const copiedMeasurement = JSON.parse(copiedStr) as Measurement;
      const isMultiRegionValid = page.isMultiRegion && page.scaleRegions && page.scaleRegions.length > 0;
      if (!page.scaleConfig && !isMultiRegionValid) {
        setToolDisabledMessage('Please set the scale before pasting.');
        return;
      }
      const offset = 20;
      const newPoints = copiedMeasurement.points.map(p => ({ x: p.x + offset, y: p.y + offset }));
      let regionId: string | undefined = undefined;
      if (page.isMultiRegion && page.scaleRegions) {
        const region = page.scaleRegions.find(r => isPointInPolygon(newPoints[0], r.points));
        if (region) regionId = region.id;
      }
      const newMeasurement: Measurement = {
        ...copiedMeasurement,
        id: uuidv4(),
        name: `${copiedMeasurement.name} (Copy)`,
        points: newPoints,
        planSetId: page.planSetId,
        regionId,
      };
      pushToHistory({ type: 'add', measurement: newMeasurement });
      // Measurement-only mutation — no other page/takeoff state changes, so
      // the project PUT is dropped in favor of the op (contract item 1).
      applyLocalMeasurements(page.id, [...page.measurements, newMeasurement]);
      void sendMeasurementOp({ projectId: projectId!, pageId: page.id, action: 'add', measurement: newMeasurement as unknown as Record<string, unknown> & { id: string } })
        .then(handleMeasurementOpResult);
      setSelectedMeasurementId(newMeasurement.id);
      toast('Measurement pasted', { type: 'success', duration: 1500 });
    } catch (err) {
      console.error('Failed to parse copied measurement', err);
    }
  };

  const handleMultiSelectToggle = (id: string, type: string) => {
    setMultiSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
        return next;
      }
      // Enforce same type — can't mix lengths and areas
      const existing = [...next].map(eid => page?.measurements.find(m => m.id === eid));
      const existingType = existing[0]?.type;
      if (existingType && existingType !== type) return prev;
      next.add(id);
      return next;
    });
  };

  const handleMergeSelected = () => {
    if (!page || multiSelectedIds.size < 2) return;
    const selectedMs = page.measurements.filter(m => multiSelectedIds.has(m.id));
    if (selectedMs.length < 2) return;

    const measurementType = selectedMs[0].type;

    const sidebarM = selectedMeasurementId
      ? page.measurements.find(m => m.id === selectedMeasurementId)
      : null;

    const target = sidebarM && sidebarM.type === measurementType ? sidebarM : selectedMs[0];
    const createNew = !sidebarM || sidebarM.type !== measurementType;

    // A multiplier counts the whole measurement N times, so folding in a
    // measurement that counts a different number of times would change it.
    if (!multipliersMatch([target, ...selectedMs])) {
      toast('These measurements have different multipliers, so they can\'t be merged. Give them the same multiplier first.', { type: 'warning' });
      return;
    }

    // Measurements whose segments will be folded into target
    const sources = createNew
      ? selectedMs.filter(m => m.id !== target.id)
      : selectedMs;

    const mergedSegments: MeasurementSegment[] = [
      ...(target.segments ?? []),
      ...sources.flatMap(m => [
        { points: m.points, arcMidIndices: m.arcMidIndices } as MeasurementSegment,
        ...(m.segments ?? []),
      ]),
    ];

    updateMeasurement(
      target.id,
      {
        segments: mergedSegments.length > 0 ? mergedSegments : undefined,
        ...(createNew ? { name: `Merged ${measurementType === 'length' ? 'Length' : 'Area'}` } : {}),
      },
    );

    // Delete source measurements (keep target)
    for (const m of sources.filter(m => m.id !== target.id)) {
      deleteMeasurement(m.id);
    }

    setMultiSelectedIds(new Set());
    setIsMultiSelectMode(false);
    setSelectedMeasurementId(target.id);
  };

  useEffect(() => {
    if (projectId && pageId) {
      loadData(projectId, pageId).then(ok => {
        if (ok) backfillMeasurements(projectId, pageId);
      });
    }
    loadTemplates();
  }, [projectId, pageId]);

  useEffect(() => {
    const unsubscribeMeasurement = onMeasurementApplied((ev) => {
      // Contract item 2: ALWAYS adopt the version, even for a cross-page op —
      // it still bumped the shared project version, and skipping adoption
      // here would make this tab's next full-project PUT 409 unnecessarily.
      // Goes through applyProjectUpdate (F2 fix) so projectRef.current is
      // fresh synchronously for the entity-changed gate.
      if (projectId) noteProjectVersion(projectId, ev.version);

      const { action, measurement } = ev;

      // C1 fix: the project-level splice below must target ev.pageId for
      // EVERY event, not just same-page ones — otherwise a cross-page op
      // adopts the new version WITHOUT the measurement ever landing in
      // project.pages, so this tab's next full-project PUT (scale, takeoffs,
      // regions, ...) round-trips through decomposeProject with a stale
      // page.measurements array and deletes the other page's measurement.
      // The setPage splice stays gated to the currently-open page — its
      // measurements array is a different page's data otherwise.
      if (ev.pageId === pageId) {
        setPage(prev => {
          if (!prev) return prev;
          let newMeasurements = [...prev.measurements];
          if (action === 'add') {
            // Prevent duplicates
            if (!newMeasurements.find(m => m.id === measurement.id)) {
              newMeasurements.push(measurement);
            }
          } else if (action === 'update') {
            newMeasurements = newMeasurements.map(m => m.id === measurement.id ? measurement : m);
          } else if (action === 'delete') {
            newMeasurements = newMeasurements.filter(m => m.id !== measurement.id);
          }
          return { ...prev, measurements: newMeasurements };
        });
      }

      applyProjectUpdate(prev => ({
        ...prev,
        version: Math.max(prev.version ?? 0, ev.version),
        pages: prev.pages.map(p => {
          if (p.id !== ev.pageId) return p;
          let newMeasurements = [...p.measurements];
          if (action === 'add') {
            if (!newMeasurements.find(m => m.id === measurement.id)) {
              newMeasurements.push(measurement);
            }
          } else if (action === 'update') {
            newMeasurements = newMeasurements.map(m => m.id === measurement.id ? measurement : m);
          } else if (action === 'delete') {
            newMeasurements = newMeasurements.filter(m => m.id !== measurement.id);
          }
          return { ...p, measurements: newMeasurements };
        })
      }));
    });

    return () => {
      unsubscribeMeasurement();
    };
  }, [projectId, pageId, onMeasurementApplied]);

  // Contract item 3 (backfill): hydrates this page's measurements from the
  // server on initial load and on every socket reconnect, so a client that
  // missed live ops while disconnected (or just navigated in) converges on
  // the authoritative measurement set. Guarded against clobbering an
  // in-flight local drawing — read via the ref so a stale closure from an
  // earlier render can't skip a guard that's since become true.
  const backfillMeasurements = async (pId: string, pgId: string) => {
    if (isDrawingActiveRef.current) return;
    const res = await joinCanvas(pId, pgId);
    if (!res.ok) return;
    if (isDrawingActiveRef.current) return; // re-check: drawing may have started while awaiting
    noteProjectVersion(pId, res.version);
    setPage(prev => (prev && prev.id === pgId) ? { ...prev, measurements: res.measurements } : prev);
    applyProjectUpdate(prev => ({
      ...prev,
      version: Math.max(prev.version ?? 0, res.version),
      pages: prev.pages.map(p => p.id === pgId ? { ...p, measurements: res.measurements } : p),
    }));
  };

  useEffect(() => {
    if (!socket || !projectId || !pageId) return;
    // C1 fix: match the initial-mount order (loadData THEN backfill). A
    // reconnect can follow a disconnect gap long enough for cross-page ops
    // to have landed server-side; backfill alone only re-hydrates the
    // CURRENT page's measurements, leaving this tab's project.pages (and any
    // other open page) at a healed version but stale cross-page data.
    //
    // WS4 regression fix: this handler used to fire on the socket's very
    // FIRST connection too (it hadn't finished connecting yet at mount, so
    // 'connect' lands ~1s later) — that ran loadData a second time on every
    // page open, which for vector pages restarts the source-PDF /raw fetch
    // and aborts the first in-flight one. Aborted downloads never populate
    // the HTTP cache, so large plan-set PDFs that used to load instantly
    // from cache re-downloaded in full on every visit. sawConnect tracks
    // whether we've already observed a connection; only a TRUE reconnect
    // (sawConnect already true) re-runs loadData. The very first connection
    // still needs a backfill, since the mount-path backfill above may have
    // run while the socket was still connecting and resolved {ok:false}.
    let sawConnect = socket.connected;
    const onConnect = () => {
      if (!sawConnect) {
        sawConnect = true;
        backfillMeasurements(projectId, pageId);
        return;
      }
      loadData(projectId, pageId).then(ok => {
        if (ok) backfillMeasurements(projectId, pageId);
      });
    };
    socket.on('connect', onConnect);
    return () => { socket.off('connect', onConnect); };
  }, [socket, projectId, pageId]);

  // Contract item 6 (owner-requested addition): foreign, non-measurement
  // project changes (scale recalibration, takeoff add/rename, page rename)
  // still go through the full project PUT, so they don't arrive via
  // onMeasurementApplied. Subscribe to the raw entity-changed change feed and
  // debounce a reload — but skip self-echo AND any version we've already
  // adopted, since measurement ops adopt their version via the ack/
  // measurement-applied handler BEFORE the paired entity-changed broadcast
  // arrives; without this check every own-op would trigger a redundant reload.
  useEffect(() => {
    if (!socket || !projectId || !pageId) return;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const onEntityChanged = (ev: { type: string; id: string; projectId?: string; version?: number;
      action?: string; byUserId?: string; bySessionId?: string }) => {
      if (ev.type !== 'project' || ev.id !== projectId) return;
      if (ev.bySessionId === CLIENT_SESSION_ID) return;
      if (typeof ev.version === 'number' && ev.version <= (projectRef.current?.version ?? 0)) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        // Pre-fetch guard (cheap early exit); loadData ALSO re-checks this
        // ref after its own await resolves (I2 fix), since a gesture can
        // start after this check passes but before the fetch completes.
        if (isDrawingActiveRef.current) return;
        loadData(projectId, pageId);
      }, 300);
    };
    socket.on('entity-changed', onEntityChanged);
    return () => {
      if (debounceTimer) clearTimeout(debounceTimer);
      socket.off('entity-changed', onEntityChanged);
    };
  }, [socket, projectId, pageId]);

  // A 409 conflict on this tab resolves by refetching in place (see
  // ProjectConflictListener); once that refetch lands, pick it up the same
  // way any other live refresh does — otherwise this canvas keeps editing a
  // stale local copy and a later save can silently overwrite someone else's
  // work (the version check passes because ProjectConflictListener already
  // healed the OTHER tab's latestVersions, not this one's data).
  useEffect(() => {
    const onRefreshed = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.projectId === projectId && pageId) loadData(projectId, pageId);
    };
    window.addEventListener('project-refreshed', onRefreshed);
    return () => window.removeEventListener('project-refreshed', onRefreshed);
  }, [projectId, pageId]);

  const loadTemplates = async () => {
    const data = await getTemplates();
    setTemplates(data);
  };

  const savePageUpdates = async (updates: Partial<ProjectPage>) => {
    if (!project || !page) return;

    const updatedPage = { ...page, ...updates };
    const updatedProject = {
      ...project,
      pages: project.pages.map(p => p.id === page.id ? updatedPage : p)
    };

    setPage(updatedPage);
    setProject(updatedProject);
    await saveProject(updatedProject);
  };

  // Task 5: replaces a single page's measurements array in LOCAL state only —
  // no project PUT. Every measurement-only mutation site below uses this
  // instead of savePageUpdates/saveProject; the op's ack (handleMeasurementOpResult)
  // is what makes the change durable and adopts the resulting project version.
  // sourcePageId lets callers target a measurement living on a different page
  // than the one currently open (cross-page update/delete already supported).
  const applyLocalMeasurements = (sourcePageId: string, measurements: Measurement[]) => {
    setProject(prev => prev
      ? { ...prev, pages: prev.pages.map(p => p.id === sourcePageId ? { ...p, measurements } : p) }
      : prev);
    setPage(prev => (prev && prev.id === sourcePageId) ? { ...prev, measurements } : prev);
  };

  // Shared ack handler for every sendMeasurementOp call site (contract item 1)
  // plus undo/redo (item 4). Adopts the version on success; on failure,
  // surfaces a toast — including for 'offline' (I3 fix): reconnect backfill
  // silently replaces local-only work with server truth, so the user needs a
  // warning that unsynced edits can be lost on reload, throttled to at most
  // once per 30s so a burst of offline ops doesn't spam toasts.
  const handleMeasurementOpResult = (res: { ok: true; version: number } | { ok: false; error: string }) => {
    // `'error' in res` (rather than `if (res.ok)` / `if (!res.ok)`) because this
    // project builds without strictNullChecks, under which plain truthiness
    // narrowing on a boolean-literal discriminant silently fails to narrow the
    // other branch — verified empirically against this exact tsconfig.
    if ('error' in res) {
      if (res.error === 'page_superseded') {
        toast('This revision is read-only — reload to see the current one', { type: 'warning' });
      } else if (res.error === 'offline') {
        const now = Date.now();
        if (now - lastOfflineToastRef.current > 30_000) {
          lastOfflineToastRef.current = now;
          toast('Not syncing — reconnecting. Recent changes may be lost if you reload.', { type: 'warning' });
        }
      } else {
        toast('Sync failed — your change is local only until the next full save', { type: 'warning' });
      }
      return;
    }
    if (projectId) noteProjectVersion(projectId, res.version);
    applyProjectUpdate(prev => ({ ...prev, version: Math.max(prev.version ?? 0, res.version) }));
  };

  const { history, redoStack, pushToHistory, undo, redo, reset: resetHistory } = useMeasurementHistory({
    page,
    selectedMeasurementId,
    setSelectedMeasurementId,
    applyMeasurements: (measurements) => { if (page) applyLocalMeasurements(page.id, measurements); },
    toast,
    sendMeasurementOp,
    onMeasurementOpResult: handleMeasurementOpResult,
    projectId,
  });

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

      // Escape: close modals / deselect (priority order)
      if (e.key === 'Escape') {
        if (showShortcutsHelp) { setShowShortcutsHelp(false); return; }
        if (showScaleModal) { setShowScaleModal(false); return; }
        if (newMeasurementModal) { setNewMeasurementModal(null); return; }
        if (showDeleteConfirm) { setShowDeleteConfirm(false); setMeasurementToDelete(null); return; }
        if (showTakeoffModal) { setShowTakeoffModal(false); return; }
        if (heightsModalMeasurementId) { setHeightsModalMeasurementId(null); return; }
        if (multiplierModalMeasurementId) { setMultiplierModalMeasurementId(null); return; }
        if (editingTakeoff) { setEditingTakeoff(null); return; }
        if (toolDisabledMessage) { setToolDisabledMessage(null); return; }
        if (takeoffToDelete) { setTakeoffToDelete(null); return; }
        if (showPageJump) { setShowPageJump(false); return; }
        if (selectedMeasurementId) { setSelectedMeasurementId(null); return; }
        return;
      }

      // ? — keyboard shortcut help
      if (e.key === '?') {
        setShowShortcutsHelp(prev => !prev);
        return;
      }

      // All measurement-mutating shortcuts (delete / delete-segment / resume-
      // drawing / paste) are disabled on frozen-history & phone read-only pages.
      // Copy, undo/redo, escape, help, and page navigation stay available.
      // Delete ONLY. Backspace is owned by PdfCanvas (remove the last
      // in-progress point) and must never open the delete confirm.
      if (e.key === 'Delete' && selectedMeasurementId && !readOnly) {
        // If a single canvas segment is selected, only delete that segment
        if (selectedSegmentIdx !== null) {
          deleteSegment(selectedMeasurementId, selectedSegmentIdx);
        } else {
          deleteMeasurement(selectedMeasurementId);
        }
      }

      if ((e.key === 'p' || e.key === 'P') && selectedMeasurementId && !readOnly) {
        const measurement = aggregatedMeasurements.find(m => m.id === selectedMeasurementId);
        if (measurement && (measurement.type === 'length' || measurement.type === 'area')) {
          // Resume the specific segment that's highlighted on canvas. null/-1 = primary.
          if (selectedSegmentIdx != null && selectedSegmentIdx >= 0) {
            const seg = measurement.segments?.[selectedSegmentIdx];
            if (seg) {
              setResumeMeasurement({ ...measurement, points: seg.points, arcMidIndices: seg.arcMidIndices });
              setResumeSegmentIdx(selectedSegmentIdx);
            } else {
              setResumeMeasurement(measurement);
              setResumeSegmentIdx(-1);
            }
          } else {
            setResumeMeasurement(measurement);
            setResumeSegmentIdx(-1);
          }
          setCurrentTool(measurement.type);
          setSelectedMeasurementId(null);
          setSelectedSegmentIdx(null);
        }
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'c' && selectedMeasurementId) {
        handleCopy();
      }

      if ((e.ctrlKey || e.metaKey) && e.key === 'v' && !readOnly) {
        handlePaste();
      }

      // Redo must be checked before Undo (Shift+Z vs Z)
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'z') {
        e.preventDefault();
        redo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === 'z') {
        e.preventDefault();
        undo();
      }

      // Arrow key page navigation
      if (e.key === 'ArrowLeft' && prevPageId && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        navigate(`/project/${project.id}/page/${prevPageId}`, { state: { pageIds } });
      }
      if (e.key === 'ArrowRight' && nextPageId && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
        navigate(`/project/${project.id}/page/${nextPageId}`, { state: { pageIds } });
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [selectedMeasurementId, selectedSegmentIdx, page, project, history, redoStack, aggregatedMeasurements,
      showShortcutsHelp, showScaleModal, showDeleteConfirm, showTakeoffModal,
      heightsModalMeasurementId, multiplierModalMeasurementId, editingTakeoff, toolDisabledMessage, takeoffToDelete,
      showPageJump, prevPageId, nextPageId, pageIds, newMeasurementModal, readOnly]);

  // When nothing is selected, drawing tools are disabled — reset to pan so the user isn't stuck.
  useEffect(() => {
    if (!selectedTakeoffId && !selectedMeasurementId && ['length', 'area', 'count'].includes(currentTool)) {
      setCurrentTool('pan');
    }
  }, [selectedTakeoffId, selectedMeasurementId]);

  // Subtract needs a real area measurement to cut into — a takeoff-only
  // selection can't receive a hole. Drop back to pan the moment that stops
  // being true (deselect, delete, or a switch to a length/count measurement).
  useEffect(() => {
    if (currentTool !== 'subtract') return;
    const selected = selectedMeasurementId && project
      ? project.pages.flatMap(p => p.measurements).find(m => m.id === selectedMeasurementId)
      : null;
    if (!selected || selected.type !== 'area') {
      setCurrentTool('pan');
    }
  }, [currentTool, selectedMeasurementId, project]);

  // Expand the containing takeoff and scroll to the selected measurement in the sidebar.
  useEffect(() => {
    if (!selectedMeasurementId || !project) return;
    const m = project.pages.flatMap(p => p.measurements).find(mm => mm.id === selectedMeasurementId);
    if (!m) return;
    if (m.takeoffId) {
      setExpandedTakeoffs(prev => prev[m.takeoffId!] === true ? prev : { ...prev, [m.takeoffId!]: true });
    }
    // Wait for the row to render after the expand state updates.
    const t = setTimeout(() => {
      const el = document.querySelector(`[data-measurement-id="${selectedMeasurementId}"]`) as HTMLElement | null;
      el?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }, 60);
    return () => clearTimeout(t);
  }, [selectedMeasurementId, project]);

  const loadData = async (pId: string, pgId: string): Promise<boolean> => {
    setIsLoading(true);
    const proj = await getProject(pId);
    if (!proj) {
      navigate('/projects');
      return false;
    }

    const pg = proj.pages.find(p => p.id === pgId);
    if (!pg) {
      navigate(`/project/${pId}/takeoff`);
      return false;
    }

    // I2 fix: re-check the mid-gesture guard AFTER the await (mirrors
    // backfillMeasurements' own post-await re-check). loadData is shared by
    // several call sites (initial mount, the entity-changed debounce, the
    // project-refreshed listener); a gesture that started while this fetch
    // was in flight must not be clobbered by applying stale-relative-to-local
    // reloaded state. Skip and let a later reload (or the gesture's own op
    // ack) converge this tab instead.
    if (isDrawingActiveRef.current) {
      setIsLoading(false);
      return false;
    }

    // Vector pages reference the source PDF and have no rasterized imageId;
    // legacy pages have imageId only. We pass the appropriate URL down — the
    // canvas decides which path to use based on which one is set.
    const imgUrl = pg.imageId ? getImageUrl(pg.imageId) : '';

    setProject(proj);
    setPage(pg);
    setImageUrl(imgUrl);
    setSelectedMeasurementId(null);
    resetHistory();

    // Set default takeoff if available
    if (proj.takeoffs.length > 0) {
      const firstTakeoff = proj.takeoffs[0];
      setSelectedTakeoffId(firstTakeoff.id);
      setSelectedColor(firstTakeoff.color);
    }

    setIsLoading(false);
    return true;
  };

  // Other pages in the project that this page can reference. Filters out
  // the current page (no self-links) and pages without a pageNumber set.
  // PdfCanvas matches text on the page against this list to surface
  // clickable hotspots over section markers, key plan callouts, etc.
  const linkablePages = useMemo(() => {
    if (!project || !page) return [];
    return project.pages
      .filter(p => p.id !== page.id && p.pageNumber && p.pageNumber.trim())
      .map(p => ({ pageId: p.id, pageNumber: p.pageNumber!.trim() }));
  }, [project, page?.id]);

  const handlePageReferenceClick = (targetPageId: string) => {
    if (!project) return;
    navigate(`/project/${project.id}/page/${targetPageId}`);
  };

  const handleSetScale = (pixelDistance: number) => {
    // Frozen history / phone read-only: ignore scale-set attempts entirely.
    if (readOnly) { setCurrentTool('pan'); return; }
    setPendingPixelDistance(pixelDistance);
    setShowScaleModal(true);
    setCurrentTool('pan');
  };

  const confirmScale = () => {
    let realWorldDistance = 0;

    if (scaleUnit === 'ft' || scaleUnit === 'in') {
      const parsedFeet = parseFeetAndInches(scaleInput, scaleUnit);
      if (parsedFeet !== null) {
        realWorldDistance = scaleUnit === 'in' ? parsedFeet * 12 : parsedFeet;
      }
    } else {
      realWorldDistance = parseFloat(scaleInput);
    }

    if (!isNaN(realWorldDistance) && realWorldDistance > 0) {
      const newScaleConfig = {
        pixelDistance: pendingPixelDistance,
        realWorldDistance,
        unit: scaleUnit,
        label: 'custom',
      };

      if (calibratingRegionId) {
        savePageUpdates({
          scaleRegions: page?.scaleRegions?.map(r => 
            r.id === calibratingRegionId ? { ...r, scaleConfig: newScaleConfig } : r
          )
        });
        setCalibratingRegionId(null);
      } else {
        savePageUpdates({
          scaleConfig: newScaleConfig
        });
      }
      setShowScaleModal(false);
    } else {
      toast('Please enter a valid distance.', { type: 'warning' });
    }
  };

  const handleStandardScaleChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const val = e.target.value;
    if (val === '') return;
    if (val === 'custom') {
      setCalibratingRegionId(null);
      setCurrentTool('scale');
      return;
    }
    const scale = STANDARD_SCALES.find(s => s.label === val);
    if (scale) {
      savePageUpdates({
        scaleConfig: {
          pixelDistance: scale.pixelDistance,
          realWorldDistance: scale.realWorldDistance,
          unit: scale.unit,
          label: scale.label,
        }
      });
    }
  };

  // The set of page ids whose measurements the sidebar takeoff list should show
  // by DEFAULT: the current (latest) revision of every sheet — EXCEPT for the
  // sheet you're actively viewing, where the visible revision is the page you
  // opened. So browsing an older revision surfaces THAT revision's measurements
  // for its sheet, while every other sheet still shows its latest revision.
  // This mirrors the Takeoffs tab, which uses computeRevisionModel(...).currentPageIds.
  const listPageIds = useMemo(() => {
    if (!project) return new Set<string>();
    const ids = new Set(computeRevisionModel(project, '').currentPageIds);
    if (page) {
      const sheetId = effectiveSheetId(page);
      // Swap out this sheet's current revision for the one being viewed.
      for (const p of project.pages) {
        if (effectiveSheetId(p) === sheetId) ids.delete(p.id);
      }
      ids.add(page.id);
    }
    return ids;
  }, [project, page]);

  // What a selected measurement's or segment's dollars are prorated against:
  // the Takeoffs tab's own per-takeoff totals (computeTakeoffTotals), over the
  // same default page set — identical to the tab's whenever the viewed page is
  // the current revision. Independent of the "Current page only" filter.
  const costTotals = useMemo(
    () => (project ? computeTakeoffTotals(project, listPageIds) : []),
    [project, listPageIds]
  );

  // The pages backing the DEFAULT sidebar list (current revision per sheet,
  // viewed revision for the viewed sheet).
  const listPages = useMemo(
    () => (project ? project.pages.filter(p => listPageIds.has(p.id)) : []),
    [project, listPageIds]
  );

  // The pages the sidebar takeoff/measurement LIST actually renders:
  //  - "Current page only" checkbox ON  -> strictly the single viewed page.
  //  - OFF (default)                     -> current-revision pages (listPages).
  const sidebarPages = useMemo(
    () => (showCurrentPageOnly ? (page ? [page] : []) : listPages),
    [showCurrentPageOnly, page, listPages]
  );

  useEffect(() => {
    // aggregatedMeasurements is the flat measurement list the sidebar/heights
    // modal look through; it must mirror the rendered sidebar page set so an
    // id lookup finds exactly what is shown (the viewed page is always included).
    setAggregatedMeasurements(sidebarPages.flatMap(p => p.measurements));
  }, [sidebarPages]);

  const addMeasurement = (measurement: Measurement) => {
    if (!page) return;
    // Frozen history / phone read-only: never accept new measurements.
    if (readOnly) return;

    // Derive takeoff + color: prefer explicitly selected takeoff, fall back to selected measurement's takeoff
    const effectiveTakeoffId = selectedTakeoffId
      ?? (selectedMeasurement?.takeoffId);
    const effectiveColor = selectedTakeoffId ? selectedColor : (selectedMeasurement?.color ?? selectedColor);

    const newMeasurement = {
      ...measurement,
      takeoffId: effectiveTakeoffId,
      color: effectiveColor,
      planSetId: page.planSetId,
    };
    
    pushToHistory({ type: 'add', measurement: newMeasurement });

    // Measurement-only mutation (no takeoff/page state change here) — drop
    // the PUT in favor of the op (contract item 1). This is the hot path for
    // every drawn shape, so decoupling it from a full project PUT is the
    // whole point of Task 5.
    applyLocalMeasurements(page.id, [...page.measurements, newMeasurement]);

    void sendMeasurementOp({ projectId: projectId!, pageId: page.id, action: 'add', measurement: newMeasurement })
      .then(handleMeasurementOpResult);

    const takeoff = project?.takeoffs.find(t => t.id === selectedTakeoffId);
    if (takeoff?.type === 'area' && measurement.type === 'length') {
      setHeightsModalMeasurementId(newMeasurement.id);
    }
  };

  // Selecting a measurement keeps the selected takeoff in sync with the
  // takeoff the measurement belongs to (or clears it if the measurement is
  // ungrouped). New segments drawn after this will append to the measurement
  // and any new measurement created will inherit the synced takeoff/color.
  const selectMeasurement = (m: Measurement) => {
    setSelectedMeasurementId(m.id);
    setSelectedSegmentIdx(null);
    setSelectedTakeoffId(m.takeoffId);
    if (m.takeoffId) {
      const takeoff = project?.takeoffs.find(t => t.id === m.takeoffId);
      if (takeoff) setSelectedColor(takeoff.color);
    } else {
      setSelectedColor(m.color);
    }
    // Selecting an area measurement while cutting holes shouldn't kick the
    // user out of subtract mode back to the plain area tool.
    if (currentTool === 'subtract' && m.type === 'area') {
      // keep tool
    } else if (m.type !== 'scale') {
      setCurrentTool(m.type as Tool);
    }
  };

  // Canvas-click selection: highlight a single segment within a measurement.
  // Does not change the active tool — the user is inspecting/picking, not drawing.
  const selectMeasurementSegment = (measurementId: string, segIdx: number) => {
    const m = project?.pages.flatMap(p => p.measurements).find(mm => mm.id === measurementId);
    if (!m) return;
    setSelectedMeasurementId(m.id);
    setSelectedSegmentIdx(segIdx);
    setSelectedTakeoffId(m.takeoffId);
    if (m.takeoffId) {
      const takeoff = project?.takeoffs.find(t => t.id === m.takeoffId);
      if (takeoff) setSelectedColor(takeoff.color);
    } else {
      setSelectedColor(m.color);
    }
  };

  const openNewMeasurementModal = (takeoffId: string) => {
    const takeoff = project?.takeoffs.find(t => t.id === takeoffId);
    if (!takeoff) return;
    // For length-typed takeoffs, only line-type measurements are valid.
    setNewMeasurementType(takeoff.type === 'length' ? 'length' : 'area');
    setNewMeasurementName('');
    setNewMeasurementModal({ takeoffId });
  };

  const confirmNewMeasurement = async () => {
    if (!project || !page || !newMeasurementModal) return;
    const trimmed = newMeasurementName.trim();
    if (!trimmed) {
      toast('Please enter a name', { type: 'warning' });
      return;
    }
    const takeoff = project.takeoffs.find(t => t.id === newMeasurementModal.takeoffId);
    if (!takeoff) return;

    const newId = uuidv4();
    const newMeasurement: Measurement = {
      id: newId,
      type: newMeasurementType,
      points: [],
      color: takeoff.color,
      name: trimmed,
      takeoffId: takeoff.id,
      planSetId: page.planSetId,
    };

    pushToHistory({ type: 'add', measurement: newMeasurement });
    // Measurement-only mutation — the new measurement is already associated
    // to an existing takeoff (no takeoff-list change), so drop the PUT.
    applyLocalMeasurements(page.id, [...page.measurements, newMeasurement]);
    const res = await sendMeasurementOp({ projectId: projectId!, pageId: page.id, action: 'add', measurement: newMeasurement as unknown as Record<string, unknown> & { id: string } });
    handleMeasurementOpResult(res);

    setSelectedTakeoffId(takeoff.id);
    setSelectedColor(takeoff.color);
    setSelectedMeasurementId(newId);
    setCurrentTool(newMeasurementType);
    setNewMeasurementModal(null);
  };

  const updateMeasurement = (id: string, updates: Partial<Measurement>, targetPageId?: string) => {
    if (!project || !page) return;
    // Frozen history / phone read-only: existing geometry can never be mutated.
    if (readOnly) return;

    let sourcePageId = targetPageId;
    let existingMeasurement: Measurement | undefined;
    
    if (!sourcePageId) {
      // Find which page has this measurement
      for (const p of project.pages) {
        const m = p.measurements.find(m => m.id === id);
        if (m) {
          sourcePageId = p.id;
          existingMeasurement = m;
          break;
        }
      }
    } else {
      existingMeasurement = project.pages.find(p => p.id === sourcePageId)?.measurements.find(m => m.id === id);
    }
    
    if (!sourcePageId || !existingMeasurement) return;

    // Always update the measurement on the page it lives on. targetPageId is
    // just an optimization for callers that already know the source page; it
    // must never cause the measurement to move to a different page.
    const before: Partial<Measurement> = {};
    for (const key of Object.keys(updates) as (keyof Measurement)[]) {
      (before as any)[key] = (existingMeasurement as any)[key];
    }
    pushToHistory({ type: 'update', measurementId: id, before, after: updates });

    const updatedMeasurement = {
      ...existingMeasurement,
      ...updates,
      planSetId: sourcePageId === page.id ? page.planSetId : existingMeasurement.planSetId,
    };

    // Measurement-only mutation — no takeoff/page state changes here, so
    // drop the PUT in favor of the op (contract item 1). This is the drag/
    // resize/heights-edit hot path.
    const sourceMeasurements = project.pages.find(p => p.id === sourcePageId)!.measurements
      .map(m => m.id === id ? updatedMeasurement : m);
    applyLocalMeasurements(sourcePageId, sourceMeasurements);

    void sendMeasurementOp({ projectId: projectId!, pageId: sourcePageId, action: 'update', measurement: updatedMeasurement })
      .then(handleMeasurementOpResult);
  };

  // The sidebar's Multiplier action. Like every measurement edit it saves
  // through updateMeasurement (realtime op + undo/redo, a no-op when read-only);
  // on a read-only page it explains why instead of opening an editor.
  const openMultiplierModal = (id: string) => {
    if (readOnly) { handlePhoneToolBlocked(); return; }
    setMultiplierModalMeasurementId(id);
  };

  const deleteMeasurement = (id: string, targetPageId?: string) => {
    // Frozen history / phone read-only: no deleting existing measurements.
    if (readOnly) return;
    setMeasurementToDelete({ id, targetPageId });
    setShowDeleteConfirm(true);
  };

  const confirmDeleteMeasurement = async () => {
    if (!project || !measurementToDelete || !page) return;
    if (readOnly) { setShowDeleteConfirm(false); setMeasurementToDelete(null); return; }
    const { id, targetPageId } = measurementToDelete;
    
    let sourcePageId = targetPageId;
    let mToDelete: Measurement | undefined;
    
    if (!sourcePageId) {
      for (const p of project.pages) {
        const m = p.measurements.find(m => m.id === id);
        if (m) {
          sourcePageId = p.id;
          mToDelete = m;
          break;
        }
      }
    } else {
      mToDelete = project.pages.find(p => p.id === sourcePageId)?.measurements.find(m => m.id === id);
    }

    if (!sourcePageId || !mToDelete) return;

    pushToHistory({ type: 'delete', measurement: mToDelete });

    // Measurement-only mutation — drop the PUT in favor of the op (contract item 1).
    const sourceMeasurements = project.pages.find(p => p.id === sourcePageId)!.measurements
      .filter(m => m.id !== id);
    applyLocalMeasurements(sourcePageId, sourceMeasurements);

    if (selectedMeasurementId === id) {
      setSelectedMeasurementId(null);
    }

    setShowDeleteConfirm(false);
    setMeasurementToDelete(null);

    void sendMeasurementOp({ projectId: projectId!, pageId: sourcePageId, action: 'delete', measurement: mToDelete as unknown as Record<string, unknown> & { id: string } })
      .then(handleMeasurementOpResult);
  };

  const deleteSegment = async (measurementId: string, segmentIdx: number) => {
    if (!project || !page) return;
    // Frozen history / phone read-only: no deleting existing segments.
    if (readOnly) return;

    let sourcePageId: string | undefined;
    let measurement: Measurement | undefined;
    for (const p of project.pages) {
      const m = p.measurements.find(m => m.id === measurementId);
      if (m) { sourcePageId = p.id; measurement = m; break; }
    }
    if (!sourcePageId || !measurement) return;

    pushToHistory({ type: 'update', measurementId, before: { points: measurement.points, arcMidIndices: measurement.arcMidIndices, segments: measurement.segments }, after: {} });

    let updatedMeasurement: Measurement;

    if (segmentIdx === -1) {
      // Deleting primary segment
      const extraSegs = measurement.segments ?? [];
      // Promote the first additive segment to primary. A cutout can't become
      // the primary polygon, so if only cutouts (or nothing) remain the whole
      // measurement goes.
      const promoteIdx = extraSegs.findIndex(s => !s.subtract);
      if (promoteIdx === -1) {
        deleteMeasurement(measurementId);
        return;
      }
      const newPrimary = extraSegs[promoteIdx];
      const rest = extraSegs.filter((_, i) => i !== promoteIdx);
      // Dangling-cutout rule: a hole cut from the polygon that just got
      // deleted has no additive shape left to punch out of, so it must not
      // silently start subtracting from an unrelated polygon that happens to
      // remain. Keep additive segments as-is; keep a subtract segment only
      // if it still lands inside some remaining additive polygon (including
      // the newly promoted primary). Drop the rest.
      const remainingAdditivePolys = [
        expandArcPoints(newPrimary.points, newPrimary.arcMidIndices),
        ...rest.filter(s => !s.subtract).map(s => expandArcPoints(s.points, s.arcMidIndices)),
      ];
      const keptRest = rest.filter(s => {
        if (!s.subtract) return true;
        const pts = expandArcPoints(s.points, s.arcMidIndices);
        if (pts.length === 0) return false;
        return remainingAdditivePolys.some(poly => isPointInPolygon(pts[0], poly));
      });
      updatedMeasurement = {
        ...measurement,
        points: newPrimary.points,
        arcMidIndices: newPrimary.arcMidIndices,
        segments: keptRest.length > 0 ? keptRest : undefined,
      };
    } else {
      // Deleting an extra segment
      const extraSegs = measurement.segments ?? [];
      const newSegs = extraSegs.filter((_, i) => i !== segmentIdx);
      // Nothing additive left to measure — cutouts alone aren't a measurement.
      const noPrimary = !measurement.points || measurement.points.length === 0;
      if ((newSegs.length === 0 || newSegs.every(s => s.subtract)) && noPrimary) {
        deleteMeasurement(measurementId);
        return;
      }
      updatedMeasurement = {
        ...measurement,
        segments: newSegs.length > 0 ? newSegs : undefined,
      };
    }

    // Measurement-only mutation (this is the 6th sendMeasurementOp site — the
    // brief's contract lists 5, but deleteSegment already had an op call from
    // Task 4's mechanical swap alongside its own full-project save). Drop the
    // PUT here too.
    const sourceMeasurements = project.pages.find(p => p.id === sourcePageId)!.measurements
      .map(m => m.id === measurementId ? updatedMeasurement : m);
    applyLocalMeasurements(sourcePageId, sourceMeasurements);
    setSelectedSegmentIdx(null);
    void sendMeasurementOp({ projectId: projectId!, pageId: sourcePageId, action: 'update', measurement: updatedMeasurement as unknown as Record<string, unknown> & { id: string } })
      .then(handleMeasurementOpResult);
  };

  const confirmDeleteTakeoff = async () => {
    if (!project || !takeoffToDelete) return;

    const updatedProject = {
      ...project,
      takeoffs: project.takeoffs.filter(t => t.id !== takeoffToDelete.id),
      pages: project.pages.map(p => ({
        ...p,
        measurements: p.measurements.filter(m => m.takeoffId !== takeoffToDelete.id)
      }))
    };

    await saveProject(updatedProject);
    setProject(updatedProject);
    
    if (page) {
      setPage(updatedProject.pages.find(p => p.id === page.id) || page);
    }

    if (selectedTakeoffId === takeoffToDelete.id) {
      setSelectedTakeoffId(null);
    }

    setTakeoffToDelete(null);
  };

  const handleEditTakeoff = (takeoff: MeasurementTakeoff) => {
    const rawTakeoff = project?.takeoffs.find(t => t.id === takeoff.id) || takeoff;
    setEditingTakeoff(rawTakeoff);
    setEditTakeoffName(rawTakeoff.name);
    setEditTakeoffColor(rawTakeoff.color);
    setEditTakeoffUnit(rawTakeoff.unit || '');
    setEditTakeoffCostPerUnit(rawTakeoff.costPerUnit?.toString() || '');
    setIsEditTakeoffAdvanced(rawTakeoff.isAdvancedCost || false);
    setEditTakeoffCustomCosts(rawTakeoff.customCosts?.map(c => ({
      ...c,
      cost: c.cost?.toString() || '0',
      yield: c.yield?.toString() || '0',
      costPerUnit: c.costPerUnit?.toString() || '0',
      amount: c.amount?.toString() || '0',
      perUnits: c.perUnits?.toString() || '0',
    })) || []);
  };

  const handleSaveEditTakeoff = async () => {
    if (!project || !editingTakeoff || !editTakeoffName) return;

    const updatedProject = {
      ...project,
      takeoffs: project.takeoffs.map(g => 
        g.id === editingTakeoff.id 
          ? { 
              ...g, 
              name: editTakeoffName, 
              color: editTakeoffColor,
              unit: editTakeoffUnit || undefined,
              costPerUnit: !isEditTakeoffAdvanced && editTakeoffCostPerUnit !== '' ? (evaluateMathExpression(editTakeoffCostPerUnit) ?? 0) : undefined,
              isAdvancedCost: isEditTakeoffAdvanced,
              customCosts: isEditTakeoffAdvanced ? editTakeoffCustomCosts.map(c => ({
                ...c,
                cost: evaluateMathExpression(c.cost?.toString() || '') ?? 0,
                yield: evaluateMathExpression(c.yield?.toString() || '') ?? 0,
                costPerUnit: evaluateMathExpression(c.costPerUnit?.toString() || '') ?? 0,
                amount: evaluateMathExpression(c.amount?.toString() || '') ?? 0,
                perUnits: evaluateMathExpression(c.perUnits?.toString() || '') ?? 0,
              })) : undefined,
            } 
          : g
      ),
      pages: project.pages.map(p => ({
        ...p,
        measurements: p.measurements.map(m => 
          m.takeoffId === editingTakeoff.id 
            ? { ...m, color: editTakeoffColor }
            : m
        )
      }))
    };

    await saveProject(updatedProject);
    setProject(updatedProject);
    
    // Update local page state
    if (page) {
      setPage(updatedProject.pages.find(p => p.id === page.id) || page);
    }

    // Update selected color if editing the active takeoff
    if (selectedTakeoffId === editingTakeoff.id) {
      setSelectedColor(editTakeoffColor);
    }

    setEditingTakeoff(null);
  };

  // Vector pages have no legacy imageUrl, so don't require one — we still need
  // the page itself though, which carries either imageId (legacy) or
  // sourcePdfFileId (vector).
  const hasBackgroundSource = !!(imageUrl || page?.sourcePdfFileId);
  if (isLoading || !project || !page || !hasBackgroundSource) {
    return (
      <div className="flex h-screen w-full bg-sunken items-center justify-center">
        <div className="w-8 h-8 border-4 border-accent-600 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  // Calculate takeoff totals
  const takeoffTotals = project.takeoffs.map(takeoff => {
    let totalRealValue = 0;
    let measurementsCount = 0;

    const pagesToProcess = sidebarPages;

    pagesToProcess.forEach(p => {
      const takeoffMeasurements = p.measurements.filter(m => m.takeoffId === takeoff.id);
      measurementsCount += takeoffMeasurements.length;
      
      takeoffMeasurements.forEach(m => {
        // Determine which scale to use
        let currentScale = p.scaleConfig;
        if (p.isMultiRegion && m.regionId) {
          const region = p.scaleRegions?.find(r => r.id === m.regionId);
          if (region?.scaleConfig) {
            currentScale = region.scaleConfig;
          }
        }

        const allMPts = [
          expandArcPoints(m.points, m.arcMidIndices),
          ...(m.segments ?? []).map(s => expandArcPoints(s.points, s.arcMidIndices)),
        ];
        let pixelValue = 0;
        if (takeoff.type === 'length' && m.type === 'length') {
          pixelValue = allMPts.reduce((sum, pts) => sum + calculatePolylineLength(pts), 0);
        } else if (takeoff.type === 'area' && m.type === 'area') {
          // Net of cutouts; the helper expands arcs itself, so it takes the
          // measurement's raw geometry rather than allMPts.
          pixelValue = measurementAreaPx({ points: m.points, arcMidIndices: m.arcMidIndices, segments: m.segments });
        } else if (takeoff.type === 'area' && m.type === 'length') {
          pixelValue = allMPts.reduce((sum, pts) =>
            sum + calculateSurfaceAreaPx(pts, m.heights || [], m.isTwoSided || false, currentScale), 0);
        } else if (takeoff.type === 'count' && m.type === 'count') {
          pixelValue = 1;
        }

        if (pixelValue > 0) {
          const realValue = calculateRealValue(pixelValue, takeoff.type as 'length' | 'area' | 'count', currentScale);
          // Convert to the current page's unit so we have a consistent base unit for formatRealValue
          const targetUnit = page.scaleConfig?.unit || 'ft';
          const sourceUnit = currentScale?.unit || 'ft';

          if (takeoff.type === 'count') {
            totalRealValue += realValue;
          } else {
            totalRealValue += convertUnit(realValue, sourceUnit, targetUnit, takeoff.type as 'length' | 'area' | 'count') * measurementMultiplier(m);
          }
        }
      });
    });
    
    return {
      ...takeoff,
      totalRealValue,
      measurementsCount
    };
  });

  const activeTakeoff = project.takeoffs.find(t => t.id === selectedTakeoffId);
  const selectedMeasurement = selectedMeasurementId
    ? project.pages.flatMap(p => p.measurements).find(m => m.id === selectedMeasurementId) ?? null
    : null;
  // The measurement's own type wins — a length measurement inside an area takeoff
  // should still lock the tool to length.
  const activeType = selectedMeasurement?.type ?? activeTakeoff?.type ?? null;
  const hasNoSelection = !selectedTakeoffId && !selectedMeasurementId;
  // The sidebar lists measurements from every page, but a cutout is drawn on
  // THIS page's canvas and PdfCanvas only ever sees this page's measurements —
  // so a cross-page selection would silently swallow the polygon.
  const selectedIsOnThisPage = !!selectedMeasurementId && page.measurements.some(m => m.id === selectedMeasurementId);
  // The info bar reads the measurement from the page it lives on (this page's
  // live state when it is here — what PdfCanvas draws — else, for a sidebar
  // pick on another sheet, that sheet) so its scale and region apply.
  const selectionPage = selectedIsOnThisPage
    ? page
    : project.pages.find(p => p.measurements.some(m => m.id === selectedMeasurementId));
  const selectionMeasurement = selectionPage?.measurements.find(m => m.id === selectedMeasurementId);
  const selectionSummary = selectionPage && selectionMeasurement
    ? summarizeSelection(selectionPage, selectionMeasurement, selectedSegmentIdx, project.takeoffs, costTotals)
    : null;

  return (
    <div className="flex h-screen w-full bg-sunken overflow-hidden font-sans relative">
      {/* Left Sidebar Wrapper */}
      {isLeftSidebarOpen && (
        <div 
          className="fixed inset-0 bg-black/20 backdrop-blur-[1px] z-40 md:hidden"
          onClick={() => setIsLeftSidebarOpen(false)}
        />
      )}
      <div className={`fixed inset-0 z-50 md:relative md:inset-auto md:z-20 flex h-full transition-all duration-300 ${isLeftSidebarOpen ? 'translate-x-0' : '-translate-x-full md:translate-x-0'}`}>
        <div className={`bg-raised border-r border-edge flex flex-col shadow-2xl md:shadow-none transition-all duration-300 overflow-hidden ${isLeftSidebarOpen ? 'w-full md:w-80' : 'w-0'}`}>
          <div className="w-full md:w-80 flex flex-col h-full overflow-y-auto overflow-x-hidden">
            <div className="p-4 border-b border-edge shrink-0">
              <div className="flex items-center justify-between mb-4">
                <Link to={`/project/${project.id}/takeoff`} className="inline-flex items-center gap-2 text-ink-soft hover:text-ink transition-colors font-medium text-sm">
                  <ArrowLeft size={16} />
                  <span className="md:inline">Back to Project</span>
                </Link>
                
                <div className="flex items-center gap-2">
                  <button 
                    onClick={() => setIsLeftSidebarOpen(false)}
                    className="md:hidden p-2 text-ink-faint hover:text-ink-soft hover:bg-hover rounded-lg"
                  >
                    <ChevronLeft size={20} />
                  </button>
                  <div className="flex items-center bg-sunken border border-edge rounded-lg shadow-sm overflow-hidden">
                <Link
                  to={prevPageId ? `/project/${project.id}/page/${prevPageId}` : '#'}
                  state={{ pageIds }}
                  className={`p-1.5 flex items-center justify-center transition-colors ${prevPageId ? 'text-ink-soft hover:bg-hover hover:text-ink' : 'text-ink-faint cursor-not-allowed'}`}
                  title="Previous Page"
                  onClick={(e) => !prevPageId && e.preventDefault()}
                >
                  <ChevronLeft size={16} />
                </Link>
                <div className="w-px h-4 bg-edge" />
                <Link
                  to={nextPageId ? `/project/${project.id}/page/${nextPageId}` : '#'}
                  state={{ pageIds }}
                  className={`p-1.5 flex items-center justify-center transition-colors ${nextPageId ? 'text-ink-soft hover:bg-hover hover:text-ink' : 'text-ink-faint cursor-not-allowed'}`}
                  title="Next Page"
                  onClick={(e) => !nextPageId && e.preventDefault()}
                >
                  <ChevronRight size={16} />
                </Link>
              </div>
              <div className="relative">
                <button
                  onClick={() => setShowPageJump(prev => !prev)}
                  className="bg-sunken border border-edge rounded-lg px-2 py-1 shadow-sm flex items-center text-xs font-medium text-ink-soft hover:bg-hover transition-colors"
                  title="Jump to page"
                >
                  {currentPageIndex + 1} / {pageIds.length}
                </button>
                {showPageJump && (
                  <div className="absolute top-full left-0 mt-1 bg-raised border border-edge rounded-lg shadow-lg z-50 min-w-[160px] max-h-64 overflow-y-auto">
                    {pageIds.map((pid, idx) => {
                      const pg = project.pages.find(p => p.id === pid);
                      return (
                        <Link
                          key={pid}
                          to={`/project/${project.id}/page/${pid}`}
                          state={{ pageIds }}
                          onClick={() => setShowPageJump(false)}
                          className={`flex items-center gap-2 px-3 py-2 text-xs hover:bg-accent-50 dark:hover:bg-accent-900/20 transition-colors ${pid === pageId ? 'bg-accent-50 dark:bg-accent-900/20 text-accent-700 dark:text-accent-400 font-semibold' : 'text-ink'}`}
                        >
                          <span className="text-ink-faint w-5 shrink-0">{idx + 1}.</span>
                          <span className="truncate">{pg?.name || `Page ${idx + 1}`}</span>
                        </Link>
                      );
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
          <h1 className="text-xl font-semibold text-ink flex items-center gap-2 line-clamp-1">
            {page.name}
          </h1>
          <p className="text-xs text-ink-soft mt-1 line-clamp-1">{project.name}</p>
        </div>

        <div className="p-4 border-b border-edge">
          <h2 className="text-xs font-semibold text-ink-faint uppercase tracking-wider mb-3">Tools</h2>
          <div className="flex items-center gap-2 mb-4">
            <ToolButton
              active={currentTool === 'pan'}
              onClick={() => setCurrentTool('pan')}
              icon={<Hand size={18} />}
              label="Pan"
            />
            <ToolButton
              active={currentTool === 'scale'}
              onClick={() => setCurrentTool('scale')}
              icon={<Settings size={18} />}
              label="Set Scale"
              disabled={readOnly}
              onDisabledClick={handlePhoneToolBlocked}
            />
            <ToolButton
              active={currentTool === 'length'}
              onClick={() => setCurrentTool('length')}
              icon={<Ruler size={18} />}
              label="Length"
              disabled={readOnly || !page.scaleConfig || hasNoSelection || (!!activeType && activeType !== 'length')}
              onDisabledClick={() => {
                if (readOnly) handlePhoneToolBlocked();
                else if (!page.scaleConfig) setToolDisabledMessage("Please set the scale first to enable measurement tools.");
                else if (hasNoSelection) setToolDisabledMessage("Select a measurement to enable drawing tools.");
                else setToolDisabledMessage(`Tool is locked to ${activeType} for the selected item.`);
              }}
            />
            <ToolButton
              active={currentTool === 'area'}
              onClick={() => setCurrentTool('area')}
              icon={<Square size={18} />}
              label="Area"
              disabled={readOnly || !page.scaleConfig || hasNoSelection || (!!activeType && activeType !== 'area')}
              onDisabledClick={() => {
                if (readOnly) handlePhoneToolBlocked();
                else if (!page.scaleConfig) setToolDisabledMessage("Please set the scale first to enable measurement tools.");
                else if (hasNoSelection) setToolDisabledMessage("Select a measurement to enable drawing tools.");
                else setToolDisabledMessage(`Tool is locked to ${activeType} for the selected item.`);
              }}
            />
            <ToolButton
              active={currentTool === 'subtract'}
              onClick={() => setCurrentTool('subtract')}
              icon={<SquareMinus size={18} />}
              label="Subtract"
              disabled={readOnly || !page.scaleConfig || hasNoSelection || activeType !== 'area' || !selectedIsOnThisPage}
              onDisabledClick={() => {
                if (readOnly) handlePhoneToolBlocked();
                else if (!page.scaleConfig) setToolDisabledMessage("Please set the scale first to enable measurement tools.");
                else if (activeType === 'area' && !selectedIsOnThisPage) setToolDisabledMessage("The selected area measurement is on another page. Select one on this page to subtract from.");
                else setToolDisabledMessage("Select an area measurement to subtract from.");
              }}
            />
            <ToolButton
              active={currentTool === 'count'}
              onClick={() => setCurrentTool('count')}
              icon={<Hash size={18} />}
              label="Count"
              disabled={readOnly || !page.scaleConfig || hasNoSelection || (!!activeType && activeType !== 'count')}
              onDisabledClick={() => {
                if (readOnly) handlePhoneToolBlocked();
                else if (!page.scaleConfig) setToolDisabledMessage("Please set the scale first to enable measurement tools.");
                else if (hasNoSelection) setToolDisabledMessage("Select a measurement to enable drawing tools.");
                else setToolDisabledMessage(`Tool is locked to ${activeType} for the selected item.`);
              }}
            />
            <div className="h-8 w-px bg-edge mx-1" />
            <button
              onClick={() => projectId && openNotes(projectId)}
              className="flex items-center justify-center p-2 md:p-2.5 rounded-lg border transition-all active:scale-95 bg-raised border-edge text-ink-soft hover:bg-hover hover:border-edge-strong"
              title="Project Notes"
            >
              <StickyNote size={18} />
            </button>
            <div className="h-8 w-px bg-edge mx-1" />
            <ToolButton
              active={currentTool === 'region'}
              onClick={() => setCurrentTool('region')}
              icon={<Layers size={18} />}
              label="Region"
              disabled={readOnly || !page.isMultiRegion}
              onDisabledClick={() => readOnly ? handlePhoneToolBlocked() : setToolDisabledMessage("Enable 'Multi-Region Scaling' to use this tool.")}
            />
            <div className="h-8 w-px bg-edge mx-1" />
            <button
              onClick={undo}
              disabled={history.length === 0}
              className={`p-2 rounded-lg transition-colors ${
                history.length === 0
                  ? 'text-ink-faint cursor-not-allowed'
                  : 'text-ink-soft hover:bg-hover hover:text-accent-600'
              }`}
              title="Undo (Ctrl+Z)"
            >
              <Undo size={18} />
            </button>
            <button
              onClick={redo}
              disabled={redoStack.length === 0}
              className={`p-2 rounded-lg transition-colors ${
                redoStack.length === 0
                  ? 'text-ink-faint cursor-not-allowed'
                  : 'text-ink-soft hover:bg-hover hover:text-accent-600'
              }`}
              title="Redo (Ctrl+Shift+Z)"
            >
              <Redo size={18} />
            </button>
            <button
              onClick={() => setShowShortcutsHelp(true)}
              className="p-2 rounded-lg transition-colors text-ink-faint hover:bg-hover hover:text-accent-600"
              title="Keyboard Shortcuts (?)"
            >
              <HelpCircle size={18} />
            </button>
          </div>

          <div className="mt-4 pt-4 border-t border-edge space-y-4">
            <div className="flex items-center justify-between">
              <label className="text-xs font-medium text-ink">Multi-Region Scaling</label>
              <input 
                type="checkbox"
                checked={page.isMultiRegion || false}
                onChange={async (e) => {
                  const updatedProject = {
                    ...project,
                    pages: project.pages.map(p => 
                      p.id === page.id ? { ...p, isMultiRegion: e.target.checked } : p
                    )
                  };
                  await saveProject(updatedProject);
                  setProject(updatedProject);
                  setPage(updatedProject.pages.find(p => p.id === page.id) || page);
                }}
                className="rounded border-edge-strong text-accent-600 focus:ring-accent-500"
              />
            </div>

            {/* Legend */}
            {(() => {
              const effectiveLegendOn = page.showLegend ?? (project?.legendOnAllPages ?? false);
              const legendFontSize = page.legendFontSize || 24;
              const legendWidth = page.legendWidth || 500;

              const setLegendPosition = (pos: { x: number; y: number }) =>
                savePageUpdates({ legendPosition: pos });

              const applyLegendToAllPages = async () => {
                if (!project) return;
                const updatedProject = {
                  ...project,
                  pages: project.pages.map(p => ({
                    ...p,
                    showLegend: true,
                    showLegendTotals: page.showLegendTotals !== false,
                    legendFontSize: legendFontSize,
                    legendWidth: legendWidth,
                  })),
                };
                setProject(updatedProject);
                await saveProject(updatedProject);
              };

              const toggleProjectDefault = async (on: boolean) => {
                if (!project) return;
                const updatedProject = { ...project, legendOnAllPages: on };
                setProject(updatedProject);
                await saveProject(updatedProject);
              };

              return (
                <>
                  <div className="flex items-center justify-between">
                    <label className="text-xs font-medium text-ink">Show Legend</label>
                    <input
                      type="checkbox"
                      checked={effectiveLegendOn}
                      onChange={(e) => savePageUpdates({ showLegend: e.target.checked })}
                      className="rounded border-edge-strong text-accent-600 focus:ring-accent-500"
                    />
                  </div>

                  {effectiveLegendOn && (
                    <div className="pl-3 border-l-2 border-edge space-y-3">
                      <div className="flex items-center justify-between">
                        <label className="text-xs font-medium text-ink-soft">Show Totals</label>
                        <input
                          type="checkbox"
                          checked={page.showLegendTotals !== false}
                          onChange={(e) => savePageUpdates({ showLegendTotals: e.target.checked })}
                          className="rounded border-edge-strong text-accent-600 focus:ring-accent-500"
                        />
                      </div>

                      <div className="flex flex-col gap-1.5">
                        <label className="text-xs font-medium text-ink-soft">Text Size</label>
                        <div className="flex items-center gap-2">
                          <input
                            type="range"
                            min="8"
                            max="72"
                            step="1"
                            value={legendFontSize}
                            onChange={(e) => savePageUpdates({ legendFontSize: parseInt(e.target.value) })}
                            className="flex-1 h-1.5 bg-edge rounded-lg appearance-none cursor-pointer accent-blue-600"
                          />
                          <span className="text-[10px] font-bold text-ink-soft w-6">{legendFontSize}</span>
                        </div>
                      </div>

                      {/* Position presets */}
                      <div>
                        <label className="text-xs font-medium text-ink-soft block mb-1.5">Snap to corner</label>
                        <div className="grid grid-cols-2 gap-1">
                          {[
                            { label: 'Top-left',     x: 20, y: 20 },
                            { label: 'Top-right',    x: (page.imageWidth  - legendWidth - 20), y: 20 },
                            { label: 'Bottom-left',  x: 20,                                    y: Math.max(20, page.imageHeight - 600) },
                            { label: 'Bottom-right', x: (page.imageWidth  - legendWidth - 20), y: Math.max(20, page.imageHeight - 600) },
                          ].map(({ label, x, y }) => (
                            <button
                              key={label}
                              onClick={() => setLegendPosition({ x, y })}
                              title={label}
                              className="text-[10px] text-ink-soft bg-sunken hover:bg-hover rounded px-1.5 py-1 transition-colors text-left"
                            >
                              {label}
                            </button>
                          ))}
                        </div>
                        <p className="text-[10px] text-ink-faint mt-1">Switch to Pan tool to drag or scroll-resize</p>
                      </div>

                      {/* Apply to all pages */}
                      {project && project.pages.length > 1 && (
                        <button
                          onClick={applyLegendToAllPages}
                          className="w-full text-xs text-accent-600 border border-accent-300 hover:bg-accent-50 rounded-lg px-2 py-1.5 transition-colors font-medium"
                        >
                          Apply legend settings to all pages
                        </button>
                      )}
                    </div>
                  )}

                  {/* Project-level default */}
                  <div className="flex items-center justify-between pt-1">
                    <label className="text-xs font-medium text-ink-soft leading-tight">
                      Enable on all pages<br />
                      <span className="text-[10px] font-normal text-ink-faint">by default</span>
                    </label>
                    <input
                      type="checkbox"
                      checked={project?.legendOnAllPages ?? false}
                      onChange={(e) => toggleProjectDefault(e.target.checked)}
                      className="rounded border-edge-strong text-accent-600 focus:ring-accent-500"
                    />
                  </div>
                </>
              );
            })()}

            {!page.isMultiRegion && (
              <div>
                <label className="block text-xs font-medium text-ink mb-1.5">Page Scale</label>
                <select
                  value={page.scaleConfig?.label || (page.scaleConfig ? 'custom' : '')}
                  onChange={handleStandardScaleChange}
                  className="w-full border border-edge-strong rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent-500 bg-raised"
                >
                  <option value="" disabled>Select a scale...</option>
                  <option value="custom">Custom (Calibrated)</option>
                  <optgroup label="Architectural">
                    {STANDARD_SCALES.slice(0, 14).map(s => (
                      <option key={s.label} value={s.label}>{s.label}</option>
                    ))}
                  </optgroup>
                  <optgroup label="Engineering">
                    {STANDARD_SCALES.slice(14).map(s => (
                      <option key={s.label} value={s.label}>{s.label}</option>
                    ))}
                  </optgroup>
                </select>
                <div className="flex items-center justify-between mt-1.5">
                  <span className="text-[10px] text-ink-soft italic">
                    {page.scaleConfig?.label === 'custom' ? 'Calibrated' : ''}
                  </span>
                  <button
                    onClick={() => {
                      setCalibratingRegionId(null);
                      setCurrentTool('scale');
                    }}
                    className="text-[10px] text-accent-600 font-medium hover:underline"
                  >
                    {page.scaleConfig ? 'Recalibrate' : 'Set Scale'}
                  </button>
                </div>
              </div>
            )}
          </div>

          {page.isMultiRegion && page.scaleRegions && page.scaleRegions.length > 0 && (
            <div className="mt-4 pt-4 border-t border-edge">
              <label className="block text-xs font-medium text-ink mb-2 uppercase tracking-wider">Regions</label>
              <div className="space-y-2">
                {page.scaleRegions.map(region => (
                  <div 
                    key={region.id} 
                    className={`border rounded-lg p-2 transition-colors cursor-pointer ${selectedRegionId === region.id ? 'bg-accent-50 border-accent-300' : 'bg-sunken border-edge hover:bg-hover'}`}
                    onClick={() => setSelectedRegionId(region.id === selectedRegionId ? null : region.id)}
                  >
                    <div className="flex items-center justify-between mb-2">
                      <input 
                        type="text"
                        value={region.name}
                        onClick={(e) => e.stopPropagation()}
                        onChange={async (e) => {
                          const updatedProject = {
                            ...project,
                            pages: project.pages.map(p => 
                              p.id === page.id 
                                ? { 
                                    ...p, 
                                    scaleRegions: p.scaleRegions?.map(r => 
                                      r.id === region.id ? { ...r, name: e.target.value } : r
                                    ) 
                                  } 
                                : p
                            )
                          };
                          await saveProject(updatedProject);
                          setProject(updatedProject);
                          setPage(updatedProject.pages.find(p => p.id === page.id) || page);
                        }}
                        className="text-xs font-semibold bg-transparent border-none p-0 focus:ring-0 w-24"
                      />
                      <button 
                        onClick={async (e) => {
                          e.stopPropagation();
                          const updatedProject = {
                            ...project,
                            pages: project.pages.map(p => 
                              p.id === page.id 
                                ? { 
                                    ...p, 
                                    scaleRegions: p.scaleRegions?.filter(r => r.id !== region.id),
                                    measurements: p.measurements.map(m => m.regionId === region.id ? { ...m, regionId: undefined } : m)
                                  } 
                                : p
                            )
                          };
                          await saveProject(updatedProject);
                          setProject(updatedProject);
                          setPage(updatedProject.pages.find(p => p.id === page.id) || page);
                          if (selectedRegionId === region.id) setSelectedRegionId(null);
                        }}
                        className="text-ink-faint hover:text-red-500"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                    
                    <div className="space-y-2">
                      <select
                        value={region.scaleConfig?.label || (region.scaleConfig ? 'custom' : '')}
                        onClick={(e) => e.stopPropagation()}
                        onChange={async (e) => {
                          const val = e.target.value;
                          let newScaleConfig: ScaleConfig | null = null;
                          
                          if (val === 'custom') {
                            setCalibratingRegionId(region.id);
                            setCurrentTool('scale');
                            return;
                          } else {
                            const standard = STANDARD_SCALES.find(s => s.label === val);
                            if (standard) {
                              newScaleConfig = { ...standard };
                            }
                          }

                          const updatedProject = {
                            ...project,
                            pages: project.pages.map(p => 
                              p.id === page.id 
                                ? { 
                                    ...p, 
                                    scaleRegions: p.scaleRegions?.map(r => 
                                      r.id === region.id ? { ...r, scaleConfig: newScaleConfig || r.scaleConfig } : r
                                    ) 
                                  } 
                                : p
                            )
                          };
                          await saveProject(updatedProject);
                          setProject(updatedProject);
                          setPage(updatedProject.pages.find(p => p.id === page.id) || page);
                        }}
                        className="w-full border border-edge-strong rounded px-2 py-1 text-[10px] focus:outline-none focus:ring-1 focus:ring-accent-500 bg-raised"
                      >
                        <option value="" disabled>Select a scale...</option>
                        <option value="custom">Custom (Calibrated)</option>
                        <optgroup label="Architectural">
                          {STANDARD_SCALES.slice(0, 14).map(s => (
                            <option key={s.label} value={s.label}>{s.label}</option>
                          ))}
                        </optgroup>
                        <optgroup label="Engineering">
                          {STANDARD_SCALES.slice(14).map(s => (
                            <option key={s.label} value={s.label}>{s.label}</option>
                          ))}
                        </optgroup>
                      </select>

                      <div className="flex items-center justify-between">
                        <span className="text-[10px] text-ink-soft italic">
                          {region.scaleConfig && region.scaleConfig.label === 'custom' ? 'Calibrated' : ''}
                        </span>
                        <button 
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedRegionId(region.id);
                            setCalibratingRegionId(region.id);
                            setCurrentTool('scale');
                          }}
                          className="text-[10px] text-accent-600 font-medium hover:underline"
                        >
                          {region.scaleConfig ? 'Recalibrate' : 'Set Scale'}
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {!selectedTakeoffId && page.scaleConfig && (
            <div className="mt-4 pt-4 border-t border-edge">
              <label className="block text-xs font-medium text-ink mb-1.5">Highlight Color</label>
              <input
                type="color"
                value={selectedColor}
                onChange={(e) => setSelectedColor(e.target.value)}
                className="h-8 w-full rounded cursor-pointer border border-edge-strong p-0.5"
              />
            </div>
          )}
        </div>
      </div>
      <button
        onClick={() => setIsLeftSidebarOpen(!isLeftSidebarOpen)}
        className={`absolute right-0 translate-x-full top-1/2 -translate-y-1/2 z-30 bg-raised border border-edge border-l-0 rounded-r-md p-1 shadow-sm hover:bg-hover text-ink-soft ${isLeftSidebarOpen ? 'hidden md:block' : 'block'}`}
      >
        {isLeftSidebarOpen ? <ChevronLeft size={16} /> : <ChevronRight size={16} />}
      </button>
    </div>
  </div>

  {/* Main Canvas Area */}
      <div className="flex-1 relative bg-slate-200 min-w-0 min-h-0 flex flex-col">
        {/* Mobile Header (only visible when sidebars are closed) */}
        <div className={`md:hidden fixed top-0 left-0 right-0 h-14 glass-panel border-b border-edge z-40 flex items-center px-4 justify-between transition-all duration-300 ${(!isLeftSidebarOpen && !isRightSidebarOpen) ? 'translate-y-0 opacity-100' : '-translate-y-full opacity-0'}`}>
          <div className="flex items-center gap-3">
            <button 
              onClick={() => setIsLeftSidebarOpen(true)}
              className="p-2 text-ink-soft hover:bg-hover rounded-lg active:scale-95 transition-transform"
            >
              <Settings size={22} />
            </button>
            <div className="flex flex-col min-w-0">
              <span className="text-sm font-bold text-ink truncate">{page.name}</span>
              <span className="text-[10px] text-ink-soft truncate">{project.name}</span>
            </div>
          </div>
          <button 
            onClick={() => setIsRightSidebarOpen(true)}
            className="p-2 text-ink-soft hover:bg-hover rounded-lg relative active:scale-95 transition-transform"
          >
            <Layers size={22} />
            {page.measurements.length > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-1 bg-accent-600 text-white text-[10px] font-bold flex items-center justify-center rounded-full border-2 border-white shadow-sm">
                {page.measurements.length}
              </span>
            )}
          </button>
        </div>

        <div data-testid="canvas-surface" className="flex-1 relative min-h-0">
          {/* Superseded-revision read-only notice (Plan Set rework). Prominent and
              non-dismissible: this page is frozen history. "Go to current" jumps
              to the sheet's living revision where editing is enabled. */}
          {isSupersededRevision && (
            <div
              data-testid="canvas-superseded-banner"
              className="absolute top-16 left-3 right-3 z-40 flex items-center gap-3 bg-black/85 border border-edge-strong text-white rounded-xl px-4 py-3 shadow-xl"
            >
              <History size={18} className="shrink-0 text-amber-300" />
              <span className="text-sm leading-snug flex-1 font-medium">
                Viewing Rev {supersededInfo.revNumber} — read-only history
              </span>
              {supersededInfo.currentPageId && supersededInfo.currentPageId !== pageId && (
                <button
                  data-testid="goto-current-revision"
                  onClick={() => navigate(`/project/${project.id}/page/${supersededInfo.currentPageId}`)}
                  className="shrink-0 px-3 py-1.5 rounded-lg bg-accent-600 text-white text-xs font-semibold hover:bg-accent-700 transition-colors flex items-center gap-1.5"
                >
                  Go to current
                  <ChevronRight size={14} />
                </button>
              )}
            </div>
          )}
          {/* Phone read-only notice (Phase 8). Dismissible; only on phones and
              only when not already on a superseded (frozen) revision. */}
          {isPhone && !isSupersededRevision && !readOnlyBannerDismissed && (
            <div
              data-testid="canvas-readonly-banner"
              className="absolute top-16 left-3 right-3 z-40 flex items-start gap-2 bg-amber-50/95 border border-amber-200 text-amber-900 rounded-xl px-3 py-2.5 shadow-lg"
            >
              <Layers size={16} className="mt-0.5 shrink-0 text-amber-600" />
              <span className="text-xs leading-snug flex-1">
                Viewing only on small screens — open this page on a tablet or computer to draw takeoffs.
              </span>
              <button
                onClick={() => setReadOnlyBannerDismissed(true)}
                className="shrink-0 p-1 -m-1 text-amber-600 hover:text-amber-900 active:scale-90 transition-all"
                aria-label="Dismiss"
                title="Dismiss"
              >
                <span aria-hidden className="block w-4 h-4 leading-4 text-center font-bold">×</span>
              </button>
            </div>
          )}
          {/* Floating Controls */}
          <div className={`absolute top-[58px] md:top-4 left-4 right-4 z-30 pointer-events-none flex items-center justify-between transition-opacity ${isLeftSidebarOpen || isRightSidebarOpen ? 'opacity-0 md:opacity-100' : 'opacity-100'}`}>
            <div className="hidden md:flex pointer-events-auto items-center gap-2">
              {!isLeftSidebarOpen && (
                <>
                  <Link
                    to={`/project/${project.id}/takeoff${searchTerm ? `?search=${encodeURIComponent(searchTerm)}` : ''}`}
                    className="inline-flex items-center gap-2 glass-panel border border-edge rounded-lg px-3 py-2 text-ink-soft hover:text-ink shadow-sm transition-all font-medium text-sm"
                  >
                    <ArrowLeft size={16} />
                    Back to Project
                  </Link>
                  
                  <div className="flex items-center glass-panel border border-edge rounded-lg shadow-sm overflow-hidden">
                    <Link
                      to={prevPageId ? `/project/${project.id}/page/${prevPageId}${searchTerm ? `?search=${encodeURIComponent(searchTerm)}` : ''}` : '#'}
                      state={{ pageIds }}
                      className={`p-2 flex items-center justify-center transition-colors ${prevPageId ? 'text-ink-soft hover:bg-hover hover:text-ink' : 'text-ink-faint cursor-not-allowed'}`}
                      title="Previous Page"
                      onClick={(e) => !prevPageId && e.preventDefault()}
                    >
                      <ChevronLeft size={18} />
                    </Link>
                    <div className="w-px h-5 bg-edge" />
                    <Link
                      to={nextPageId ? `/project/${project.id}/page/${nextPageId}${searchTerm ? `?search=${encodeURIComponent(searchTerm)}` : ''}` : '#'}
                      state={{ pageIds }}
                      className={`p-2 flex items-center justify-center transition-colors ${nextPageId ? 'text-ink-soft hover:bg-hover hover:text-ink' : 'text-ink-faint cursor-not-allowed'}`}
                      title="Next Page"
                      onClick={(e) => !nextPageId && e.preventDefault()}
                    >
                      <ChevronRight size={18} />
                    </Link>
                  </div>
                </>
              )}
            </div>
            
            <div className={`pointer-events-auto flex flex-wrap items-center justify-center gap-1 md:gap-2 glass-panel border border-edge rounded-xl p-1 md:p-1.5 shadow-lg mx-auto md:ml-auto md:mr-0 max-w-[95vw] overflow-x-auto no-scrollbar ${isLeftSidebarOpen || isRightSidebarOpen ? 'hidden md:flex' : 'flex'}`}>
              <ToolButton
                testId="tool-pan"
                active={currentTool === 'pan'}
                onClick={() => setCurrentTool('pan')}
                icon={<Hand size={20} />}
                label="Pan"
                showLabel
              />
              <ToolButton
                testId="tool-scale"
                active={currentTool === 'scale'}
                onClick={() => setCurrentTool('scale')}
                icon={<Settings size={20} />}
                label="Set Scale"
                showLabel
                disabled={readOnly}
                onDisabledClick={handlePhoneToolBlocked}
              />
              <div className="h-6 w-px bg-edge mx-0.5 md:mx-1 flex-shrink-0" />
              <ToolButton
                testId="tool-length"
                active={currentTool === 'length'}
                onClick={() => setCurrentTool('length')}
                icon={<Ruler size={20} />}
                label="Length"
                showLabel
                disabled={readOnly || !page.scaleConfig || hasNoSelection || (!!activeType && activeType !== 'length')}
                onDisabledClick={() => {
                  if (readOnly) handlePhoneToolBlocked();
                  else if (!page.scaleConfig) setToolDisabledMessage("Please set the scale first to enable measurement tools.");
                  else if (hasNoSelection) setToolDisabledMessage("Select a measurement to enable drawing tools.");
                  else setToolDisabledMessage(`Tool is locked to ${activeType} for the selected item.`);
                }}
              />
              <ToolButton
                testId="tool-area"
                active={currentTool === 'area'}
                onClick={() => setCurrentTool('area')}
                icon={<Square size={20} />}
                label="Area"
                showLabel
                disabled={readOnly || !page.scaleConfig || hasNoSelection || (!!activeType && activeType !== 'area')}
                onDisabledClick={() => {
                  if (readOnly) handlePhoneToolBlocked();
                  else if (!page.scaleConfig) setToolDisabledMessage("Please set the scale first to enable measurement tools.");
                  else if (hasNoSelection) setToolDisabledMessage("Select a measurement to enable drawing tools.");
                  else setToolDisabledMessage(`Tool is locked to ${activeType} for the selected item.`);
                }}
              />
              <ToolButton
                testId="tool-subtract"
                active={currentTool === 'subtract'}
                onClick={() => setCurrentTool('subtract')}
                icon={<SquareMinus size={20} />}
                label="Subtract"
                showLabel
                disabled={readOnly || !page.scaleConfig || hasNoSelection || activeType !== 'area' || !selectedIsOnThisPage}
                onDisabledClick={() => {
                  if (readOnly) handlePhoneToolBlocked();
                  else if (!page.scaleConfig) setToolDisabledMessage("Please set the scale first to enable measurement tools.");
                  else if (activeType === 'area' && !selectedIsOnThisPage) setToolDisabledMessage("The selected area measurement is on another page. Select one on this page to subtract from.");
                  else setToolDisabledMessage("Select an area measurement to subtract from.");
                }}
              />
              <ToolButton
                testId="tool-count"
                active={currentTool === 'count'}
                onClick={() => setCurrentTool('count')}
                icon={<Hash size={20} />}
                label="Count"
                showLabel
                disabled={readOnly || !page.scaleConfig || hasNoSelection || (!!activeType && activeType !== 'count')}
                onDisabledClick={() => {
                  if (readOnly) handlePhoneToolBlocked();
                  else if (!page.scaleConfig) setToolDisabledMessage("Please set the scale first to enable measurement tools.");
                  else if (hasNoSelection) setToolDisabledMessage("Select a measurement to enable drawing tools.");
                  else setToolDisabledMessage(`Tool is locked to ${activeType} for the selected item.`);
                }}
              />
              <div className="h-6 w-px bg-edge mx-0.5 md:mx-1 flex-shrink-0" />
              <ToolButton
                active={currentTool === 'region'}
                onClick={() => setCurrentTool('region')}
                icon={<Layers size={20} />}
                label="Region"
                showLabel
                disabled={readOnly || !page.isMultiRegion}
                onDisabledClick={() => readOnly ? handlePhoneToolBlocked() : setToolDisabledMessage("Enable 'Multi-Region Scaling' to use this tool.")}
              />
              <div className="h-6 w-px bg-edge mx-0.5 md:mx-1 flex-shrink-0" />
              <button
                data-testid="btn-undo"
                onClick={undo}
                disabled={history.length === 0}
                className={`p-2 rounded-lg transition-colors flex-shrink-0 active:scale-95 ${
                  history.length === 0
                    ? 'text-ink-faint cursor-not-allowed'
                    : 'text-ink-soft hover:bg-hover hover:text-accent-600 active:bg-hover'
                }`}
                title="Undo (Ctrl+Z)"
              >
                <Undo size={20} />
              </button>
              <button
                data-testid="btn-redo"
                onClick={redo}
                disabled={redoStack.length === 0}
                className={`p-2 rounded-lg transition-colors flex-shrink-0 active:scale-95 ${
                  redoStack.length === 0
                    ? 'text-ink-faint cursor-not-allowed'
                    : 'text-ink-soft hover:bg-hover hover:text-accent-600 active:bg-hover'
                }`}
                title="Redo (Ctrl+Shift+Z)"
              >
                <Redo size={20} />
              </button>
              <button
                onClick={() => setShowShortcutsHelp(true)}
                className="p-2 rounded-lg transition-colors flex-shrink-0 active:scale-95 text-ink-faint hover:bg-hover hover:text-accent-600"
                title="Keyboard Shortcuts (?)"
              >
                <HelpCircle size={20} />
              </button>
              <div className="h-6 w-px bg-edge mx-0.5 md:mx-1 flex-shrink-0" />
              <button
                data-testid="btn-multi-select-toggle"
                onClick={() => { setIsMultiSelectMode(m => !m); if (isMultiSelectMode) setMultiSelectedIds(new Set()); }}
                className={`p-2 rounded-lg transition-colors flex-shrink-0 active:scale-95 ${isMultiSelectMode ? 'bg-amber-500 text-white' : 'text-ink-soft hover:bg-hover hover:text-amber-600'}`}
                title="Multi-select (Ctrl+click on desktop)"
              >
                <BoxSelect size={20} />
              </button>
            </div>
          </div>

          <PdfCanvas
            key={page.id}
            readOnly={readOnly}
            onDrawingActiveChange={setIsDrawingActive}
            imageUrl={imageUrl || ''}
            imageWidth={page.imageWidth}
            imageHeight={page.imageHeight}
            sourcePdfUrl={page.sourcePdfFileId ? getImageUrl(page.sourcePdfFileId) : undefined}
            sourcePdfPageNum={page.sourcePdfPageNum}
            thumbnailUrl={page.thumbnailId ? getImageUrl(page.thumbnailId) : undefined}
            linkablePages={linkablePages}
            onPageReferenceClick={handlePageReferenceClick}
            currentTool={currentTool}
            searchTerm={searchTerm}
            scaleConfig={page.scaleConfig}
            measurements={page.measurements}
            pageMeasurements={page.measurements}
            takeoffs={project.takeoffs}
            takeoffCostTotals={costTotals}
            onAddMeasurement={addMeasurement}
            onUpdateMeasurement={updateMeasurement}
            onDeleteMeasurement={deleteMeasurement}
            onSetScale={handleSetScale}
            selectedMeasurementId={selectedMeasurementId}
            selectedSegmentIdx={selectedSegmentIdx}
            onSelectMeasurement={(id) => {
              if (id === null) {
                setSelectedMeasurementId(null);
                setSelectedSegmentIdx(null);
                return;
              }
              const m = page.measurements.find(mm => mm.id === id);
              if (m) selectMeasurement(m);
              else { setSelectedMeasurementId(id); setSelectedSegmentIdx(null); }
            }}
            onSelectSegment={selectMeasurementSegment}
            resumeMeasurement={resumeMeasurement}
            resumeSegmentIdx={resumeSegmentIdx}
            onMeasurementResumed={() => { setResumeMeasurement(null); setResumeSegmentIdx(-1); }}
            onCancel={() => {
              setSelectedMeasurementId(null);
              setSelectedSegmentIdx(null);
              setCurrentTool('pan');
              setCalibratingRegionId(null);
            }}
            isMultiRegion={page.isMultiRegion}
            scaleRegions={page.scaleRegions}
            selectedRegionId={selectedRegionId}
            onSelectRegion={setSelectedRegionId}
            calibratingRegionId={calibratingRegionId}
            showLegend={page.showLegend ?? (project?.legendOnAllPages ?? false)}
            showLegendTotals={page.showLegendTotals}
            legendPosition={page.legendPosition}
            legendScale={page.legendScale}
            legendScaleX={page.legendScaleX}
            legendScaleY={page.legendScaleY}
            legendFontSize={page.legendFontSize}
            legendWidth={page.legendWidth}
            onUpdateLegend={async (updates) => {
              const pageUpdates: Partial<ProjectPage> = {};
              if (updates.position) pageUpdates.legendPosition = updates.position;
              if (updates.scale !== undefined) pageUpdates.legendScale = updates.scale;
              if (updates.scaleX !== undefined) pageUpdates.legendScaleX = updates.scaleX;
              if (updates.scaleY !== undefined) pageUpdates.legendScaleY = updates.scaleY;
              if (updates.fontSize !== undefined) pageUpdates.legendFontSize = updates.fontSize;
              if (updates.width !== undefined) pageUpdates.legendWidth = updates.width;
              savePageUpdates(pageUpdates);
            }}
            onAddRegion={async (region) => {
              const updatedProject = {
                ...project,
                pages: project.pages.map(p => 
                  p.id === page.id 
                    ? { ...p, scaleRegions: [...(p.scaleRegions || []), region] } 
                    : p
                )
              };
              await saveProject(updatedProject);
              setProject(updatedProject);
              setPage(updatedProject.pages.find(p => p.id === page.id) || page);
              setCurrentTool('pan');
            }}
            onUpdateRegion={async (id, regionUpdate) => {
              const updatedProject = {
                ...project,
                pages: project.pages.map(p => 
                  p.id === page.id 
                    ? { 
                        ...p, 
                        scaleRegions: p.scaleRegions?.map(r => r.id === id ? { ...r, ...regionUpdate } : r) 
                      } 
                    : p
                )
              };
              await saveProject(updatedProject);
              setProject(updatedProject);
              setPage(updatedProject.pages.find(p => p.id === page.id) || page);
            }}
            onDeleteRegion={async (id) => {
              const updatedProject = {
                ...project,
                pages: project.pages.map(p => 
                  p.id === page.id 
                    ? { 
                        ...p, 
                        scaleRegions: p.scaleRegions?.filter(r => r.id !== id),
                        measurements: p.measurements.map(m => m.regionId === id ? { ...m, regionId: undefined } : m)
                      } 
                    : p
                )
              };
              await saveProject(updatedProject);
              setProject(updatedProject);
              setPage(updatedProject.pages.find(p => p.id === page.id) || page);
            }}
            remoteUsers={users}
            onCursorMove={sendCursor}
            currentUserId={socket?.id}
            onUndo={undo}
            onRedo={redo}
            onCopy={selectedMeasurementId ? handleCopy : undefined}
            onPaste={handlePaste}
            hasCopied={!!localStorage.getItem('copiedMeasurement')}
            multiSelectedIds={multiSelectedIds}
            onMultiSelectToggle={handleMultiSelectToggle}
            onClearMultiSelect={() => setMultiSelectedIds(new Set())}
            isMultiSelectMode={isMultiSelectMode}
          />

          {/* Tool Instructions Overlay */}
          {currentTool !== 'pan' && (
            <div className="absolute bottom-4 left-1/2 -translate-x-1/2 bg-black/70 text-white px-4 py-2 rounded-full text-xs md:text-sm shadow-lg pointer-events-none z-10 text-center max-w-[90vw]">
              {currentTool === 'scale' && (calibratingRegionId ? `Calibrating scale for ${page.scaleRegions?.find(r => r.id === calibratingRegionId)?.name}` : "Click two points to define a known distance")}
              {currentTool === 'length' && `Click points to draw a line. ${finishHint}`}
              {currentTool === 'area' && `Click points to draw a polygon. ${finishHint}`}
              {currentTool === 'subtract' && `Click points to cut an opening out of the selected area. ${finishHint}`}
              {currentTool === 'region' && `Click points to define a scale region. ${finishHint}`}
            </div>
          )}

          {/* Selection Info Bar: the selected measurement's (or segment's) quantity and $ */}
          <SelectionInfoBar summary={selectionSummary} multiCount={multiSelectedIds.size} />
        </div>
      </div>

      <MeasurementSidebar
        project={project}
        page={page}
        sidebarPages={sidebarPages}
        takeoffTotals={takeoffTotals}
        isRightSidebarOpen={isRightSidebarOpen}
        setIsRightSidebarOpen={setIsRightSidebarOpen}
        showCurrentPageOnly={showCurrentPageOnly}
        setShowCurrentPageOnly={setShowCurrentPageOnly}
        measurementFilter={measurementFilter}
        setMeasurementFilter={setMeasurementFilter}
        expandedTakeoffs={expandedTakeoffs}
        setExpandedTakeoffs={setExpandedTakeoffs}
        selectedTakeoffId={selectedTakeoffId}
        setSelectedTakeoffId={setSelectedTakeoffId}
        selectedMeasurementId={selectedMeasurementId}
        multiSelectedIds={multiSelectedIds}
        setMultiSelectedIds={setMultiSelectedIds}
        setIsMultiSelectMode={setIsMultiSelectMode}
        setSelectedColor={setSelectedColor}
        setCurrentTool={setCurrentTool}
        setShowTakeoffModal={setShowTakeoffModal}
        setTakeoffToDelete={setTakeoffToDelete}
        setHeightsModalMeasurementId={setHeightsModalMeasurementId}
        onEditMultiplier={openMultiplierModal}
        selectMeasurement={selectMeasurement}
        updateMeasurement={updateMeasurement}
        deleteMeasurement={deleteMeasurement}
        handleEditTakeoff={handleEditTakeoff}
        handleMergeSelected={handleMergeSelected}
        openNewMeasurementModal={openNewMeasurementModal}
        toast={toast}
      />

      {/* Scale Modal */}
      <ScaleCalibrationModal
        open={showScaleModal}
        scaleInput={scaleInput}
        onScaleInputChange={setScaleInput}
        scaleUnit={scaleUnit}
        onScaleUnitChange={setScaleUnit}
        onApply={confirmScale}
        onClose={() => setShowScaleModal(false)}
      />

      {/* New Measurement Modal */}
      {newMeasurementModal && (() => {
        const targetTakeoff = project.takeoffs.find(t => t.id === newMeasurementModal.takeoffId);
        const allowAreaType = targetTakeoff?.type === 'area';
        return (
          <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[60] p-4">
            <div className="bg-raised rounded-2xl shadow-xl w-full max-w-sm overflow-hidden">
              <div className="p-6 border-b border-edge">
                <h3 className="text-lg font-semibold text-ink">New Measurement</h3>
                {targetTakeoff && (
                  <p className="text-xs text-ink-soft mt-1">
                    Adding to <span className="font-medium" style={{ color: targetTakeoff.color }}>{targetTakeoff.name}</span>
                  </p>
                )}
              </div>
              <div className="p-6 space-y-4">
                <div>
                  <label className="block text-xs font-medium text-ink-soft mb-1">Name</label>
                  <input
                    type="text"
                    value={newMeasurementName}
                    onChange={(e) => setNewMeasurementName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') confirmNewMeasurement();
                    }}
                    placeholder="e.g. North Wall"
                    className="w-full border border-edge-strong rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-raised text-ink"
                    autoFocus
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-ink-soft mb-1">Type</label>
                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => setNewMeasurementType('length')}
                      className={`flex items-center justify-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium transition-all ${newMeasurementType === 'length' ? 'border-accent-500 bg-accent-50 dark:bg-accent-900/30 text-accent-700 dark:text-accent-300' : 'border-edge-strong text-ink-soft hover:bg-hover dark:hover:bg-hover'}`}
                    >
                      <Ruler size={14} /> Line
                    </button>
                    <button
                      type="button"
                      disabled={!allowAreaType}
                      onClick={() => allowAreaType && setNewMeasurementType('area')}
                      className={`flex items-center justify-center gap-2 px-3 py-2 rounded-lg border text-sm font-medium transition-all ${newMeasurementType === 'area' ? 'border-accent-500 bg-accent-50 dark:bg-accent-900/30 text-accent-700 dark:text-accent-300' : 'border-edge-strong text-ink-soft hover:bg-hover dark:hover:bg-hover'} ${!allowAreaType ? 'opacity-40 cursor-not-allowed' : ''}`}
                    >
                      <Square size={14} /> Area
                    </button>
                  </div>
                  {!allowAreaType && (
                    <p className="text-[11px] text-ink-soft mt-1.5">
                      Linear takeoffs only support line measurements.
                    </p>
                  )}
                </div>
              </div>
              <div className="p-4 border-t border-edge bg-sunken flex justify-end gap-2">
                <button
                  onClick={() => setNewMeasurementModal(null)}
                  className="px-4 py-2 text-sm font-medium text-ink-soft hover:bg-hover active:scale-95 rounded-lg transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={confirmNewMeasurement}
                  className="px-4 py-2 text-sm font-medium text-white bg-accent-600 hover:bg-accent-700 active:scale-95 rounded-lg transition-all"
                >
                  Create
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[60] p-4">
          <div className="bg-raised rounded-2xl shadow-xl w-full max-w-sm overflow-hidden">
            <div className="p-6 border-b border-edge">
              <h3 className="text-lg font-semibold text-ink">Delete Measurement</h3>
            </div>
            <div className="p-6">
              <p className="text-ink-soft">
                Are you sure you want to delete this measurement? This action cannot be undone.
              </p>
            </div>
            <div className="p-6 border-t border-edge bg-sunken flex justify-end gap-3">
              <button
                onClick={() => { setShowDeleteConfirm(false); setMeasurementToDelete(null); }}
                className="px-5 py-2.5 text-sm font-medium text-ink-soft hover:bg-hover active:scale-95 rounded-xl transition-all"
              >
                Cancel
              </button>
              <button
                data-testid="btn-confirm-delete"
                onClick={confirmDeleteMeasurement}
                className="px-5 py-2.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 active:scale-95 rounded-xl transition-all shadow-sm"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Takeoff Modal */}
      <NewTakeoffModal
        open={showTakeoffModal}
        onClose={() => setShowTakeoffModal(false)}
        project={project}
        templates={templates}
        onCreateTakeoff={async (newTakeoff) => {
          const updatedProject = {
            ...project,
            takeoffs: [...project.takeoffs, newTakeoff],
          };
          await saveProject(updatedProject);
          setProject(updatedProject);
          setSelectedTakeoffId(newTakeoff.id);
          setSelectedColor(newTakeoff.color);
          setCurrentTool(newTakeoff.type);
          setShowTakeoffModal(false);
        }}
      />

      {/* Delete Takeoff Confirmation Modal */}
      {takeoffToDelete && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
          <div className="bg-raised rounded-2xl shadow-xl w-full max-w-sm overflow-hidden">
            <div className="p-6 border-b border-edge">
              <h3 className="text-lg font-semibold text-ink">Delete Takeoff</h3>
            </div>
            <div className="p-6">
              <p className="text-sm text-ink-soft">
                Are you sure you want to delete the takeoff "{takeoffToDelete.name}"? This will also delete all measurements associated with it across all pages. This action cannot be undone.
              </p>
            </div>
            <div className="p-6 border-t border-edge bg-sunken flex justify-end gap-3">
              <button
                onClick={() => setTakeoffToDelete(null)}
                className="px-5 py-2.5 text-sm font-medium text-ink-soft hover:bg-hover rounded-xl transition-colors"
              >
                Cancel
              </button>
              <button
                data-testid="btn-confirm-delete"
                onClick={confirmDeleteTakeoff}
                className="px-5 py-2.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-xl transition-colors shadow-sm"
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Edit Takeoff Modal */}
      {editingTakeoff && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-raised rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
            <div className="p-6 border-b border-edge">
              <h3 className="text-lg font-semibold text-ink">Edit Measurement Takeoff</h3>
            </div>
            <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto">
              <div>
                <label className="block text-sm font-medium text-ink mb-1.5">Takeoff Name</label>
                <input
                  data-testid="edit-takeoff-name"
                  type="text"
                  value={editTakeoffName}
                  onChange={(e) => setEditTakeoffName(e.target.value)}
                  className="w-full border border-edge-strong rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-raised text-ink"
                  placeholder="e.g. Hardwood Flooring"
                  autoFocus
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-ink mb-1.5">Measurement Type</label>
                  <input
                    type="text"
                    value={editingTakeoff.type}
                    disabled
                    className="w-full border border-edge rounded-xl px-4 py-2.5 bg-sunken text-ink-soft capitalize"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-ink mb-1.5">Color</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={editTakeoffColor}
                      onChange={(e) => setEditTakeoffColor(e.target.value)}
                      className="h-11 w-full rounded-lg cursor-pointer border border-edge-strong p-1"
                    />
                  </div>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-ink mb-1.5">Unit</label>
                  <select
                    value={editTakeoffUnit}
                    onChange={(e) => setEditTakeoffUnit(e.target.value)}
                    className="w-full border border-edge-strong rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-raised text-ink"
                  >
                    <option value="">Default (Scale Unit)</option>
                    {editingTakeoff.type === 'length' && (
                      <>
                        <option value="in">Inches (in)</option>
                        <option value="ft">Feet (ft)</option>
                        <option value="yd">Yards (yd)</option>
                        <option value="cm">Centimeters (cm)</option>
                        <option value="m">Meters (m)</option>
                      </>
                    )}
                    {editingTakeoff.type === 'area' && (
                      <>
                        <option value="sqin">Square Inches (sq in)</option>
                        <option value="sqft">Square Feet (sq ft)</option>
                        <option value="sqyd">Square Yards (sq yd)</option>
                        <option value="sqcm">Square Centimeters (sq cm)</option>
                        <option value="sqm">Square Meters (sq m)</option>
                      </>
                    )}
                    {editingTakeoff.type === 'count' && (
                      <option value="each">Each</option>
                    )}
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-ink mb-1.5">Cost Per Unit ($)</label>
                  <input
                    type="text"
                    disabled={isEditTakeoffAdvanced}
                    value={isEditTakeoffAdvanced ? '' : editTakeoffCostPerUnit}
                    onChange={(e) => setEditTakeoffCostPerUnit(e.target.value)}
                    onBlur={() => {
                      if (editTakeoffCostPerUnit.startsWith('=')) {
                        const result = evaluateMathExpression(editTakeoffCostPerUnit);
                        if (result !== null) setEditTakeoffCostPerUnit(result.toString());
                      }
                    }}
                    className="w-full border border-edge-strong rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-raised text-ink disabled:bg-sunken disabled:text-ink-faint"
                    placeholder={isEditTakeoffAdvanced ? "Disabled in Advanced" : "0.00 or =95*40%"}
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 py-2">
                <input
                  data-testid="toggle-advanced-cost"
                  type="checkbox"
                  id="isEditTakeoffAdvanced"
                  checked={isEditTakeoffAdvanced}
                  onChange={(e) => setIsEditTakeoffAdvanced(e.target.checked)}
                  className="w-4 h-4 text-accent-600 rounded border-edge-strong focus:ring-accent-500"
                />
                <label htmlFor="isEditTakeoffAdvanced" className="text-sm font-medium text-ink cursor-pointer">
                  Advanced Costing (Custom Items)
                </label>
              </div>

              {isEditTakeoffAdvanced && (
                <div className="mt-4 pt-4 border-t border-edge">
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-xs font-bold text-ink-faint uppercase tracking-wider">Advanced Costing</h4>
                    <button
                      onClick={() => setEditTakeoffCustomCosts([...editTakeoffCustomCosts, { id: uuidv4(), name: '', type: 'unit', costPerUnit: '0' }])}
                      className="text-[10px] flex items-center gap-1 text-accent-600 hover:text-accent-700 font-bold uppercase tracking-tight"
                    >
                      <Plus size={12} />
                      Add Cost Item
                    </button>
                  </div>
                  <div className="space-y-3">
                    {editTakeoffCustomCosts.map((cost, idx) => (
                      <CustomCostRow
                        key={cost.id}
                        item={cost}
                        index={idx}
                        unitLabel={UNIT_LABELS[editTakeoffUnit as keyof typeof UNIT_LABELS] || editTakeoffUnit || 'unit'}
                        unitPlaceholder="e.g. days"
                        onChange={(index, updated) => {
                          const newCosts = [...editTakeoffCustomCosts];
                          newCosts[index] = updated;
                          setEditTakeoffCustomCosts(newCosts);
                        }}
                        onRemove={(index) => {
                          setEditTakeoffCustomCosts(editTakeoffCustomCosts.filter((_, i) => i !== index));
                        }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="p-6 border-t border-edge bg-sunken flex justify-end gap-3">
              <button
                onClick={() => setEditingTakeoff(null)}
                className="px-5 py-2.5 text-sm font-medium text-ink-soft hover:bg-hover active:scale-95 rounded-xl transition-all"
              >
                Cancel
              </button>
              <button
                data-testid="btn-save-takeoff"
                onClick={handleSaveEditTakeoff}
                disabled={!editTakeoffName}
                className="px-5 py-2.5 text-sm font-medium text-white bg-accent-600 hover:bg-accent-700 disabled:opacity-50 disabled:cursor-not-allowed active:scale-95 rounded-xl transition-all shadow-sm"
              >
                Save Changes
              </button>
            </div>
          </div>
        </div>
      )}
      {/* Heights Modal */}
      {heightsModalMeasurementId && (
        <HeightsModal
          measurement={aggregatedMeasurements.find(m => m.id === heightsModalMeasurementId)!}
          scaleConfig={page.scaleConfig}
          onClose={() => setHeightsModalMeasurementId(null)}
          onSave={(heights, isTwoSided) => {
            updateMeasurement(heightsModalMeasurementId, { heights, isTwoSided });
            setHeightsModalMeasurementId(null);
          }}
        />
      )}
      {/* Multiplier Modal */}
      {multiplierModalMeasurementId && (() => {
        const target = aggregatedMeasurements.find(m => m.id === multiplierModalMeasurementId);
        if (!target) return null;
        return (
          <MultiplierModal
            measurementName={target.name}
            multiplier={measurementMultiplier(target)}
            onClose={() => setMultiplierModalMeasurementId(null)}
            onSave={(n) => {
              if (n !== measurementMultiplier(target)) updateMeasurement(target.id, multiplierPatch(n));
              setMultiplierModalMeasurementId(null);
            }}
          />
        );
      })()}
      {/* Keyboard Shortcuts Help Modal */}
      <KeyboardShortcutsModal open={showShortcutsHelp} onClose={() => setShowShortcutsHelp(false)} />
      {/* Tool Disabled Message Modal */}
      <ToolDisabledModal message={toolDisabledMessage} onClose={() => setToolDisabledMessage(null)} />
    </div>
  );
};

export const CanvasView: React.FC = () => {
  const { pageId } = useParams<{ pageId: string }>();
  const [userName, setUserName] = useState('');
  const [userColor, setUserColor] = useState('');

  useEffect(() => {
    const storedName = localStorage.getItem('userName');
    if (storedName) {
      setUserName(storedName);
    } else {
      const newName = `User${Math.floor(Math.random() * 1000)}`;
      localStorage.setItem('userName', newName);
      setUserName(newName);
    }

    const storedColor = localStorage.getItem('userColor');
    if (storedColor) {
      setUserColor(storedColor);
    }
  }, []);

  if (!userName) return null;

  return (
    <CanvasViewInner />
  );
};

function ToolButton({
  active,
  onClick,
  icon,
  label,
  disabled = false,
  onDisabledClick,
  className = "",
  testId,
  showLabel = false,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
  disabled?: boolean;
  onDisabledClick?: () => void;
  className?: string;
  testId?: string;
  /** When set, render a small visible text label beside the icon on touch
      devices (where `title` tooltips don't appear). Hidden on hover-capable
      pointers so the desktop toolbar stays icon-only and compact. */
  showLabel?: boolean;
}) {
  return (
    <button
      data-testid={testId}
      onClick={disabled ? onDisabledClick : onClick}
      title={label}
      aria-label={label}
      className={`
        flex items-center justify-center gap-1.5 p-2 md:p-2.5 rounded-lg border transition-all active:scale-95
        ${disabled ? 'opacity-50 bg-sunken border-edge text-ink-faint' :
          active
            ? 'bg-accent-50 border-accent-200 text-accent-700 shadow-sm'
            : 'bg-raised border-edge text-ink-soft hover:bg-hover hover:border-edge-strong'}
        ${className}
      `}
    >
      {icon}
      {showLabel && <span className="can-hover:hidden text-xs font-medium whitespace-nowrap">{label}</span>}
    </button>
  );
}

function HeightsModal({ 
  measurement, 
  scaleConfig,
  onClose, 
  onSave 
}: { 
  measurement: Measurement;
  scaleConfig: ScaleConfig | null;
  onClose: () => void;
  onSave: (heights: number[], isTwoSided: boolean) => void;
}) {
  const hasExistingPerPoint = measurement.heights && measurement.heights.length > 1 &&
    measurement.heights.some((h, i) => i > 0 && h !== measurement.heights![0]);
  const [perPoint, setPerPoint] = useState(hasExistingPerPoint || false);
  const [globalHeight, setGlobalHeight] = useState<string>(
    measurement.heights ? (measurement.heights[0]?.toString() || '') : ''
  );
  const [heights, setHeights] = useState<string[]>(
    measurement.heights?.map(h => h.toString()) || Array(measurement.points.length).fill('')
  );
  const [isTwoSided, setIsTwoSided] = useState(measurement.isTwoSided || false);

  const handleSave = () => {
    const numHeights = perPoint
      ? heights.map(h => parseFloat(h) || 0)
      : Array(measurement.points.length).fill(parseFloat(globalHeight) || 0);
    onSave(numHeights, isTwoSided);
  };

  const handleTogglePerPoint = (enabled: boolean) => {
    setPerPoint(enabled);
    if (enabled) {
      const val = globalHeight;
      setHeights(Array(measurement.points.length).fill(val));
    }
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-raised rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
        <div className="p-6 border-b border-edge">
          <h3 className="text-lg font-semibold text-ink">Wall Heights</h3>
          <p className="text-sm text-ink-soft mt-1">Enter the height to calculate surface area.</p>
        </div>
        <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto">
          {!perPoint && (
            <div className="flex items-center gap-4">
              <label className="text-sm font-medium text-ink w-20">Height</label>
              <div className="flex-1 relative">
                <NumberInput allowEmpty unstyled
                  value={globalHeight}
                  onChange={e => setGlobalHeight(e.target.value)}
                  className="w-full border border-edge-strong rounded-lg px-3 py-2 pr-8 focus:outline-none focus:ring-2 focus:ring-accent-500"
                  placeholder="Height"
                  autoFocus
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ink-faint">
                  {scaleConfig?.unit || 'px'}
                </span>
              </div>
            </div>
          )}
          {perPoint && measurement.points.map((_p, i) => (
            <div key={i} className="flex items-center gap-4">
              <label className="text-sm font-medium text-ink w-20">Point {i + 1}</label>
              <div className="flex-1 relative">
                <NumberInput allowEmpty unstyled
                  value={heights[i]}
                  onChange={e => {
                    const newHeights = [...heights];
                    newHeights[i] = e.target.value;
                    setHeights(newHeights);
                  }}
                  className="w-full border border-edge-strong rounded-lg px-3 py-2 pr-8 focus:outline-none focus:ring-2 focus:ring-accent-500"
                  placeholder="Height"
                />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-ink-faint">
                  {scaleConfig?.unit || 'px'}
                </span>
              </div>
            </div>
          ))}
          <div className="pt-3 space-y-3 border-t border-edge">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={perPoint}
                onChange={e => handleTogglePerPoint(e.target.checked)}
                className="w-4 h-4 text-accent-600 rounded border-edge-strong focus:ring-accent-500"
              />
              <span className="text-sm font-medium text-ink">Different height at each point</span>
            </label>
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={isTwoSided}
                onChange={e => setIsTwoSided(e.target.checked)}
                className="w-4 h-4 text-accent-600 rounded border-edge-strong focus:ring-accent-500"
              />
              <span className="text-sm font-medium text-ink">Two-sided wall (doubles the area)</span>
            </label>
          </div>
        </div>
        <div className="p-6 border-t border-edge bg-sunken flex justify-end gap-3">
          <button onClick={onClose} className="px-5 py-2.5 text-sm font-medium text-ink-soft hover:bg-hover rounded-xl transition-colors">Cancel</button>
          <button onClick={handleSave} className="px-5 py-2.5 text-sm font-medium text-white bg-accent-600 hover:bg-accent-700 rounded-xl transition-colors shadow-sm">Save Heights</button>
        </div>
      </div>
    </div>
  );
}
