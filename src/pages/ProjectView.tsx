import React, { useEffect, useState, useRef, useMemo } from 'react';
import { useParams, Link, useNavigate, useLocation, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Settings, Loader2, Upload, Hash, ZoomIn, ZoomOut, Maximize, Calendar, Building2, MapPin, Clock, Mail, HardDrive, Layers, GitCompare, SlidersHorizontal } from 'lucide-react';
import { Project, MeasurementTakeoff, ProjectPage, TakeoffTemplate, CustomCost, ProjectNote } from '../types';
import { getProject, saveProject, getImageUrl, saveImage, saveBinaryFile, getFile, getTemplates, getProjectNotes, saveProjectNotes, getUserPreferences, saveUserPreferences, createProposal, getProjectStorage, formatBytes, ProjectStorage, recordRecentProject, TaskListItem, getTasks } from '../utils/store';
import { takeoffPrintName, takeoffPrintsUrl } from '../utils/takeoffPrintNames';
import { calculateTakeoffTotalCost, evaluateMathExpression } from '../utils/math';
import { buildTakeoffExcelRows } from './project/takeoffExcel';
import { loadPdfPagesGenerator } from '../utils/pdf';
import { computeRevisionModel, orderedPlanSets, summarizePlanSet, effectiveSheetId, carryForwardFrom } from '../utils/planSets';
import { readSheet, matchSheet, runWithConcurrency, applyReadToPage, applyMatchToPage, aiAutoNameEnabled, warmupAi, getAiIdleTimeoutMs, waitForAiReady, type AiScanProgress } from '../utils/aiSheets';
import { composePageName, nextPlaceholderStart } from '../utils/sheetNaming';
import { PlanSetManager } from '../components/PlanSetManager';
import { PlanSetRevisions } from '../components/PlanSetRevisions';
import { PlanSetCompare } from '../components/PlanSetCompare';
import { AddPagesModal } from '../components/AddPagesModal';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
// @ts-ignore
import pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;
import { v4 as uuidv4 } from 'uuid';
import * as XLSX from 'xlsx';
import { NewTakeoffModal } from '../components/NewTakeoffModal';
import { UploadFailuresModal, UploadFailure } from '../components/UploadFailuresModal';
import { StickyNote, ListChecks } from 'lucide-react';
import { useNotes } from '../context/NotesContext';
import { useCollaboration } from '../context/CollaborationContext';
import { useToast } from '../components/Toast';
import { useConfirm } from '../components/ConfirmDialog';
import { useShare } from '../components/ShareLinkModal';
import { Skeleton } from '../components/Skeleton';
import { ProjectStageControl } from '../components/ProjectStageControl';
import {
  buildHighlightsPdf,
  computeTakeoffTotals,
  HighlightQuality,
  normalizeHighlightQuality,
} from './project/proposal/proposalGenerator';
import { shrinkPdfToBudget, EMAIL_TARGET_BYTES } from './project/proposal/shrinkPdf';
import { optionDefaultsFromPrefs } from './project/proposal/proposalPrefs';
import { EmailTab } from './project/EmailTab';
import { ProjectPagesTab } from './project/ProjectPagesTab';
import { ProjectTakeoffsTab } from './project/ProjectTakeoffsTab';
import { UpcomingTasksCard, upcomingTaskItems } from '../components/tasks/UpcomingTasksCard';
import { TakeoffEditModal } from './project/TakeoffEditModal';
import { TakeoffDeleteModals } from './project/TakeoffDeleteModals';
import { useLiveQuery } from '../hooks/useLiveQuery';

// Renders `text` with the first case-insensitive occurrence of `term` wrapped
// in <mark> so search hits visibly pop out of page titles and snippets. No
// match → text renders unchanged. Multi-occurrence highlighting is overkill
// for page titles (one match is enough) and we keep snippets short anyway.
const PROJECT_TAB_VALUES = ['pages', 'takeoffs', 'email'] as const;
type ProjectTab = (typeof PROJECT_TAB_VALUES)[number];

export const ProjectView: React.FC = () => {
  const { openNotes } = useNotes();
  const { setPageName, sessions, mySessionId } = useCollaboration();
  const { toast } = useToast();
  const confirm = useConfirm();
  const share = useShare();
  const { projectId } = useParams<{ projectId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  const searchTerm = searchParams.get('search') || '';
  const setSearchTerm = (term: string) => {
    if (term) {
      searchParams.set('search', term);
    } else {
      searchParams.delete('search');
    }
    setSearchParams(searchParams, { replace: true });
  };
  const [project, setProject] = useState<Project | null>(null);
  const [projectTasks, setProjectTasks] = useState<TaskListItem[] | null>(null);
  const [takeoffToDelete, setTakeoffToDelete] = useState<string | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showDeleteAllConfirm, setShowDeleteAllConfirm] = useState(false);
  // Tab lives in the URL so the project sidebar can highlight the section,
  // refresh/back preserve it, and links can target a tab directly.
  const tabParam = searchParams.get('tab');
  const activeTab: ProjectTab = (PROJECT_TAB_VALUES as readonly string[]).includes(tabParam ?? '')
    ? (tabParam as ProjectTab)
    : 'pages';
  const setActiveTab = (tab: ProjectTab) => {
    setSearchParams(prev => {
      const next = new URLSearchParams(prev);
      if (tab === 'pages') next.delete('tab');
      else next.set('tab', tab);
      return next;
    }, { replace: true });
  };
  const [isLoading, setIsLoading] = useState(true);
  const [projectStorage, setProjectStorage] = useState<ProjectStorage | null>(null);
  const [projectNote, setProjectNote] = useState<ProjectNote | null>(null);
  const [showTakeoffModal, setShowTakeoffModal] = useState(false);
  const [templates, setTemplates] = useState<TakeoffTemplate[]>([]);

  const [selectedTakeoffIds, setSelectedTakeoffIds] = useState<Set<string>>(new Set());
  const [selectedPageIds, setSelectedPageIds] = useState<Set<string>>(new Set());
  // Pages-tab layout: grid is the default (thumbnail-first browsing), list is
  // better when descriptions matter more than the visual since the grid cell
  // truncates them. Persisted per-user via getUserPreferences (see the load
  // effect that hydrates other preferences).
  const [pagesViewMode, setPagesViewMode] = useState<'grid' | 'list'>('grid');
  // Sort order for the pages list. Numeric sort by pageNumber is the default
  // (matches typical drawing-set conventions: A-101 before A-201 etc.).
  // Persisted per-user under 'pages-sortMode'.
  type PagesSortMode = 'pageNumber' | 'description' | 'highlightsDesc';
  const [pagesSortMode, setPagesSortMode] = useState<PagesSortMode>('pageNumber');
  // Right-click context menu for page tiles/rows. Stored as viewport coords
  // so the menu renders correctly regardless of the underlying page card's
  // position. Cleared on any outside click or Escape.
  const [pageContextMenu, setPageContextMenu] = useState<{ pageId: string; x: number; y: number } | null>(null);
  const pageSearchInputRef = useRef<HTMLInputElement>(null);
  // Per-user, per-project favorites. Stored in userPreferences under
  // `pages-favorites-{projectId}` as a JSON array; loaded on project mount
  // and saved on every toggle. Favorited pages sort to the top of the page
  // list inside whatever sort mode is active.
  const [favoritePageIds, setFavoritePageIds] = useState<Set<string>>(new Set());
  const pagesScrollRef = useRef<HTMLDivElement>(null);
  const [editTakeoffPricePackage, setEditTakeoffPricePackage] = useState('');
  const [isPrinting, setIsPrinting] = useState(false);
  const [isExportingExcel, setIsExportingExcel] = useState(false);
  const [progressMessage, setProgressMessage] = useState('');
  // Blueprint print quality for the Print (highlighted plans) export. Persisted
  // per-user via the proposal-prefs effect below since it's shared with the
  // proposal section's highlight quality.
  const [highlightQuality, setHighlightQuality] = useState<HighlightQuality>('best');

  // ── Scroll position memory for pages tab ─────────────────────────────────
  const scrollKey = `projectView-scroll-${projectId}`;
  // Wait for content to load before restoring — firing during isLoading=true
  // restores onto an empty page which then gets reset when content appears.
  useEffect(() => {
    if (activeTab !== 'pages' || isLoading) return;
    const saved = sessionStorage.getItem(scrollKey);
    if (saved) {
      requestAnimationFrame(() => window.scrollTo({ top: parseInt(saved, 10), behavior: 'instant' as ScrollBehavior }));
    }
  }, [activeTab, isLoading]);

  useEffect(() => {
    if (activeTab !== 'pages') return;
    const onScroll = () => sessionStorage.setItem(scrollKey, String(Math.round(window.scrollY)));
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [activeTab, scrollKey]);

  // Update collaboration page name when project loads
  useEffect(() => {
    if (project) setPageName(project.name);
  }, [project, setPageName]);

  // Load saved prefs on mount from the server (source of truth). The proposal
  // section owns the bulk of proposal preferences now; ProjectView only still
  // reads the shared blueprint print quality (used by the Print export) plus
  // the pages-tab view/sort modes.
  useEffect(() => {
    getUserPreferences().then(prefs => {
      if (prefs['proposal-highlightQuality'])             setHighlightQuality(normalizeHighlightQuality(prefs['proposal-highlightQuality']));
      if (prefs['pages-viewMode'] === 'grid' || prefs['pages-viewMode'] === 'list') setPagesViewMode(prefs['pages-viewMode']);
      const sort = prefs['pages-sortMode'];
      // 'name' was an earlier option that effectively duplicated pageNumber
      // sort (the auto-built name string is prefixed by the page number, so
      // it dominated the order). Anyone who picked it back then is promoted
      // to description sort, which is what the option was meant to do.
      if (sort === 'pageNumber' || sort === 'description' || sort === 'highlightsDesc') setPagesSortMode(sort);
      else if (sort === 'name') setPagesSortMode('description');
    }).catch(() => { /* offline — defaults already applied */ });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Persist the pages-tab view mode + sort separately from the proposal
  // prefs — these are UI preferences, not part of proposal generation.
  useEffect(() => {
    saveUserPreferences({ 'pages-viewMode': pagesViewMode, 'pages-sortMode': pagesSortMode }).catch(() => {});
  }, [pagesViewMode, pagesSortMode]);

  // Keyboard shortcut: "/" focuses the search box (GitHub-style). Skip if the
  // user is already typing into something — we don't want to clobber an in-
  // progress rename or note. Also skip when the Pages tab isn't active since
  // there's no search input on screen to focus.
  useEffect(() => {
    if (activeTab !== 'pages') return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.ctrlKey || e.metaKey || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable) return;
      }
      e.preventDefault();
      pageSearchInputRef.current?.focus();
      pageSearchInputRef.current?.select();
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [activeTab]);

  // Close the page-card context menu on outside click or Escape.
  useEffect(() => {
    if (!pageContextMenu) return;
    const onClick = () => setPageContextMenu(null);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPageContextMenu(null); };
    window.addEventListener('mousedown', onClick);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onClick);
      window.removeEventListener('keydown', onKey);
    };
  }, [pageContextMenu]);

  // Persist the shared blueprint print quality to the server (cross-browser).
  // The proposal section owns the rest of the proposal preferences.
  useEffect(() => {
    saveUserPreferences({ 'proposal-highlightQuality': highlightQuality }).catch(() => {});
  }, [highlightQuality]);

  const [editingTakeoff, setEditingTakeoff] = useState<MeasurementTakeoff | null>(null);
  const [editTakeoffName, setEditTakeoffName] = useState('');
  const [editTakeoffColor, setEditTakeoffColor] = useState('');
  const [editTakeoffUnit, setEditTakeoffUnit] = useState('');
  const [editTakeoffCostPerUnit, setEditTakeoffCostPerUnit] = useState<number | ''>('');
  const [isEditTakeoffAdvanced, setIsEditTakeoffAdvanced] = useState(false);
  const [editTakeoffCustomCosts, setEditTakeoffCustomCosts] = useState<any[]>([]);

  // Live-refresh guard: a foreign 'project' change-feed event (another user
  // deleting this takeoff) can now update `project` while the edit modal is
  // still open for it. Before live refresh existed, a save against the stale
  // local copy would 409 and surface a conflict toast; without this guard the
  // save would instead silently no-op (project.takeoffs.map's id match just
  // fails), which is worse — a real edit the user thinks they made simply
  // vanishes. So close the modal and tell them the moment the takeoff
  // disappears from underneath it, rather than waiting for a doomed save.
  useEffect(() => {
    if (!editingTakeoff || !project) return;
    const stillExists = project.takeoffs.some(t => t.id === editingTakeoff.id);
    if (!stillExists) {
      setEditingTakeoff(null);
      toast('This takeoff was deleted by another user', { type: 'warning' });
    }
  }, [project, editingTakeoff]); // eslint-disable-line react-hooks/exhaustive-deps

  const [expandedTakeoffs, setExpandedTakeoffs] = useState<Record<string, boolean>>({});
  const [expandedTakeoffPages, setExpandedTakeoffPages] = useState<Record<string, boolean>>({});
  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const [editingPageName, setEditingPageName] = useState('');
  const [editingPageNumber, setEditingPageNumber] = useState('');
  const [editingPageDescription, setEditingPageDescription] = useState('');
  const [isAddingPages, setIsAddingPages] = useState(false);
  const [addProgress, setAddProgress] = useState({ status: '', current: 0, total: 0, currentFile: 0, totalFiles: 0 });
  const [selectedPlanSetId, setSelectedPlanSetId] = useState<string>('');
  const [showAddPagesModal, setShowAddPagesModal] = useState(false);
  const [addPagesStep, setAddPagesStep] = useState<'details' | 'name_pages'>('details');
  const [isNamingExistingPages, setIsNamingExistingPages] = useState(false);
  const [pendingPages, setPendingPages] = useState<any[]>([]);
  const [pendingThumbnails, setPendingThumbnails] = useState<Record<string, string>>({});
  // Medium-res per-page images for AI reading, kept so the manual "AI Scan"
  // button can re-run reads without re-rendering the PDF.
  const [aiImages, setAiImages] = useState<Record<string, string>>({});
  const [newPlanSetName, setNewPlanSetName] = useState('');
  const [newPlanSetDate, setNewPlanSetDate] = useState(new Date().toISOString().split('T')[0]);
  const [newPlanSetFiles, setNewPlanSetFiles] = useState<File[]>([]);
  const [useExistingPlanSet, setUseExistingPlanSet] = useState(false);
  const [targetPlanSetId, setTargetPlanSetId] = useState('');
  const [showManagePlanSets, setShowManagePlanSets] = useState(false);
  const [showRevisionsForPageId, setShowRevisionsForPageId] = useState<string | null>(null);
  const [comparePageId, setComparePageId] = useState<string | null>(null);
  // Sheets grid: superseded (older, read-only) revisions are hidden by default;
  // this toggle folds them into the grid (dimmed, with a read-only badge).
  const [showSuperseded, setShowSuperseded] = useState(false);

  // Upload-failures modal state (mirrors NewProject.tsx) — keeps source File
  // objects so the user can retry missing pages from the existing flow.
  const [uploadFailures, setUploadFailures] = useState<UploadFailure[]>([]);
  const [uploadFilesByName, setUploadFilesByName] = useState<Map<string, File>>(new Map());
  const [uploadTotals, setUploadTotals] = useState({ processed: 0, expected: 0 });
  const [showUploadFailuresModal, setShowUploadFailuresModal] = useState(false);
  const [isRetryingUpload, setIsRetryingUpload] = useState(false);
  const [retryProgress, setRetryProgress] = useState({ status: '', current: 0, total: 0, fileName: '' });
  const [retryPlanSetId, setRetryPlanSetId] = useState<string>('');
  // Project name/contractor/address/due-date are edited in the admin Project
  // Settings section (/project/:id/settings); the header shows them read-only.
  const isAdmin = (() => {
    try { return JSON.parse(localStorage.getItem('user') || '{}').role === 'admin'; }
    catch { return false; }
  })();
  const [isOptimizingThumbnails, setIsOptimizingThumbnails] = useState(false);
  const [optimizeProgress, setOptimizeProgress] = useState({ current: 0, total: 0 });
  const fileInputRef = useRef<HTMLInputElement>(null);
  const imageContainerRef = useRef<HTMLDivElement>(null);

  const removeNewPlanSetFile = (indexToRemove: number) => {
    setNewPlanSetFiles(newPlanSetFiles.filter((_, index) => index !== indexToRemove));
  };

  // Rename / re-date a plan set in place. Optimistic with rollback.
  const handleUpdatePlanSet = async (id: string, patch: { name?: string; date?: string }) => {
    if (!project) return;
    const previous = project;
    const updated = {
      ...project,
      planSets: (project.planSets || []).map(ps => ps.id === id ? { ...ps, ...patch } : ps),
    };
    setProject(updated);
    try {
      await saveProject(updated);
    } catch {
      setProject(previous);
      toast('Failed to update plan set', { type: 'error' });
    }
  };

  // Delete a plan set and every page that belongs to it. Destructive, so it's
  // gated behind a confirm. Measurements on those pages go with them.
  const handleDeletePlanSet = async (id: string) => {
    if (!project) return;
    const set = (project.planSets || []).find(ps => ps.id === id);
    const pageCount = project.pages.filter(p => p.planSetId === id).length;
    if (!await confirm({
      title: 'Delete plan set',
      message: `Delete "${set?.name || 'this plan set'}" and its ${pageCount} page${pageCount === 1 ? '' : 's'} (including any measurements on them)? This cannot be undone.`,
      confirmLabel: 'Delete plan set',
      tone: 'danger',
    })) return;
    const previous = project;
    const updated = {
      ...project,
      planSets: (project.planSets || []).filter(ps => ps.id !== id),
      pages: project.pages.filter(p => p.planSetId !== id),
    };
    setProject(updated);
    if (selectedPlanSetId === id) setSelectedPlanSetId('');
    try {
      await saveProject(updated);
      toast('Plan set deleted', { type: 'success' });
    } catch {
      setProject(previous);
      toast('Failed to delete plan set', { type: 'error' });
    }
  };

  useEffect(() => {
    loadTemplates();
  }, [projectId]);

  // Live refresh: reloads the project on mount, on projectId change, and on
  // foreign 'project' change-feed events (self-echo suppressed, so this
  // component's own saves don't trigger a redundant reload loop). Pulled out
  // of the effect above so it can be filter-scoped independently.
  useLiveQuery(() => { if (projectId) loadProject(projectId); }, { types: ['project'], projectId, id: projectId });

  // A 409 conflict on this tab resolves by refetching in place (see
  // ProjectConflictListener); once that refetch lands, pick it up the same
  // way any other live refresh does.
  useEffect(() => {
    const onRefreshed = (e: Event) => {
      const detail = (e as CustomEvent).detail;
      if (detail?.projectId === projectId) loadProject(projectId);
    };
    window.addEventListener('project-refreshed', onRefreshed);
    return () => window.removeEventListener('project-refreshed', onRefreshed);
  }, [projectId]);

  useEffect(() => {
    if (!projectId) return;
    getTasks({ projectId }).then(setProjectTasks).catch(() => setProjectTasks([]));
  }, [projectId]);

  useEffect(() => {
    if (location.state?.activeTab) {
      setActiveTab(location.state.activeTab);
    }
  }, [location.state]);

  // Per-project storage usage. Recomputed when the page count changes
  // (uploads and deletes are what actually move the number), since that's what
  // the server attributes a project's image bytes from.
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    getProjectStorage(projectId)
      .then(s => { if (!cancelled) setProjectStorage(s); })
      .catch(() => { if (!cancelled) setProjectStorage(null); });
    return () => { cancelled = true; };
  }, [projectId, project?.pages?.length]);

  // Backfill the search text cache from each page's source PDF. Vector pages
  // uploaded under earlier code paths may have OCR-derived extractedText
  // (less accurate) or none at all; pull text directly out of the PDF's
  // embedded text layer instead. Each page is marked searchTextIndexed=true
  // once handled, so this is a one-shot per page — subsequent project opens
  // are zero-cost. Pages without a source PDF are skipped (legacy projects
  // have no vector source to read from). Errors per page are swallowed; the
  // worst case is we just keep the existing extractedText for that page.
  useEffect(() => {
    if (!project) return;
    const needsReindex = project.pages.filter(
      p => p.sourcePdfFileId && p.sourcePdfPageNum && !p.searchTextIndexed,
    );
    if (needsReindex.length === 0) return;

    let cancelled = false;
    (async () => {
      const proxyCache = new Map<string, any>();
      const extractedByPageId = new Map<string, string>();
      try {
        for (const page of needsReindex) {
          if (cancelled) break;
          try {
            let proxy = proxyCache.get(page.sourcePdfFileId!);
            if (!proxy) {
              proxy = await pdfjsLib.getDocument({ url: getImageUrl(page.sourcePdfFileId!) }).promise;
              proxyCache.set(page.sourcePdfFileId!, proxy);
            }
            const pdfPage = await proxy.getPage(page.sourcePdfPageNum!);
            const textContent = await pdfPage.getTextContent();
            const text = (textContent.items as any[])
              .map(item => (item.str ?? '').trim())
              .filter(Boolean)
              .join(' ');
            extractedByPageId.set(page.id, text);
          } catch (e) {
            console.warn(`Failed to reindex page ${page.id} from source PDF`, e);
          }
        }
      } finally {
        for (const p of proxyCache.values()) {
          try { await p.destroy(); } catch { /* noop */ }
        }
      }

      if (cancelled || extractedByPageId.size === 0) return;

      setProject(prev => {
        if (!prev) return prev;
        const updatedPages = prev.pages.map(pg => {
          if (!extractedByPageId.has(pg.id)) return pg;
          const text = extractedByPageId.get(pg.id)!;
          // Keep the previous extractedText if the vector layer returned
          // nothing — likely an image-only page where the OCR fallback at
          // upload time produced a better string than the empty vector
          // result would.
          return {
            ...pg,
            extractedText: text || pg.extractedText,
            searchTextIndexed: true,
          };
        });
        const updated = { ...prev, pages: updatedPages };
        saveProject(updated).catch(e => console.warn('Failed to save reindexed project', e));
        return updated;
      });
    })();

    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  // Load this user's favorited page ids for the current project. Stored as a
  // JSON-encoded array under `pages-favorites-{projectId}` in user prefs.
  useEffect(() => {
    if (!project?.id) {
      setFavoritePageIds(new Set());
      return;
    }
    const key = `pages-favorites-${project.id}`;
    getUserPreferences().then(prefs => {
      const raw = prefs[key];
      if (!raw) { setFavoritePageIds(new Set()); return; }
      try {
        const ids = JSON.parse(raw);
        if (Array.isArray(ids)) setFavoritePageIds(new Set(ids.filter((s): s is string => typeof s === 'string')));
      } catch { /* malformed — ignore and start empty */ }
    }).catch(() => { /* offline: empty set */ });
  }, [project?.id]);

  // Toggles `pageId` in the favorites set and persists. Optimistic — the
  // local set updates immediately so the star re-renders without waiting on
  // the server round-trip, and the persistence call is fire-and-forget.
  const toggleFavorite = (pageId: string) => {
    if (!project?.id) return;
    setFavoritePageIds(prev => {
      const next = new Set(prev);
      if (next.has(pageId)) next.delete(pageId);
      else next.add(pageId);
      saveUserPreferences({ [`pages-favorites-${project.id}`]: JSON.stringify([...next]) }).catch(() => {});
      return next;
    });
  };

  const loadTemplates = async () => {
    const data = await getTemplates();
    setTemplates(data);
  };

  const loadProject = async (id: string) => {
    setIsLoading(true);
    const data = await getProject(id);
    if (!data) {
      navigate('/projects');
      return;
    }
    setProject(data);
    recordRecentProject(data.id, data.name);

    if (data.planSets && data.planSets.length > 0) {
      setSelectedPlanSetId('');
    }

    setIsLoading(false);
  };

  const handleDeleteTakeoff = async (takeoffId: string) => {
    setTakeoffToDelete(takeoffId);
    setShowDeleteConfirm(true);
  };

  const confirmDeleteTakeoff = async () => {
    if (!project || !takeoffToDelete) return;

    const updatedProject = {
      ...project,
      takeoffs: project.takeoffs.filter(g => g.id !== takeoffToDelete),
      pages: project.pages.map(page => ({
        ...page,
        measurements: page.measurements.map(m => 
          m.takeoffId === takeoffToDelete ? { ...m, takeoffId: undefined } : m
        )
      }))
    };

    await saveProject(updatedProject);
    setProject(updatedProject);
    setShowDeleteConfirm(false);
    setTakeoffToDelete(null);
  };

  const confirmDeleteAllTakeoffs = async () => {
    if (!project) return;
    const updatedProject = {
      ...project,
      takeoffs: [],
      pages: project.pages.map(page => ({
        ...page,
        measurements: page.measurements.map(m => ({ ...m, takeoffId: undefined }))
      }))
    };
    await saveProject(updatedProject);
    setProject(updatedProject);
    setShowDeleteAllConfirm(false);
  };

  const handleEditTakeoff = (takeoff: MeasurementTakeoff) => {
    const rawTakeoff = project?.takeoffs.find(t => t.id === takeoff.id) || takeoff;
    setEditingTakeoff(rawTakeoff);
    setEditTakeoffName(rawTakeoff.name);
    setEditTakeoffColor(rawTakeoff.color);
    setEditTakeoffUnit(rawTakeoff.unit || '');
    setEditTakeoffCostPerUnit(rawTakeoff.costPerUnit ?? '');
    setIsEditTakeoffAdvanced(rawTakeoff.isAdvancedCost || false);
    setEditTakeoffCustomCosts(rawTakeoff.customCosts || []);
    setEditTakeoffPricePackage(rawTakeoff.pricePackage || '');
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
              costPerUnit: !isEditTakeoffAdvanced && editTakeoffCostPerUnit !== '' ? Number(editTakeoffCostPerUnit) : undefined,
              isAdvancedCost: isEditTakeoffAdvanced,
              customCosts: isEditTakeoffAdvanced ? editTakeoffCustomCosts.map(c => ({
                ...c,
                cost: evaluateMathExpression(c.cost?.toString() || '') ?? 0,
                yield: evaluateMathExpression(c.yield?.toString() || '') ?? 0,
                costPerUnit: evaluateMathExpression(c.costPerUnit?.toString() || '') ?? 0,
                amount: evaluateMathExpression(c.amount?.toString() || '') ?? 0,
                perUnits: evaluateMathExpression(c.perUnits?.toString() || '') ?? 0,
              })) : undefined,
              pricePackage: editTakeoffPricePackage.trim() || undefined,
            }
          : g
      ),
      pages: project.pages.map(page => ({
        ...page,
        measurements: page.measurements.map(m => 
          m.takeoffId === editingTakeoff.id 
            ? { ...m, color: editTakeoffColor }
            : m
        )
      }))
    };

    await saveProject(updatedProject);
    setProject(updatedProject);
    setEditingTakeoff(null);
  };

  const toggleTakeoffExpanded = (takeoffId: string) => {
    setExpandedTakeoffs(prev => ({
      ...prev,
      [takeoffId]: !prev[takeoffId]
    }));
  };

  const toggleTakeoffPageExpanded = (takeoffId: string, pageId: string) => {
    const key = `${takeoffId}__${pageId}`;
    setExpandedTakeoffPages(prev => ({
      ...prev,
      [key]: !prev[key]
    }));
  };

  const handleStartRenamePage = (e: React.MouseEvent, page: ProjectPage) => {
    e.preventDefault();
    e.stopPropagation();
    
    const viewers = sessions.filter(s => s.sessionId !== mySessionId && s.location?.pageId === page.id);
    if (viewers.length) {
      toast(`"${page.name}" is being viewed by ${viewers[0].name} — try again when they leave`, { type: 'warning' });
      return;
    }
    
    setEditingPageId(page.id);
    setEditingPageName(page.name);
    setEditingPageNumber(page.pageNumber || '');
    setEditingPageDescription(page.description || '');
  };

  const handleSaveRenamePage = async (e: React.MouseEvent, pageId: string) => {
    e.preventDefault();
    e.stopPropagation();
    if (!project) return;

    const num = editingPageNumber.trim();
    const desc = editingPageDescription.trim();
    const newName = composePageName(num, desc, editingPageName.trim());

    if (!newName) return;

    const updatedProject = {
      ...project,
      pages: project.pages.map(p => p.id === pageId ? { 
        ...p, 
        name: newName,
        pageNumber: num,
        description: desc
      } : p)
    };

    await saveProject(updatedProject);
    setProject(updatedProject);
    setEditingPageId(null);
  };

  const handleCancelRenamePage = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setEditingPageId(null);
  };

  const handleAddPages = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPlanSetFiles.length === 0 || !project || (!newPlanSetName && !useExistingPlanSet)) return;

    setIsAddingPages(true);
    try {
      const planSetId = useExistingPlanSet ? targetPlanSetId : uuidv4();
      let updatedProject = { 
        ...project,
        pages: [...project.pages]
      };

      if (!useExistingPlanSet) {
        const newPlanSet = {
          id: planSetId,
          name: newPlanSetName,
          date: newPlanSetDate,
          createdAt: Date.now(),
        };
        updatedProject = {
          ...updatedProject,
          planSets: [...(updatedProject.planSets || []), newPlanSet]
        };
      }

      const extractedPages: any[] = [];
      const thumbnails: Record<string, string> = {};
      // Transient per-page medium-res images for AI reading (not stored).
      const aiImages: Record<string, string> = {};
      // Render the AI image whenever auto-naming is on so the manual "AI Scan"
      // button always has a good image; the auto pass also requires readiness.
      const aiWanted = aiAutoNameEnabled();

      // Placeholder sequence is scoped to the TARGET plan set (a brand new set
      // naturally starts at 1 since no page yet carries its fresh id). Seeded
      // from the max existing NUMERIC page number in the set (not the page
      // count) so a fresh placeholder can never collide with a real page
      // number already in the set — e.g. a set holding "1","2","10" must
      // start the next placeholder at 11, not 4.
      let startingPageNum = nextPlaceholderStart(project.pages, planSetId);
      const failures: Array<{ fileName: string; pageNum: number | null; reason: string }> = [];
      let totalExpected = 0;
      let totalProcessed = 0;

      for (let i = 0; i < newPlanSetFiles.length; i++) {
        const file = newPlanSetFiles[i];
        setAddProgress(prev => ({ ...prev, currentFile: i + 1, totalFiles: newPlanSetFiles.length }));

        // Upload the source PDF once for this file. Stream the File directly
        // to the server instead of materializing a base64 dataUrl in the
        // browser — see NewProject.handleProcessFiles for the same pattern.
        let sourcePdfFileId: string | undefined;
        const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
        if (isPdf) {
          try {
            setAddProgress(prev => ({ ...prev, status: 'uploading source PDF', current: 0, total: 0 }));
            const pdfBlob = file.type === 'application/pdf' ? file : new Blob([file], { type: 'application/pdf' });
            // plan-source is multi-instance (a set is often several PDFs), so this
            // never versions a sibling — each upload keeps its own row.
            sourcePdfFileId = (await saveBinaryFile(uuidv4(), pdfBlob, {
              projectId: project.id, kind: 'plan-source', name: file.name,
              sourceType: 'plan-set', sourceId: planSetId,
            })).fileId;
          } catch (pdfErr) {
            console.warn(`Failed to upload source PDF for ${file.name} — falling back to raster only`, pdfErr);
            sourcePdfFileId = undefined;
          }
        }

        let fileExpected = 0;
        let fileYielded = 0;

        try {
          const generator = loadPdfPagesGenerator(file, (status, current, total) => {
            if (total > 0) fileExpected = total;
            setAddProgress(prev => ({ ...prev, status, current, total }));
          }, undefined, { includeFullPageRaster: !sourcePdfFileId, includeAiImage: aiWanted });

          for await (const pageData of generator) {
            fileYielded++;

            if (pageData.error) {
              failures.push({ fileName: file.name, pageNum: pageData.pageNum, reason: pageData.error });
              continue;
            }

            setAddProgress(prev => ({ ...prev, status: 'uploading', current: pageData.pageNum, total: prev.total }));

            try {
              const thumbnailId = uuidv4();
              await saveImage(thumbnailId, pageData.thumbnailDataUrl, { kind: 'plan', projectId: project.id });

              let imageId = '';
              if (!sourcePdfFileId && pageData.dataUrl) {
                imageId = uuidv4();
                await saveImage(imageId, pageData.dataUrl, { kind: 'plan', projectId: project.id });
              }
              // Thumbnails are keyed by `thumbnailId` (always set) so naming-step
              // lookups work uniformly for vector and legacy pages.
              thumbnails[thumbnailId] = pageData.thumbnailDataUrl;

              // Placeholder numbering: pages arrive named 1, 2, 3, … continuing
              // after any pages already in the target plan set (collision-safe
              // seed computed above); all real naming happens in the naming
              // modal (extract tools / AI). Sequence spans every file in the
              // batch.
              const placeholder = String(startingPageNum);

              const newPage = {
                id: uuidv4(),
                name: composePageName(placeholder, ''),
                pageNumber: placeholder,
                description: '',
                imageId,
                thumbnailId,
                imageWidth: pageData.width,
                imageHeight: pageData.height,
                sourcePdfFileId,
                sourcePdfPageNum: sourcePdfFileId ? pageData.pageNum : undefined,
                searchTextIndexed: !!sourcePdfFileId,
                extractedText: pageData.extractedText,
                detectionConfidence: 'low' as const,
              };

              extractedPages.push(newPage);
              if (pageData.aiImageDataUrl) aiImages[newPage.id] = pageData.aiImageDataUrl;

              const newProjectPage = {
                id: newPage.id,
                name: newPage.name,
                pageNumber: newPage.pageNumber,
                description: newPage.description,
                imageId: newPage.imageId,
                thumbnailId: newPage.thumbnailId,
                imageWidth: newPage.imageWidth,
                imageHeight: newPage.imageHeight,
                sourcePdfFileId: newPage.sourcePdfFileId,
                sourcePdfPageNum: newPage.sourcePdfPageNum,
                searchTextIndexed: !!newPage.sourcePdfFileId,
                extractedText: newPage.extractedText,
                measurements: [],
                scaleConfig: null,
                planSetId,
              };

              updatedProject = {
                ...updatedProject,
                pages: [...updatedProject.pages, newProjectPage]
              };

              totalProcessed++;

              if (startingPageNum % 5 === 0) {
                try {
                  await saveProject(updatedProject);
                  setProject(updatedProject);
                } catch (saveErr) {
                  console.warn('Periodic saveProject failed', saveErr);
                }
              }

              startingPageNum++;
            } catch (perPageErr) {
              console.warn(`Save failed for ${file.name} page ${pageData.pageNum}`, perPageErr);
              failures.push({
                fileName: file.name,
                pageNum: pageData.pageNum,
                reason: String((perPageErr as any)?.message || perPageErr),
              });
            }
          }
        } catch (genErr) {
          console.error(`PDF processing aborted for ${file.name}`, genErr);
          failures.push({
            fileName: file.name,
            pageNum: null,
            reason: `Processing aborted: ${String((genErr as any)?.message || genErr)}`,
          });
        }

        totalExpected += fileExpected;

        if (fileExpected > fileYielded) {
          for (let p = fileYielded + 1; p <= fileExpected; p++) {
            failures.push({
              fileName: file.name,
              pageNum: p,
              reason: 'Page was never reached during processing',
            });
          }
        }

        try {
          await saveProject(updatedProject);
          setProject(updatedProject);
        } catch (saveErr) {
          console.warn('End-of-file saveProject failed', saveErr);
          failures.push({
            fileName: file.name,
            pageNum: null,
            reason: `Could not save project after processing ${file.name}: ${String((saveErr as any)?.message || saveErr)}`,
          });
        }
      }

      const hasFailures = failures.length > 0 || totalProcessed !== totalExpected;
      if (hasFailures) {
        const filesByName = new Map<string, File>();
        for (const f of newPlanSetFiles) filesByName.set(f.name, f);
        setUploadFilesByName(filesByName);
        setUploadFailures(failures);
        setUploadTotals({ processed: totalProcessed, expected: totalExpected });
        setRetryPlanSetId(planSetId);
        setShowUploadFailuresModal(true);
      }

      if (totalProcessed === 0) {
        setIsAddingPages(false);
        setAddProgress({ status: '', current: 0, total: 0, currentFile: 0, totalFiles: 0 });
        return;
      }

      setPendingPages(extractedPages);
      setPendingThumbnails(thumbnails);
      setAiImages(aiImages);
      setAddPagesStep('name_pages');
    } catch (error) {
      console.error('Error processing PDFs:', error);
      toast('Failed to process PDF. Please try another file.', { type: 'error' });
    } finally {
      setIsAddingPages(false);
      setAddProgress({ status: '', current: 0, total: 0, currentFile: 0, totalFiles: 0 });
    }
  };

  // Re-render and re-import each failure in the modal. Same per-page logic
  // as the original upload, with page-level failures using the pageNums
  // filter and file-level failures re-running the full file.
  const handleRetryFailedPages = async () => {
    if (!project || uploadFailures.length === 0 || !retryPlanSetId) return;
    setIsRetryingUpload(true);
    setRetryProgress({ status: '', current: 0, total: 0, fileName: '' });

    try {
      const freshProject = await getProject(project.id);
      if (!freshProject) throw new Error('Project not found');
      let workingProject: Project = freshProject;

      const byFile = new Map<string, { pageNums: number[]; allPages: boolean }>();
      for (const f of uploadFailures) {
        const entry = byFile.get(f.fileName) ?? { pageNums: [], allPages: false };
        if (f.pageNum == null) entry.allPages = true;
        else entry.pageNums.push(f.pageNum);
        byFile.set(f.fileName, entry);
      }

      const remainingFailures: UploadFailure[] = [];
      const newPendingPages: any[] = [];
      const newThumbnails: Record<string, string> = {};
      let newlyProcessed = 0;
      // Placeholder sequence is scoped to the TARGET plan set, matching the
      // main upload run's collision-safe (max-numeric-based) seed so retried
      // pages continue the same numbering without colliding with real pages.
      let nextPageNum = nextPlaceholderStart(workingProject.pages, retryPlanSetId);

      for (const [fileName, info] of byFile) {
        const file = uploadFilesByName.get(fileName);
        if (!file) {
          if (info.allPages) {
            remainingFailures.push({ fileName, pageNum: null, reason: 'Source file no longer available for retry' });
          }
          for (const p of info.pageNums) {
            remainingFailures.push({ fileName, pageNum: p, reason: 'Source file no longer available for retry' });
          }
          continue;
        }

        // Re-upload the source PDF for this retry so the recovered pages take
        // the vector pipeline like NewProject.handleProcessFiles does. Without
        // this, retried vector pages end up with no imageId AND no
        // sourcePdfFileId, so the canvas has nothing to render.
        let sourcePdfFileId: string | undefined;
        const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
        if (isPdf) {
          try {
            const pdfBlob = file.type === 'application/pdf' ? file : new Blob([file], { type: 'application/pdf' });
            sourcePdfFileId = (await saveBinaryFile(uuidv4(), pdfBlob, {
              projectId: project.id, kind: 'plan-source', name: file.name,
              ...(retryPlanSetId ? { sourceType: 'plan-set', sourceId: retryPlanSetId } : {}),
            })).fileId;
          } catch (pdfErr) {
            console.warn(`Retry: source PDF upload failed for ${fileName}`, pdfErr);
            sourcePdfFileId = undefined;
          }
        }

        const pageNumsArg = info.allPages ? undefined : info.pageNums;
        const requestedCount = info.allPages ? 0 : info.pageNums.length;
        const succeeded = new Set<number>();
        let yielded = 0;
        let expectedFromGenerator = 0;

        try {
          const generator = loadPdfPagesGenerator(file, (status, current, total) => {
            if (info.allPages && total > 0) expectedFromGenerator = total;
            setRetryProgress({
              status,
              current,
              total: info.allPages ? total : requestedCount,
              fileName,
            });
          }, pageNumsArg, { includeFullPageRaster: !sourcePdfFileId });

          for await (const pageData of generator) {
            yielded++;

            if (pageData.error) {
              remainingFailures.push({ fileName, pageNum: pageData.pageNum, reason: pageData.error });
              continue;
            }

            try {
              const thumbnailId = uuidv4();
              await saveImage(thumbnailId, pageData.thumbnailDataUrl, { kind: 'plan', projectId: project.id });

              let imageId = '';
              if (!sourcePdfFileId && pageData.dataUrl) {
                imageId = uuidv4();
                await saveImage(imageId, pageData.dataUrl, { kind: 'plan', projectId: project.id });
              }
              newThumbnails[thumbnailId] = pageData.thumbnailDataUrl;

              // Placeholder numbering continues from the collision-safe seed
              // (nextPageNum tracks that above).
              const placeholder = String(nextPageNum);

              const newPage = {
                id: uuidv4(),
                name: composePageName(placeholder, ''),
                pageNumber: placeholder,
                description: '',
                imageId,
                thumbnailId,
                imageWidth: pageData.width,
                imageHeight: pageData.height,
                sourcePdfFileId,
                sourcePdfPageNum: sourcePdfFileId ? pageData.pageNum : undefined,
                searchTextIndexed: !!sourcePdfFileId,
                extractedText: pageData.extractedText,
                detectionConfidence: 'low' as const,
              };

              newPendingPages.push(newPage);

              const newProjectPage = {
                id: newPage.id,
                name: newPage.name,
                pageNumber: newPage.pageNumber,
                description: newPage.description,
                imageId: newPage.imageId,
                thumbnailId: newPage.thumbnailId,
                imageWidth: newPage.imageWidth,
                imageHeight: newPage.imageHeight,
                sourcePdfFileId: newPage.sourcePdfFileId,
                sourcePdfPageNum: newPage.sourcePdfPageNum,
                searchTextIndexed: !!newPage.sourcePdfFileId,
                extractedText: newPage.extractedText,
                measurements: [],
                scaleConfig: null,
                planSetId: retryPlanSetId,
              };

              workingProject = {
                ...workingProject,
                pages: [...workingProject.pages, newProjectPage],
              };

              nextPageNum++;
              newlyProcessed++;
              succeeded.add(pageData.pageNum);
            } catch (saveErr) {
              remainingFailures.push({
                fileName,
                pageNum: pageData.pageNum,
                reason: String((saveErr as any)?.message || saveErr),
              });
            }
          }
        } catch (genErr) {
          remainingFailures.push({
            fileName,
            pageNum: null,
            reason: `Retry aborted: ${String((genErr as any)?.message || genErr)}`,
          });
          if (!info.allPages) {
            for (const p of info.pageNums) {
              if (!succeeded.has(p)) {
                remainingFailures.push({ fileName, pageNum: p, reason: 'Page was never reached during retry' });
              }
            }
          }
          continue;
        }

        if (!info.allPages) {
          for (const p of info.pageNums) {
            const alreadyRecorded = remainingFailures.some(f => f.fileName === fileName && f.pageNum === p);
            if (!succeeded.has(p) && !alreadyRecorded) {
              remainingFailures.push({ fileName, pageNum: p, reason: 'Page was not produced during retry' });
            }
          }
        } else if (expectedFromGenerator > yielded) {
          for (let p = yielded + 1; p <= expectedFromGenerator; p++) {
            remainingFailures.push({ fileName, pageNum: p, reason: 'Page was never reached during retry' });
          }
        }
      }

      try {
        await saveProject(workingProject);
        setProject(workingProject);
      } catch (saveErr) {
        remainingFailures.push({
          fileName: '(project save)',
          pageNum: null,
          reason: `Could not save retried pages: ${String((saveErr as any)?.message || saveErr)}`,
        });
      }

      if (newPendingPages.length > 0) {
        setPendingPages(prev => [...prev, ...newPendingPages]);
        setPendingThumbnails(prev => ({ ...prev, ...newThumbnails }));
        if (addPagesStep !== 'name_pages') setAddPagesStep('name_pages');
      }

      setUploadFailures(remainingFailures);
      setUploadTotals(prev => ({ processed: prev.processed + newlyProcessed, expected: prev.expected }));

      if (remainingFailures.length === 0) {
        setShowUploadFailuresModal(false);
      }
    } catch (err) {
      console.error('Retry failed', err);
      toast(`Retry failed: ${(err as any)?.message || err}`, { type: 'error' });
    } finally {
      setIsRetryingUpload(false);
      setRetryProgress({ status: '', current: 0, total: 0, fileName: '' });
    }
  };

  const toggleTakeoffSelection = (takeoffId: string) => {
    setSelectedTakeoffIds(prev => {
      const next = new Set(prev);
      if (next.has(takeoffId)) {
        next.delete(takeoffId);
      } else {
        next.add(takeoffId);
      }
      return next;
    });
  };

  const handlePrint = async () => {
    if (!project || selectedTakeoffIds.size === 0) return;
    setIsPrinting(true);
    setProgressMessage('Preparing pages…');

    try {
      const pdfBuffer = await buildHighlightsPdf(
        project,
        selectedTakeoffIds,
        (msg) => setProgressMessage(msg),
        revisionModel.currentPageIds,
      );

      if (!pdfBuffer) {
        toast('No pages found with the selected takeoffs.', { type: 'warning' });
        return;
      }

      let outBuffer: ArrayBuffer = pdfBuffer;
      let overBudget = false;
      if (highlightQuality === 'email') {
        const shrunk = await shrinkPdfToBudget(pdfBuffer, EMAIL_TARGET_BYTES, (msg) => setProgressMessage(msg));
        outBuffer = shrunk.bytes;
        overBudget = shrunk.overBudget;
      }

      setProgressMessage('Saving…');
      const name = takeoffPrintName(project.name, 'pdf');
      // Raw streaming save — base64-in-JSON dies at the server's JSON body cap
      // for big plan-set printouts, and silently at that (413).
      await saveBinaryFile(uuidv4(), new Blob([outBuffer], { type: 'application/pdf' }), {
        projectId: project.id, kind: 'takeoff-print', name, sourceType: 'takeoff-print', sourceId: uuidv4(),
      });
      if (overBudget) {
        toast(`Printout is ${(outBuffer.byteLength / 1048576).toFixed(1)}MB — above the 18MB email target; some providers may reject it.`, { type: 'warning' });
      }

      setSelectedTakeoffIds(new Set());
      navigate(takeoffPrintsUrl(project.id));
    } catch (error) {
      console.error('Error generating PDF:', error);
      toast('Failed to generate PDF.', { type: 'error' });
    } finally {
      setIsPrinting(false);
      setProgressMessage('');
    }
  };

  const handleExportExcel = async () => {
    if (!project || selectedTakeoffIds.size === 0) return;
    setIsExportingExcel(true);

    try {
      const selectedTakeoffs = getTakeoffTotals().filter(t => selectedTakeoffIds.has(t.id));
      const { rows, cols } = buildTakeoffExcelRows(selectedTakeoffs);

      const ws = XLSX.utils.aoa_to_sheet(rows);
      ws['!cols'] = cols;

      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, "Takeoffs");
      
      const excelBuffer = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
      const excelBlob = new Blob([excelBuffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });

      const name = takeoffPrintName(project.name, 'excel');
      // Attributed streaming save, same as the PDF printout above, so the export
      // lands in Documents as its own takeoff-export document. sourceType is
      // 'takeoff-print' for BOTH pdf and excel exports (only `kind` tells them
      // apart) — that's what server/documents.ts's resolveTakeoffPrints keys
      // off, matching the migration 28 relabel (server/migrationList.ts).
      await saveBinaryFile(uuidv4(), excelBlob, {
        projectId: project.id, kind: 'takeoff-export', name, sourceType: 'takeoff-print', sourceId: uuidv4(),
      });

      setSelectedTakeoffIds(new Set());
      navigate(takeoffPrintsUrl(project.id));
    } catch (error) {
      console.error('Error generating Excel:', error);
      toast('Failed to generate Excel.', { type: 'error' });
    } finally {
      setIsExportingExcel(false);
    }
  };

  const handleCreateProposal = async () => {
    if (!project || selectedTakeoffIds.size === 0) return;
    try {
      // Same last-used document options a blank proposal gets (ProposalsList's
      // handleNew) — best-effort, so an offline prefs fetch is not fatal.
      const prefs = await getUserPreferences().catch(() => ({} as Record<string, string>));
      const { id } = await createProposal(project.id, {
        takeoffIds: [...selectedTakeoffIds],
        ...optionDefaultsFromPrefs(prefs),
      });
      navigate(`/project/${project.id}/proposal/${id}`);
    } catch {
      toast('Failed to create proposal', { type: 'error' });
    }
  };

  // Share a page: the share window makes a link straight away (30 days,
  // changeable there) and lists the page's other working links.
  const handleSharePage = (page: { imageId: string; name?: string; description?: string }) => {
    const name = page.name || page.description || 'Page';
    share({ title: `Share ${name}`, target: { type: 'page', resourceId: page.imageId }, name, createNow: true });
  };

  // Permanently removes a page from the project.
  // Orphaned image rows are intentionally left in storage; cleanup is handled
  // separately by the admin storage-reclaim tool, which verifies no other page
  // (across plan-set revisions) references the same imageId / thumbnailId /
  // sourcePdfFileId before deleting.
  const handleDeletePage = async (page: { id: string; name?: string; pageNumber?: string }) => {
    if (!project) return;
    const label = page.pageNumber || page.name || 'this page';
    if (!await confirm({ title: 'Delete page', message: `Delete ${label}? Any measurements on it will be lost.`, confirmLabel: 'Delete', tone: 'danger' })) return;
    const updated = { ...project, pages: project.pages.filter(p => p.id !== page.id) };
    await saveProject(updated);
    setProject(updated);
    setSelectedPageIds(prev => {
      if (!prev.has(page.id)) return prev;
      const next = new Set(prev);
      next.delete(page.id);
      return next;
    });
  };

  const handleShareSelectedPages = () => {
    if (!project || selectedPageIds.size === 0) return;
    if (selectedPageIds.size === 1) {
      // Single page — the simple per-image share
      const pg = project.pages.find(p => p.id === [...selectedPageIds][0]);
      if (pg) handleSharePage(pg);
      return;
    }
    // Multiple pages — one combined link, a gallery of them all
    const payload = project.pages.filter(p => selectedPageIds.has(p.id)).map(p => ({
      imageId: p.imageId,
      name: p.name || 'Page',
      pageNumber: p.pageNumber,
    }));
    share({
      title: `Share ${selectedPageIds.size} pages`,
      target: { type: 'pages', resourceId: JSON.stringify(payload) },
      name: project.name,
      createNow: true,
    });
  };

  const handleOpenNamePages = () => {
    if (!project) return;
    
    // Populate pendingPages with existing filtered pages
    const existingPages = filteredPages.map(p => ({
      ...p,
      pageNumber: p.pageNumber || '',
      description: p.description || p.name || '',
    }));
    
    const thumbnails: Record<string, string> = {};
    filteredPages.forEach(p => {
      thumbnails[p.imageId] = getImageUrl(p.thumbnailId || p.imageId);
    });
    
    setPendingPages(existingPages);
    setPendingThumbnails(thumbnails);
    setAddPagesStep('name_pages');
    setIsNamingExistingPages(true);
    setShowAddPagesModal(true);
  };

  // Manual "AI Scan" — load the model on demand, read every page, then match.
  const handleAiScan = async (report: (p: AiScanProgress) => void) => {
    report({ phase: 'loading' });
    const idleMs = await getAiIdleTimeoutMs();
    await warmupAi(idleMs);
    const ready = await waitForAiReady(() => report({ phase: 'loading' }));
    if (!ready) {
      toast('AI model unavailable.', { type: 'error' });
      return;
    }
    const pages = pendingPages;
    let count = 0;
    report({ phase: 'scanning', done: 0, total: pages.length });
    const reads = await runWithConcurrency(
      pages.map(pg => async () => {
        const result = await readSheet({
          imageId: aiImages[pg.id] ? undefined : (pg.imageId || undefined),
          imageBase64: aiImages[pg.id] || (pg.imageId ? undefined : pendingThumbnails[pg.thumbnailId]),
          embeddedText: pg.extractedText,
          idleTimeoutMs: idleMs,
        });
        count++;
        report({ phase: 'scanning', done: count, total: pages.length });
        return result;
      }),
      3,
    );
    let named = pages.map((pg, i) => (reads[i] ? applyReadToPage(pg, reads[i]!) : pg));
    if (!isNamingExistingPages && project) {
      const pendingIds = new Set(pages.map(p => p.id));
      const priorPages = project.pages.filter(p => !pendingIds.has(p.id));
      const model = computeRevisionModel({ ...project, pages: priorPages }, '');
      const existingRefs: { sheetId: string; number: string; title: string }[] = [];
      for (const [, currentPageId] of model.latestPageIdBySheet) {
        const pg = priorPages.find(p => p.id === currentPageId);
        if (pg) existingRefs.push({ sheetId: effectiveSheetId(pg), number: pg.pageNumber || '', title: pg.description || pg.name || '' });
      }
      if (existingRefs.length) {
        const matches = await runWithConcurrency(
          named.map((_pg, i) => async () => {
            const read = reads[i];
            if (!read || (!read.sheetNumber && !read.sheetTitle)) return null;
            return matchSheet({ page: read, existingSheets: existingRefs, idleTimeoutMs: idleMs });
          }),
          3,
        );
        named = named.map((pg, i) => (matches[i] ? applyMatchToPage(pg, matches[i]!) : pg));
      }
    }
    setPendingPages(named);
    const hits = reads.filter(Boolean).length;
    toast(`AI read ${hits} of ${pages.length} page${pages.length === 1 ? '' : 's'}.`, { type: hits ? 'success' : 'error' });
    report({ phase: 'done' });
  };

  const handleConfirmAddPages = async () => {
    if (!project) return;
    setIsAddingPages(true);
    try {
      const wasNewSet = !isNamingExistingPages;
      const pendingIds = new Set(pendingPages.map(p => p.id));

      // For the add-set flow, resolve each incoming page's sheet identity from
      // the Revision Review step's MATCH control before assigning measurements.
      // The matched sheet's CURRENT living page is computed from the project as
      // it stood BEFORE this batch (exclude the just-added pending pages) so we
      // copy forward the real prior revision, not the empty incoming page.
      const priorPages = project.pages.filter(p => !pendingIds.has(p.id));
      const priorModel = wasNewSet
        ? computeRevisionModel({ ...project, pages: priorPages }, '')
        : null;

      // When a matched sheet's current page is LEGACY (no real stored sheetId),
      // mint one and stamp it on BOTH the prior page and the new revision so
      // they share a durable identity going forward. Keyed by the effective
      // sheet id used in the match dropdown.
      const backfillSheetId = new Map<string, string>(); // matchSheetId -> real sheetId
      const stampOnSourcePageId = new Map<string, string>(); // sourcePageId -> real sheetId
      if (wasNewSet) {
        for (const p of pendingPages) {
          if (!p.matchSheetId) continue;
          const currentPageId = priorModel!.latestPageIdBySheet.get(p.matchSheetId);
          const source = currentPageId ? priorPages.find(pp => pp.id === currentPageId) : undefined;
          if (!source) continue;
          const realId = source.sheetId || uuidv4();
          backfillSheetId.set(p.matchSheetId, realId);
          if (!source.sheetId) stampOnSourcePageId.set(source.id, realId);
        }
      }

      const updatedProject = {
        ...project,
        pages: project.pages.map(pp => {
          const p = pendingPages.find(pn => pn.id === pp.id);
          if (!p) {
            // Backfill a real sheetId onto a matched legacy prior page so it and
            // its new revision share identity.
            const stamp = stampOnSourcePageId.get(pp.id);
            return stamp ? { ...pp, sheetId: stamp } : pp;
          }

          const named = {
            ...pp,
            name: composePageName(p.pageNumber, p.description, p.name),
            pageNumber: p.pageNumber,
            description: p.description,
          };

          // Rename-existing flow: names only, no identity/measurement changes.
          if (!wasNewSet) return named;

          // Add-set flow: assign sheetId + (for revisions) carry measurements
          // forward from the matched sheet's current living page.
          const matchSheetId = p.matchSheetId;
          if (matchSheetId) {
            const currentPageId = priorModel!.latestPageIdBySheet.get(matchSheetId);
            const source = currentPageId ? priorPages.find(pp2 => pp2.id === currentPageId) : undefined;
            const realSheetId = backfillSheetId.get(matchSheetId) || matchSheetId;
            if (source) {
              const seeded = carryForwardFrom(source, uuidv4);
              return {
                ...named,
                sheetId: realSheetId,
                measurements: seeded.measurements,
                scaleConfig: seeded.scaleConfig,
                scaleRegions: seeded.scaleRegions,
                isMultiRegion: seeded.isMultiRegion,
              };
            }
            // Matched sheet vanished (shouldn't happen) — treat as a new sheet.
            return { ...named, sheetId: uuidv4() };
          }
          // New sheet: a fresh durable id, starts empty.
          return { ...named, sheetId: uuidv4() };
        }),
      };

      await saveProject(updatedProject);
      setProject(updatedProject);

      if (wasNewSet) {
        const planSetId = updatedProject.pages.find(p => p.id === pendingPages[0]?.id)?.planSetId;
        if (planSetId) setSelectedPlanSetId(planSetId);
      }

      setShowAddPagesModal(false);
      setAddPagesStep('details');
      setIsNamingExistingPages(false);
      setNewPlanSetName('');
      setNewPlanSetFiles([]);
      setPendingPages([]);
      setPendingThumbnails({});
      setUseExistingPlanSet(false);
      setTargetPlanSetId('');
      setIsAddingPages(false);
    } catch (error) {
      console.error('Error adding pages:', error);
      toast('Failed to add pages.', { type: 'error' });
      setIsAddingPages(false);
    }
  };


  // Shared plan-set revision model: which pages are the current revision for
  // the selected set, full per-sheet history, and supersession status. Drives
  // the pages grid, takeoff totals, revision badges, and the compare view.
  const revisionModel = useMemo(
    () => computeRevisionModel(project, selectedPlanSetId),
    [project, selectedPlanSetId],
  );

  // Existing logical sheets the add-set Revision Review step matches against:
  // each sheet's durable id + its CURRENT (living) revision's page number,
  // computed from the project EXCLUDING the pages currently being added (so a
  // page can't be offered as a revision of itself). Also surfaces the incoming
  // batch's plan set id for the within-set duplicate check.
  const reviewContext = useMemo(() => {
    if (!project || isNamingExistingPages || pendingPages.length === 0) {
      return { sheets: [] as { sheetId: string; pageNumber: string }[], planSetId: undefined as string | undefined };
    }
    const pendingIds = new Set(pendingPages.map(p => p.id));
    const priorPages = project.pages.filter(p => !pendingIds.has(p.id));
    const model = computeRevisionModel({ ...project, pages: priorPages }, '');
    const sheets: { sheetId: string; pageNumber: string }[] = [];
    for (const [sheetId, currentPageId] of model.latestPageIdBySheet) {
      const page = priorPages.find(p => p.id === currentPageId);
      sheets.push({ sheetId: effectiveSheetId(page!), pageNumber: page?.pageNumber || '' });
    }
    // Sort by page number for a stable, scannable dropdown. Numeric-aware so
    // placeholder-numbered sheets list 1, 2, 10 rather than 1, 10, 2.
    sheets.sort((a, b) => a.pageNumber.localeCompare(b.pageNumber, undefined, { numeric: true, sensitivity: 'base' }));
    const firstPending = project.pages.find(p => pendingIds.has(p.id));
    return { sheets, planSetId: firstPending?.planSetId };
  }, [project, isNamingExistingPages, pendingPages]);

  // Calculate totals for takeoffs. Only the current revision of each sheet (for
  // the selected plan set) counts, so measurements stranded on superseded
  // sheets don't inflate the totals.
  // Single shared implementation lives in proposalGenerator.computeTakeoffTotals;
  // ProjectView and the /proposal section both call it so totals never diverge.
  const getTakeoffTotals = () => {
    if (!project) return [];
    return computeTakeoffTotals(project, revisionModel.currentPageIds);
  };

  const handleOptimizeThumbnails = async () => {
    if (!project) return;
    
    const pagesToOptimize = project.pages.filter(p => !p.thumbnailId);
    if (pagesToOptimize.length === 0) return;

    setIsOptimizingThumbnails(true);
    setOptimizeProgress({ current: 0, total: pagesToOptimize.length });

    const updatedPages = [...project.pages];

    for (let i = 0; i < pagesToOptimize.length; i++) {
      const page = pagesToOptimize[i];
      setOptimizeProgress({ current: i + 1, total: pagesToOptimize.length });
      
      try {
        // Load the full image
        const imgUrl = await getFile(page.imageId);
        if (!imgUrl) continue;

        const img = new Image();
        img.src = imgUrl;
        await new Promise((resolve, reject) => {
          img.onload = resolve;
          img.onerror = reject;
        });

        // Generate thumbnail
        const thumbCanvas = document.createElement('canvas');
        const thumbCtx = thumbCanvas.getContext('2d');
        const thumbScale = 400 / Math.max(img.width, img.height);
        thumbCanvas.width = img.width * thumbScale;
        thumbCanvas.height = img.height * thumbScale;
        
        if (thumbCtx) {
          thumbCtx.drawImage(img, 0, 0, thumbCanvas.width, thumbCanvas.height);
          const thumbnailDataUrl = thumbCanvas.toDataURL('image/jpeg', 0.7);
          
          const thumbnailId = uuidv4();
          await saveImage(thumbnailId, thumbnailDataUrl, { kind: 'plan', projectId: project.id });
          
          // Update page
          const pageIndex = updatedPages.findIndex(p => p.id === page.id);
          if (pageIndex !== -1) {
            updatedPages[pageIndex] = { ...updatedPages[pageIndex], thumbnailId };
          }
        }
      } catch (err) {
        console.error(`Failed to optimize thumbnail for page ${page.name}`, err);
      }
    }

    const updatedProject = { ...project, pages: updatedPages };
    await saveProject(updatedProject);
    setProject(updatedProject);
    setIsOptimizingThumbnails(false);
  };

  const getDueDateColor = () => {
    if (!project || project.submitted || !project.bidDueDate) return 'text-ink-soft';
    
    const now = Date.now();
    const diff = project.bidDueDate - now;
    const days = diff / (1000 * 60 * 60 * 24);

    if (days < 0) return 'text-purple-600 font-bold';
    if (days <= 3) return 'text-red-600 font-bold';
    if (days <= 14) return 'text-amber-600 font-bold';
    
    return 'text-ink-soft';
  };

  // Pages that are visible at the current plan-set selection after
  // revision-dedup, *before* search filtering. Exposed separately so the
  // search-result badge can show "X of Y matches" (Y = visiblePages.length).
  const visiblePages = revisionModel.visiblePages;

  // Superseded revisions of the visible sheets, surfaced only when the "Show
  // superseded" toggle is on. Each is an older read-only revision of a sheet
  // whose current page is in visiblePages. Honors the as-of selection by only
  // including revisions at/older than the sheet's current (visible) revision.
  const candidatePages = useMemo(() => {
    if (!showSuperseded) return visiblePages;
    const currentIds = new Set(visiblePages.map(p => p.id));
    const extras: ProjectPage[] = [];
    for (const current of visiblePages) {
      const key = effectiveSheetId(current);
      const revs = revisionModel.revisionsBySheet.get(key) || [];
      const currentIdx = revs.findIndex(r => r.id === current.id);
      // Older revisions are everything before the current one in oldest->newest order.
      for (let i = 0; i < (currentIdx === -1 ? revs.length : currentIdx); i++) {
        if (!currentIds.has(revs[i].id)) extras.push(revs[i]);
      }
    }
    return [...visiblePages, ...extras];
  }, [showSuperseded, visiblePages, revisionModel]);

  const filteredPages = useMemo(() => {
    const searchLower = searchTerm.toLowerCase();
    const matched = searchLower
      ? candidatePages.filter(page =>
          page.name.toLowerCase().includes(searchLower) ||
          (page.pageNumber && page.pageNumber.toLowerCase().includes(searchLower)) ||
          (page.description && page.description.toLowerCase().includes(searchLower)) ||
          (page.extractedText && page.extractedText.toLowerCase().includes(searchLower)),
        )
      : candidatePages;

    const sorted = [...matched];
    // Favorites always group at the top, then the chosen sort order applies
    // inside both the favorites and non-favorites groups. This is a stable
    // pre-step before the sort below, hence the staged partition.
    const isFav = (p: ProjectPage) => favoritePageIds.has(p.id);
    // Comparator for the active sort mode. Favorites then ride on top of
    // this via favSort below.
    let baseCmp: (a: ProjectPage, b: ProjectPage) => number;
    if (pagesSortMode === 'description') {
      // Pages without a description sink to the bottom so the meaningful
      // entries stay grouped; among those with one, tie-break by pageNumber
      // so two "Floor Plan" pages still come out in drawing-set order.
      baseCmp = (a, b) => {
        const da = (a.description || '').trim();
        const db = (b.description || '').trim();
        if (!da && !db) return 0;
        if (!da) return 1;
        if (!db) return -1;
        const cmp = da.localeCompare(db, undefined, { numeric: true, sensitivity: 'base' });
        if (cmp !== 0) return cmp;
        return (a.pageNumber || '').localeCompare(b.pageNumber || '', undefined, { numeric: true, sensitivity: 'base' });
      };
    } else if (pagesSortMode === 'highlightsDesc') {
      baseCmp = (a, b) => b.measurements.length - a.measurements.length;
    } else {
      // Default: numeric sort by pageNumber (drawing-set convention).
      baseCmp = (a, b) => {
        const nameA = a.pageNumber || a.name || '';
        const nameB = b.pageNumber || b.name || '';
        return nameA.localeCompare(nameB, undefined, { numeric: true, sensitivity: 'base' });
      };
    }
    // Favorites always sort to the top; the active sort applies inside the
    // favorites group and inside the non-favorites group.
    sorted.sort((a, b) => {
      const fa = isFav(a), fb = isFav(b);
      if (fa !== fb) return fa ? -1 : 1;
      return baseCmp(a, b);
    });
    return sorted;
  }, [candidatePages, searchTerm, pagesSortMode, favoritePageIds]);

  if (isLoading) {
    return (
      <div className="min-h-screen p-4 md:p-8 font-sans">
        <div className="max-w-7xl mx-auto space-y-6">
          <Skeleton className="h-4 w-24" />
          <Skeleton className="h-9 w-2/3 max-w-md" />
          <div className="flex flex-wrap gap-3">
            <Skeleton className="h-7 w-24 rounded-full" />
            <Skeleton className="h-7 w-24 rounded-full" />
            <Skeleton className="h-7 w-28 rounded-full" />
          </div>
          <div className="flex flex-wrap gap-4">
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-40" />
            <Skeleton className="h-4 w-40" />
          </div>
          <div className="flex gap-6 border-b border-edge pb-px">
            <Skeleton className="h-8 w-16" />
            <Skeleton className="h-8 w-20" />
            <Skeleton className="h-8 w-20" />
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">
            {Array.from({ length: 8 }).map((_, i) => (
              <Skeleton key={i} className="aspect-[3/4] w-full rounded-xl" />
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (!project) return null;

  return (
    <div className="min-h-screen p-4 md:p-8 font-sans">

      {/* ── PDF generation progress overlay ── */}
      {(isPrinting || isExportingExcel) && (
        <div className="fixed inset-0 z-[999] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="bg-raised rounded-2xl shadow-2xl p-8 w-full max-w-xs mx-4 flex flex-col items-center gap-5">
            <Loader2 size={44} className="text-accent-600 animate-spin" />
            <div className="text-center space-y-2">
              <p className="font-semibold text-ink text-base">
                {isPrinting
                  ? 'Generating PDF…'
                  : 'Exporting to Excel…'}
              </p>
              {progressMessage && (
                <p className="text-sm text-ink-soft">{progressMessage}</p>
              )}
              <p className="text-xs text-ink-faint mt-1">This may take a moment for large documents</p>
            </div>
          </div>
        </div>
      )}

      <div className="max-w-5xl mx-auto">
        <Link to="/projects" className="inline-flex items-center gap-2 text-ink-soft hover:text-ink mb-4 md:mb-6 transition-colors font-medium text-sm md:text-base">
          <ArrowLeft size={18} />
          Back to Projects
        </Link>
        
        <div className="flex flex-col md:flex-row justify-between items-start md:items-end mb-6 md:mb-8 gap-4 md:gap-6">
          <div className="w-full">
            <div className="flex items-center gap-3">
              <h1 className="text-xl md:text-3xl font-bold text-ink break-words leading-tight">{project.name}</h1>
              {isAdmin && (
                <button
                  onClick={() => navigate(`/project/${projectId}/settings`)}
                  className="p-1.5 text-ink-faint hover:text-accent-600 transition-all rounded-lg hover:bg-accent-50 flex-shrink-0"
                  title="Project settings"
                  aria-label="Project settings"
                >
                  <SlidersHorizontal size={18} />
                </button>
              )}
            </div>
            <ProjectStageControl
              projectId={project.id}
              version={project.version}
              status={project.status}
              onChanged={(version, status) => setProject(p => (p ? { ...p, version, status } : p))}
            />

            <div className="flex flex-wrap gap-2 mt-3 md:mt-4">
              <button
                onClick={() => projectId && openNotes(projectId)}
                className="px-3 py-1 rounded-full text-[10px] md:text-xs font-bold uppercase tracking-wider transition-all border bg-raised text-accent-600 border-accent-200 hover:border-accent-400 hover:bg-accent-50 flex items-center gap-1.5 shadow-sm"
              >
                <StickyNote size={14} />
                Notes Board
              </button>
              <button
                onClick={() => navigate(`/tasks?projectId=${projectId}`)}
                className="px-3 py-1 rounded-full text-[10px] md:text-xs font-bold uppercase tracking-wider transition-all border bg-raised text-accent-600 border-accent-200 hover:border-accent-400 hover:bg-accent-50 flex items-center gap-1.5 shadow-sm"
              >
                <ListChecks size={14} />
                Tasks
              </button>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 lg:flex lg:flex-wrap lg:items-center gap-3 md:gap-4 mt-4 text-xs md:text-sm text-ink-soft">
              <div className="flex items-center gap-2 bg-raised/50 p-2 rounded-lg lg:bg-transparent lg:dark:bg-transparent lg:p-0">
                <Calendar size={14} className="text-ink-faint flex-shrink-0" />
                <span className="truncate">Created {new Date(project.createdAt).toLocaleDateString()}</span>
              </div>
              
              <div className="flex items-center gap-2 bg-raised/50 p-2 rounded-lg lg:bg-transparent lg:dark:bg-transparent lg:p-0">
                <Building2 size={14} className="text-ink-faint flex-shrink-0" />
                <span className="truncate">{project.contractor || 'No contractor'}</span>
              </div>

              <div className="flex items-center gap-2 bg-raised/50 p-2 rounded-lg lg:bg-transparent lg:dark:bg-transparent lg:p-0">
                <MapPin size={14} className="text-ink-faint flex-shrink-0" />
                {project.address ? (
                  <a
                    href={`https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(project.address)}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-accent-600 hover:underline transition-colors truncate"
                  >
                    {project.address}
                  </a>
                ) : (
                  <span className="truncate">No address</span>
                )}
              </div>

              <div className="flex items-center gap-2 bg-raised/50 p-2 rounded-lg lg:bg-transparent lg:dark:bg-transparent lg:p-0">
                <Clock size={14} className="text-ink-faint flex-shrink-0" />
                <span className={`${getDueDateColor()} truncate`}>
                  Due: {project.bidDueDate ? new Date(project.bidDueDate).toLocaleDateString() : 'Not set'}
                </span>
              </div>

              {projectStorage && (
                <div
                  className="flex items-center gap-2 bg-raised/50 p-2 rounded-lg lg:bg-transparent lg:dark:bg-transparent lg:p-0"
                  title={`${formatBytes(projectStorage.imageBytes)} in ${projectStorage.imageCount} file${projectStorage.imageCount === 1 ? '' : 's'}, ${formatBytes(projectStorage.dataBytes)} project data, ${formatBytes(projectStorage.noteBytes)} notes`}
                >
                  <HardDrive size={14} className="text-ink-faint flex-shrink-0" />
                  <span className="truncate">{formatBytes(projectStorage.totalBytes)} stored</span>
                </div>
              )}
            </div>
          </div>
          {project.planSets && project.planSets.length > 0 && (
            <div className="flex flex-col items-stretch md:items-end gap-1.5 w-full md:w-auto mt-2 md:mt-0">
              <div className="flex items-center gap-2 bg-raised border border-edge rounded-lg px-3 py-2 shadow-sm w-full md:w-auto">
                <Layers size={15} className="text-accent-600 shrink-0" />
                <span className="text-xs md:text-sm text-ink-soft font-medium whitespace-nowrap">Plan Set:</span>
                <select
                  value={selectedPlanSetId}
                  onChange={(e) => setSelectedPlanSetId(e.target.value)}
                  className="bg-transparent dark:bg-transparent text-xs md:text-sm font-medium text-ink outline-none w-full md:min-w-[160px]"
                >
                  <option value="">Current (all sets)</option>
                  {orderedPlanSets(project).slice().reverse().map(ps => (
                    <option key={ps.id} value={ps.id}>
                      {ps.name}{ps.date ? ` · ${ps.date}` : ''}
                    </option>
                  ))}
                </select>
                <button
                  onClick={() => setShowManagePlanSets(true)}
                  aria-label="Manage plan sets"
                  title="Manage plan sets"
                  className="shrink-0 p-1 rounded-md text-ink-faint hover:text-accent-600 hover:bg-hover transition-colors"
                >
                  <Settings size={15} />
                </button>
              </div>
              <div className="flex items-center gap-2 text-[11px] text-ink-faint px-1">
                {selectedPlanSetId ? (() => {
                  const s = summarizePlanSet(project, selectedPlanSetId);
                  return <span>Viewing as of this set · {s.newCount} new, {s.revisedCount} revised{s.total ? ` (${s.total} sheets reissued)` : ''}</span>;
                })() : (
                  <span>Showing the latest revision of each sheet · {visiblePages.length} sheet{visiblePages.length === 1 ? '' : 's'}</span>
                )}
              </div>
            </div>
          )}
        </div>

        <div className="mt-4 md:mt-6 max-w-md">
          <UpcomingTasksCard
            items={upcomingTaskItems(projectTasks ?? [])}
            loading={projectTasks === null}
            title="Upcoming tasks"
            to={`/tasks?projectId=${projectId}`}
            emptyDescription="Tasks linked to this project with due dates show up here."
            headerActions={
              <Link to={`/tasks?projectId=${projectId}`} className="text-xs font-medium text-accent-600 hover:underline">View all</Link>
            }
          />
        </div>

        {/* Tabs */}
        <nav aria-label="Project view sections" className="flex gap-1 mb-6 overflow-x-auto no-scrollbar -mx-4 px-4 md:mx-0 md:px-0">
          <button
            onClick={() => setActiveTab('pages')}
            className={`flex items-center gap-1.5 shrink-0 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
              activeTab === 'pages' ? 'glow-accent text-white active:brightness-95' : 'text-ink-soft hover:bg-hover hover:text-ink'
            }`}
          >
            Pages
          </button>
          <button
            onClick={() => setActiveTab('takeoffs')}
            className={`flex items-center gap-1.5 shrink-0 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
              activeTab === 'takeoffs' ? 'glow-accent text-white active:brightness-95' : 'text-ink-soft hover:bg-hover hover:text-ink'
            }`}
          >
            Takeoffs
          </button>
          {project.email && (
            <button
              onClick={() => setActiveTab('email')}
              className={`flex items-center gap-1.5 shrink-0 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors whitespace-nowrap ${
                activeTab === 'email' ? 'glow-accent text-white active:brightness-95' : 'text-ink-soft hover:bg-hover hover:text-ink'
              }`}
            >
              <Mail size={14} /> Email
              {project.emails && project.emails.length > 1 && (
                <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-semibold ${
                  activeTab === 'email' ? 'bg-white/25 text-white' : 'bg-accent-100 dark:bg-accent-900/40 text-accent-700 dark:text-accent-300'
                }`}>
                  {project.emails.length}
                </span>
              )}
            </button>
          )}
        </nav>

        <div key={activeTab} className="anim-tab-in">
        {activeTab === 'pages' ? (
          <ProjectPagesTab
            project={project}
            filteredPages={filteredPages}
            visiblePages={visiblePages}
            searchTerm={searchTerm}
            pagesViewMode={pagesViewMode}
            pagesSortMode={pagesSortMode}
            pageContextMenu={pageContextMenu}
            favoritePageIds={favoritePageIds}
            selectedPageIds={selectedPageIds}
            editingPageId={editingPageId}
            editingPageNumber={editingPageNumber}
            editingPageDescription={editingPageDescription}
            revisionModel={revisionModel}
            showSuperseded={showSuperseded}
            setShowSuperseded={setShowSuperseded}
            isOptimizingThumbnails={isOptimizingThumbnails}
            optimizeProgress={optimizeProgress}
            setSearchTerm={setSearchTerm}
            setPagesSortMode={setPagesSortMode}
            setPagesViewMode={setPagesViewMode}
            setSelectedPageIds={setSelectedPageIds}
            setPageContextMenu={setPageContextMenu}
            setEditingPageNumber={setEditingPageNumber}
            setEditingPageDescription={setEditingPageDescription}
            setShowAddPagesModal={setShowAddPagesModal}
            setShowRevisionsForPageId={setShowRevisionsForPageId}
            toggleFavorite={toggleFavorite}
            handleStartRenamePage={handleStartRenamePage}
            handleSaveRenamePage={handleSaveRenamePage}
            handleCancelRenamePage={handleCancelRenamePage}
            handleSharePage={handleSharePage}
            handleDeletePage={handleDeletePage}
            handleShareSelectedPages={handleShareSelectedPages}
            handleOptimizeThumbnails={handleOptimizeThumbnails}
            handleOpenNamePages={handleOpenNamePages}
            navigate={navigate}
            toast={toast}
            pageSearchInputRef={pageSearchInputRef}
          />
        ) : activeTab === 'takeoffs' ? (
          <ProjectTakeoffsTab
            project={project}
            selectedTakeoffIds={selectedTakeoffIds}
            expandedTakeoffs={expandedTakeoffs}
            expandedTakeoffPages={expandedTakeoffPages}
            highlightQuality={highlightQuality}
            isPrinting={isPrinting}
            isExportingExcel={isExportingExcel}
            searchTerm={searchTerm}
            projectId={projectId}
            getTakeoffTotals={getTakeoffTotals}
            setHighlightQuality={setHighlightQuality}
            setShowTakeoffModal={setShowTakeoffModal}
            setShowDeleteAllConfirm={setShowDeleteAllConfirm}
            setSelectedTakeoffIds={setSelectedTakeoffIds}
            handlePrint={handlePrint}
            handleExportExcel={handleExportExcel}
            onCreateProposal={handleCreateProposal}
            isAdmin={isAdmin}
            toggleTakeoffSelection={toggleTakeoffSelection}
            toggleTakeoffExpanded={toggleTakeoffExpanded}
            toggleTakeoffPageExpanded={toggleTakeoffPageExpanded}
            handleEditTakeoff={handleEditTakeoff}
            handleDeleteTakeoff={handleDeleteTakeoff}
            navigate={navigate}
          />
        ) : (
          /* Email tab — only reachable when project.email exists */
          <EmailTab project={project} onOpenProposal={isAdmin ? () => navigate(`/project/${projectId}/proposal`) : undefined} />
        )}
        </div>
      </div>

      <TakeoffDeleteModals
        showDeleteAllConfirm={showDeleteAllConfirm}
        onConfirmDeleteAll={confirmDeleteAllTakeoffs}
        onCloseDeleteAll={() => setShowDeleteAllConfirm(false)}
        showDeleteConfirm={showDeleteConfirm}
        onConfirmDelete={confirmDeleteTakeoff}
        onCloseDelete={() => { setShowDeleteConfirm(false); setTakeoffToDelete(null); }}
      />

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
          setShowTakeoffModal(false);
        }}
      />

      {editingTakeoff && (
        <TakeoffEditModal
          editingTakeoff={editingTakeoff}
          editTakeoffName={editTakeoffName}
          setEditTakeoffName={setEditTakeoffName}
          editTakeoffColor={editTakeoffColor}
          setEditTakeoffColor={setEditTakeoffColor}
          editTakeoffUnit={editTakeoffUnit}
          setEditTakeoffUnit={setEditTakeoffUnit}
          editTakeoffCostPerUnit={editTakeoffCostPerUnit}
          setEditTakeoffCostPerUnit={setEditTakeoffCostPerUnit}
          isEditTakeoffAdvanced={isEditTakeoffAdvanced}
          setIsEditTakeoffAdvanced={setIsEditTakeoffAdvanced}
          editTakeoffCustomCosts={editTakeoffCustomCosts}
          setEditTakeoffCustomCosts={setEditTakeoffCustomCosts}
          editTakeoffPricePackage={editTakeoffPricePackage}
          setEditTakeoffPricePackage={setEditTakeoffPricePackage}
          pricePackageOptions={project.takeoffs.map(t => t.pricePackage)}
          onSave={handleSaveEditTakeoff}
          onClose={() => setEditingTakeoff(null)}
        />
      )}

      {showManagePlanSets && project && (
        <PlanSetManager
          project={project}
          selectedPlanSetId={selectedPlanSetId}
          onClose={() => setShowManagePlanSets(false)}
          onSelect={setSelectedPlanSetId}
          onUpdate={handleUpdatePlanSet}
          onDelete={handleDeletePlanSet}
          onAddNew={() => { setShowManagePlanSets(false); setShowAddPagesModal(true); }}
        />
      )}

      {showRevisionsForPageId && project && (
        <PlanSetRevisions
          project={project}
          pageId={showRevisionsForPageId}
          onClose={() => setShowRevisionsForPageId(null)}
          onOpenPage={(pid) => { setShowRevisionsForPageId(null); navigate(`/project/${project.id}/page/${pid}`); }}
          onCompare={() => { setComparePageId(showRevisionsForPageId); setShowRevisionsForPageId(null); }}
        />
      )}

      {comparePageId && project && (
        <PlanSetCompare
          project={project}
          pageId={comparePageId}
          onClose={() => setComparePageId(null)}
        />
      )}

      <AddPagesModal
        open={showAddPagesModal}
        onClose={() => {
          setShowAddPagesModal(false);
          setAddPagesStep('details');
          setIsNamingExistingPages(false);
          setNewPlanSetName('');
          setNewPlanSetFiles([]);
          setPendingPages([]);
          setPendingThumbnails({});
          setUseExistingPlanSet(false);
          setTargetPlanSetId('');
        }}
        project={project}
        addPagesStep={addPagesStep}
        isNamingExistingPages={isNamingExistingPages}
        newPlanSetName={newPlanSetName}
        setNewPlanSetName={setNewPlanSetName}
        newPlanSetDate={newPlanSetDate}
        setNewPlanSetDate={setNewPlanSetDate}
        newPlanSetFiles={newPlanSetFiles}
        setNewPlanSetFiles={setNewPlanSetFiles}
        removeNewPlanSetFile={removeNewPlanSetFile}
        useExistingPlanSet={useExistingPlanSet}
        setUseExistingPlanSet={setUseExistingPlanSet}
        targetPlanSetId={targetPlanSetId}
        setTargetPlanSetId={setTargetPlanSetId}
        pendingPages={pendingPages}
        setPendingPages={setPendingPages}
        pendingThumbnails={pendingThumbnails}
        reviewSheets={reviewContext.sheets}
        reviewPlanSetId={reviewContext.planSetId}
        isAddingPages={isAddingPages}
        addProgress={addProgress}
        fileInputRef={fileInputRef}
        onAddPages={handleAddPages}
        onConfirmAddPages={handleConfirmAddPages}
        onAiScan={handleAiScan}
      />


      <UploadFailuresModal
        open={showUploadFailuresModal}
        failures={uploadFailures}
        totalProcessed={uploadTotals.processed}
        totalExpected={uploadTotals.expected}
        isRetrying={isRetryingUpload}
        retryStatus={retryProgress.status}
        retryCurrent={retryProgress.current}
        retryTotal={retryProgress.total}
        retryFileName={retryProgress.fileName}
        canRetry={uploadFilesByName.size > 0}
        onRetry={handleRetryFailedPages}
        onClose={() => setShowUploadFailuresModal(false)}
      />
    </div>
  );
};
