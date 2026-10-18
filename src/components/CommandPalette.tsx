import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useLocation, matchPath } from 'react-router-dom';
import { AnimatePresence, motion } from 'motion/react';
import {
  Search, FolderOpen, FileText, Ruler, Plus, Home, Settings as SettingsIcon,
  ListTodo, Clock, CornerDownLeft, X, Keyboard,
  AlertCircle, ClipboardCheck, StickyNote, DollarSign, SlidersHorizontal, LayoutGrid,
  MessageCircleQuestion, CalendarDays, Mail, FilePlus2, BarChart3,
} from 'lucide-react';
import { searchAll, SearchResult, getMyTimeEntries, clockIn, clockOut } from '../utils/store';
import { useToast } from './Toast';
import { useTheme } from '../context/ThemeContext';

type Action = {
  id: string;
  type: 'action';
  title: string;
  subtitle?: string;
  icon: React.ReactNode;
  run: () => void;
};

type Item = Action | (SearchResult & { icon?: React.ReactNode });

type Group = { label: string; items: Item[] };

const typeIcon = (type: SearchResult['type']) => {
  switch (type) {
    case 'project': return <FolderOpen size={16} />;
    case 'page': return <FileText size={16} />;
    case 'takeoff': return <Ruler size={16} />;
  }
};

const typeLabel: Record<SearchResult['type'], string> = {
  project: 'Project',
  page: 'Page',
  takeoff: 'Takeoff',
};

const isTyping = () => {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
};

// Last-executed palette actions (client-only, newest first, dedup by id).
// Mirrors the `recentProjects` idiom in utils/store.ts but is scoped to
// executed ACTIONS only — search results (project/page/takeoff) are never
// recorded here, only the static/contextual actions a user runs.
const PALETTE_RECENTS_KEY = 'palette-recents';
type PaletteRecent = { id: string; title: string; at: number };

const getPaletteRecents = (): PaletteRecent[] => {
  try { return JSON.parse(localStorage.getItem(PALETTE_RECENTS_KEY) || '[]'); } catch { return []; }
};

const recordPaletteRecent = (id: string, title: string): void => {
  try {
    const list = getPaletteRecents().filter(r => r.id !== id);
    list.unshift({ id, title, at: Date.now() });
    localStorage.setItem(PALETTE_RECENTS_KEY, JSON.stringify(list.slice(0, 6)));
  } catch { /* ignore */ }
};

// Global command palette (Cmd/Ctrl-K) plus a lightweight shortcut layer and a
// "?" help overlay, mounted once near the app root.
export const CommandPalette: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { toast } = useToast();
  const { reducedMotion } = useTheme();
  const [open, setOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState(0);
  const [recentsTick, setRecentsTick] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const selectedRowRef = useRef<HTMLButtonElement | null>(null);
  const reqId = useRef(0);
  const clockInFlight = useRef(false);

  // On the canvas page the single-key shortcuts belong to the drawing tools, so
  // only the modifier-based palette shortcut is active there.
  const onCanvas = !!matchPath('/project/:projectId/page/:pageId', location.pathname);

  // Project context: when inside a project, the palette offers contextual actions.
  const projMatch = matchPath('/project/:projectId/*', location.pathname) || matchPath('/project/:projectId', location.pathname);
  const projectId = projMatch?.params?.projectId as string | undefined;
  const isAdmin = (() => { try { return JSON.parse(localStorage.getItem('user') || '{}').role === 'admin'; } catch { return false; } })();

  const close = useCallback(() => { setOpen(false); setQuery(''); setResults([]); setSelected(0); }, []);

  const staticActions: Action[] = useMemo(() => [
    { id: 'a:new', type: 'action', title: 'New project', icon: <Plus size={16} />, run: () => navigate('/new') },
    { id: 'a:home', type: 'action', title: 'Dashboard', icon: <Home size={16} />, run: () => navigate('/dashboard') },
    { id: 'a:projects', type: 'action', title: 'Projects', icon: <FolderOpen size={16} />, run: () => navigate('/projects') },
    { id: 'a:settings', type: 'action', title: 'Settings', icon: <SettingsIcon size={16} />, run: () => navigate('/settings') },
    { id: 'a:editor', type: 'action', title: 'Document editor', subtitle: 'Open a PDF, Word or Excel file', icon: <FileText size={16} />, run: () => navigate('/tools/edit') },
    // Open the New document dialog on the Documents page, filed in the
    // project you are in (ONLYOFFICE Phase 3).
    ...([['docx', 'New Word document'], ['xlsx', 'New spreadsheet'], ['pdf', 'New PDF form']] as const).map(([type, title]) => ({
      id: `a:new-${type}`, type: 'action' as const, title, icon: <FilePlus2 size={16} />,
      run: () => {
        // Already on Documents: keep its filters (a project's Documents tab
        // preselects that project).
        const params = new URLSearchParams(location.pathname === '/documents' ? location.search : '');
        if (projectId) params.set('projectIds', projectId);
        params.set('new', type);
        navigate(`/documents?${params.toString()}`);
      },
    })),
    { id: 'a:tasks', type: 'action', title: 'Tasks', icon: <ListTodo size={16} />, run: () => navigate('/tasks') },
    { id: 'a:documents', type: 'action', title: 'Documents', icon: <FolderOpen size={16} />, run: () => navigate('/documents') },
    { id: 'a:mail', type: 'action', title: 'Mail', icon: <Mail size={16} />, run: () => navigate('/mail') },
    { id: 'a:mail-compose', type: 'action', title: 'New email', icon: <Plus size={16} />, run: () => navigate('/mail?compose=1') },
    { id: 'a:time', type: 'action', title: 'Time tracking', icon: <Clock size={16} />, run: () => navigate('/time') },
    // Billing reports are admin-only, like billing itself.
    ...(isAdmin ? [{
      id: 'a:reports', type: 'action' as const, title: 'Reports', subtitle: 'Open invoices, payments, change orders, retainage',
      icon: <BarChart3 size={16} />, run: () => navigate('/reports'),
    }] : []),
    {
      id: 'a:clock', type: 'action', title: 'Clock in / out', icon: <Clock size={16} />,
      run: async () => {
        if (clockInFlight.current) return;
        clockInFlight.current = true;
        try {
          const entries = await getMyTimeEntries();
          const open = entries.find(e => e.clockOut === null);
          if (open) { await clockOut(); toast('Clocked out', { type: 'success' }); }
          else { await clockIn(); toast('Clocked in', { type: 'success' }); }
        } catch { toast('Clock action failed', { type: 'error' }); }
        finally { clockInFlight.current = false; }
      },
    },
  ], [navigate, toast, projectId, location.pathname, location.search, isAdmin]);

  // Contextual actions: surfaced only when the user is inside a project.
  const contextualActions: Action[] = useMemo(() => {
    if (!projectId) return [];
    const actions: Action[] = [
      { id: 'ctx:new-issue', type: 'action' as const, title: 'New issue', subtitle: 'Project', icon: <AlertCircle size={16} />, run: () => navigate(`/project/${projectId}/issues?new=1`) },
      { id: 'ctx:new-rfi', type: 'action' as const, title: 'New RFI', subtitle: 'Project', icon: <MessageCircleQuestion size={16} />, run: () => navigate(`/project/${projectId}/rfis?new=1`) },
      { id: 'ctx:new-punch', type: 'action' as const, title: 'New punch item', subtitle: 'Project', icon: <ClipboardCheck size={16} />, run: () => navigate(`/project/${projectId}/punch?new=1`) },
      { id: 'ctx:new-daily-report', type: 'action' as const, title: 'New daily report', subtitle: 'Project', icon: <CalendarDays size={16} />, run: () => navigate(`/project/${projectId}/daily-reports?new=1`) },
      { id: 'ctx:new-task', type: 'action' as const, title: 'New task', subtitle: 'Project', icon: <ListTodo size={16} />, run: () => navigate('/tasks?new=1') },
      { id: 'ctx:overview', type: 'action' as const, title: 'Project overview', subtitle: 'Project', icon: <LayoutGrid size={16} />, run: () => navigate(`/project/${projectId}`) },
      { id: 'ctx:takeoff', type: 'action' as const, title: 'Takeoff & estimate', subtitle: 'Project', icon: <Ruler size={16} />, run: () => navigate(`/project/${projectId}/takeoff`) },
      { id: 'ctx:documents', type: 'action' as const, title: 'Documents', subtitle: 'Project', icon: <FolderOpen size={16} />, run: () => navigate(`/project/${projectId}/documents`) },
      { id: 'ctx:punch', type: 'action' as const, title: 'Punch & checklists', subtitle: 'Project', icon: <ClipboardCheck size={16} />, run: () => navigate(`/project/${projectId}/punch`) },
      { id: 'ctx:issues', type: 'action' as const, title: 'Issues', subtitle: 'Project', icon: <AlertCircle size={16} />, run: () => navigate(`/project/${projectId}/issues`) },
      { id: 'ctx:rfis', type: 'action' as const, title: 'RFIs', subtitle: 'Project', icon: <MessageCircleQuestion size={16} />, run: () => navigate(`/project/${projectId}/rfis`) },
      { id: 'ctx:daily-reports', type: 'action' as const, title: 'Daily Reports', subtitle: 'Project', icon: <CalendarDays size={16} />, run: () => navigate(`/project/${projectId}/daily-reports`) },
      { id: 'ctx:time', type: 'action' as const, title: 'Time', subtitle: 'Project', icon: <Clock size={16} />, run: () => navigate(`/project/${projectId}/time`) },
      { id: 'ctx:notes', type: 'action' as const, title: 'Notes', subtitle: 'Project', icon: <StickyNote size={16} />, run: () => navigate(`/project/${projectId}/notes`) },
    ];
    if (isAdmin) {
      actions.push(
        { id: 'ctx:proposal', type: 'action' as const, title: 'Open proposal', subtitle: 'Project', icon: <FileText size={16} />, run: () => navigate(`/project/${projectId}/proposal`) },
        { id: 'ctx:billing', type: 'action' as const, title: 'Billing', subtitle: 'Project', icon: <DollarSign size={16} />, run: () => navigate(`/project/${projectId}/billing`) },
        { id: 'ctx:settings', type: 'action' as const, title: 'Project settings', subtitle: 'Project', icon: <SlidersHorizontal size={16} />, run: () => navigate(`/project/${projectId}/settings`) },
      );
    }
    return actions;
  }, [projectId, isAdmin, navigate]);

  const allActions = useMemo(() => [...contextualActions, ...staticActions], [contextualActions, staticActions]);

  // Debounced search.
  useEffect(() => {
    if (!open) return;
    const q = query.trim();
    if (q.length < 2) { setResults([]); setLoading(false); return; }
    setLoading(true);
    const id = ++reqId.current;
    const t = setTimeout(async () => {
      try {
        const r = await searchAll(q);
        if (id === reqId.current) setResults(r);
      } catch {
        if (id === reqId.current) setResults([]);
      } finally {
        if (id === reqId.current) setLoading(false);
      }
    }, 200);
    return () => clearTimeout(t);
  }, [query, open]);

  const filteredContextual = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return contextualActions;
    return contextualActions.filter(a => a.title.toLowerCase().includes(q));
  }, [contextualActions, query]);

  const filteredStatic = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return staticActions;
    return staticActions.filter(a => a.title.toLowerCase().includes(q));
  }, [staticActions, query]);

  // Recently-executed actions (not search results), shown only while the
  // query is empty — resolved against allActions so a recent id from a
  // different project context (or a removed action) simply drops out.
  const recentActionItems: Action[] = useMemo(() => {
    if (query.trim()) return [];
    const byId = new Map(allActions.map(a => [a.id, a] as const));
    return getPaletteRecents()
      .map(r => byId.get(r.id))
      .filter((a): a is Action => !!a)
      .slice(0, 6);
    // recentsTick forces a re-read of localStorage after an action runs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [allActions, query, recentsTick]);

  // Grouped for display (Recent / This project / Actions / Search results).
  // The flat `items` array below is the ONE selection model — headers are a
  // render-only interleave derived from these group boundaries, so arrow-key
  // and Enter semantics never need to know about grouping at all.
  const groups: Group[] = useMemo(() => {
    const g: Group[] = [];
    if (recentActionItems.length) g.push({ label: 'Recent', items: recentActionItems });
    if (filteredContextual.length) g.push({ label: 'This project', items: filteredContextual });
    if (filteredStatic.length) g.push({ label: 'Actions', items: filteredStatic });
    if (results.length) g.push({ label: 'Search results', items: results.map(r => ({ ...r, icon: typeIcon(r.type) })) });
    return g;
  }, [recentActionItems, filteredContextual, filteredStatic, results]);

  const items: Item[] = useMemo(() => groups.flatMap(g => g.items), [groups]);

  // Maps a flat item index to the group header that should render just before
  // it (only set on the first index of each non-empty group).
  const headerAt = useMemo(() => {
    const m = new Map<number, string>();
    let idx = 0;
    for (const g of groups) {
      if (g.items.length) m.set(idx, g.label);
      idx += g.items.length;
    }
    return m;
  }, [groups]);

  useEffect(() => { setSelected(0); }, [items.length]);

  // M5: arrow-key navigation past the visible window (the results pane
  // scrolls internally, `max-h-[50vh] overflow-y-auto`) needs to bring the
  // newly-selected row into view itself — 'nearest' so it only scrolls when
  // the row is actually clipped, not on every keypress.
  useEffect(() => {
    // Optional-called: jsdom (unit tests) doesn't implement scrollIntoView
    // at all on some setups, unlike a real browser.
    selectedRowRef.current?.scrollIntoView?.({ block: 'nearest' });
  }, [selected]);

  const runItem = useCallback((item: Item) => {
    close();
    if (item.type === 'action') {
      recordPaletteRecent(item.id, item.title);
      setRecentsTick(t => t + 1);
      item.run();
      return;
    }
    switch (item.type) {
      case 'project': navigate(`/project/${item.projectId}`); break;
      case 'page': navigate(`/project/${item.projectId}/page/${item.pageId}`); break;
      case 'takeoff': navigate(`/project/${item.projectId}/takeoff?tab=takeoffs`); break;
    }
  }, [close, navigate]);

  // Global key handling.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === 'k' || e.key === 'K')) {
        e.preventDefault();
        setHelpOpen(false);
        setOpen(o => !o);
        return;
      }
      if (open) {
        if (e.key === 'Escape') { e.preventDefault(); close(); return; }
        if (e.key === 'ArrowDown') { e.preventDefault(); setSelected(s => Math.min(s + 1, Math.max(items.length - 1, 0))); return; }
        if (e.key === 'ArrowUp') { e.preventDefault(); setSelected(s => Math.max(s - 1, 0)); return; }
        if (e.key === 'Enter') { e.preventDefault(); if (items[selected]) runItem(items[selected]); return; }
        return;
      }
      if (helpOpen && e.key === 'Escape') { setHelpOpen(false); return; }
      // Single-key shortcuts: only when not typing and not on the canvas.
      if (isTyping() || onCanvas) return;
      if (e.key === '/') { e.preventDefault(); setOpen(true); return; }
      if (e.key === '?') { e.preventDefault(); setHelpOpen(h => !h); return; }
      if (e.key === 'n' || e.key === 'N') { e.preventDefault(); navigate('/new'); return; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, helpOpen, items, selected, onCanvas, navigate, close, runItem]);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 10);
  }, [open]);

  // Lets other UI (e.g. the side dock search button) open the palette.
  useEffect(() => {
    const openHandler = () => { setHelpOpen(false); setOpen(true); };
    window.addEventListener('open-command-palette', openHandler);
    return () => window.removeEventListener('open-command-palette', openHandler);
  }, []);

  const globalShortcuts = [
    { keys: ['⌘/Ctrl', 'K'], label: 'Open command palette / search' },
    { keys: ['/'], label: 'Search (when not typing)' },
    { keys: ['n'], label: 'New project' },
    { keys: ['?'], label: 'Show this help' },
    { keys: ['↑', '↓'], label: 'Move through results' },
    { keys: ['↵'], label: 'Open selected result' },
    { keys: ['Esc'], label: 'Close' },
  ];

  // Kept in sync with canvas/KeyboardShortcutsModal.tsx, which stays the
  // canvas page's own in-context help — these entries just make this
  // app-wide overlay complete for anyone who opens it from elsewhere.
  const canvasShortcuts = [
    { keys: ['⌘/Ctrl', 'Z'], label: 'Undo' },
    { keys: ['⌘/Ctrl', '⇧', 'Z'], label: 'Redo (or Ctrl+Y)' },
    { keys: ['Delete'], label: 'Delete selected measurement' },
    { keys: ['Backspace'], label: 'Remove last point (while drawing)' },
    { keys: ['P'], label: 'Resume/extend selected measurement' },
    { keys: ['A'], label: 'Toggle arc mode (while drawing)' },
    { keys: ['⌘/Ctrl', 'C'], label: 'Copy measurement' },
    { keys: ['⌘/Ctrl', 'V'], label: 'Paste measurement' },
    { keys: ['←', '→'], label: 'Previous / next page' },
    { keys: ['↵'], label: 'Finish current measurement' },
  ];

  return (
    <>
      <AnimatePresence>
        {open && (
          <motion.div
            className="fixed inset-0 z-[400] flex items-start justify-center p-4 pt-[12vh] bg-black/30 backdrop-blur-sm"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={close} role="dialog" aria-modal="true" aria-label="Command palette"
            // Fix wave I2 (+ residual fix covering the helpOpen overlay
            // below): signals to other Escape-capturing layers (e.g.
            // Lightbox, z-300, listens on the CAPTURE phase) that a
            // palette-family surface is the topmost thing open, so they
            // should let Escape bubble through to this component's own
            // window listener instead of swallowing it for themselves.
            // Both z-[400] overlays this component renders (search dialog
            // here, keyboard-shortcuts help below) carry this marker —
            // either one being up is enough to invert the layering.
            data-palette-open="true"
          >
            <motion.div
              className="w-full max-w-xl glass-panel border border-edge rounded-2xl shadow-2xl overflow-hidden"
              initial={reducedMotion ? false : { opacity: 0, scale: 0.97, y: -8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={reducedMotion ? { opacity: 1 } : { opacity: 0, scale: 0.97, y: -8 }}
              transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 30 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-center gap-3 px-4 border-b border-edge">
                <Search size={18} className="text-ink-faint shrink-0" />
                <input
                  ref={inputRef}
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search projects, pages, takeoffs…"
                  aria-label="Search"
                  className="flex-1 py-4 bg-transparent outline-none text-ink placeholder:text-ink-faint text-sm"
                />
                {loading && <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-accent-600 shrink-0" />}
              </div>
              <div className="max-h-[50vh] overflow-y-auto py-2 scroll-fade">
                {items.length === 0 ? (
                  <div className="px-4 py-8 text-center text-sm text-ink-faint">
                    {query.trim().length < 2 ? 'Type to search…' : 'No matches found.'}
                  </div>
                ) : (
                  items.map((item, i) => (
                    <React.Fragment key={`${i}-${item.id}`}>
                      {headerAt.has(i) && (
                        <div className="px-4 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-faint first:pt-1">
                          {headerAt.get(i)}
                        </div>
                      )}
                      <button
                        ref={i === selected ? selectedRowRef : undefined}
                        onMouseEnter={() => setSelected(i)}
                        onClick={() => runItem(item)}
                        style={reducedMotion ? undefined : ({ '--i': Math.min(i, 10) } as React.CSSProperties)}
                        className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${reducedMotion ? '' : 'palette-row-cascade'} ${
                          i === selected ? 'bg-accent-50 dark:bg-accent-900/30' : 'hover:bg-hover/50'
                        }`}
                      >
                        <span className={`shrink-0 ${i === selected ? 'text-accent-600' : 'text-ink-faint'}`}>
                          {('icon' in item && item.icon) || <Search size={16} />}
                        </span>
                        <span className="flex-1 min-w-0">
                          <span className="block truncate text-sm text-ink">{item.title}</span>
                          {'subtitle' in item && item.subtitle && (
                            <span className="block truncate text-xs text-ink-faint">{item.subtitle}</span>
                          )}
                        </span>
                        {item.type !== 'action' && (
                          <span className="shrink-0 text-[10px] uppercase tracking-wider font-semibold text-ink-faint bg-sunken rounded px-1.5 py-0.5">
                            {typeLabel[item.type]}
                          </span>
                        )}
                        {i === selected && <CornerDownLeft size={14} className="shrink-0 text-ink-faint" />}
                      </button>
                    </React.Fragment>
                  ))
                )}
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      <AnimatePresence>
        {helpOpen && (
          <motion.div
            className="fixed inset-0 z-[400] flex items-center justify-center p-4 bg-black/30 backdrop-blur-sm"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            onClick={() => setHelpOpen(false)} role="dialog" aria-modal="true" aria-label="Keyboard shortcuts"
            data-palette-open="true"
          >
            <motion.div
              className="w-full max-w-md glass-panel border border-edge rounded-2xl shadow-xl overflow-hidden"
              initial={reducedMotion ? false : { opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={reducedMotion ? { opacity: 1 } : { opacity: 0, scale: 0.95 }}
              transition={reducedMotion ? { duration: 0 } : { type: 'spring', stiffness: 380, damping: 30 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="px-6 py-4 border-b border-edge flex items-center justify-between">
                <h2 className="text-lg font-bold text-ink flex items-center gap-2">
                  <Keyboard size={18} className="text-accent-600" /> Keyboard shortcuts
                </h2>
                <button onClick={() => setHelpOpen(false)} aria-label="Close" className="p-1.5 rounded-lg text-ink-faint hover:text-ink hover:bg-hover">
                  <X size={18} />
                </button>
              </div>
              <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto scroll-fade">
                <div className="space-y-3">
                  {globalShortcuts.map((s, i) => (
                    <div key={i} className="flex items-center justify-between gap-4 text-sm">
                      <span className="text-ink-soft">{s.label}</span>
                      <span className="flex items-center gap-1 shrink-0">
                        {s.keys.map((k, j) => (
                          <kbd key={j} className="px-2 py-1 rounded-md bg-sunken border border-edge text-xs font-mono text-ink-soft">{k}</kbd>
                        ))}
                      </span>
                    </div>
                  ))}
                </div>
                <div>
                  <div className="px-0.5 pb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-faint">
                    On the canvas
                  </div>
                  <div className="space-y-3">
                    {canvasShortcuts.map((s, i) => (
                      <div key={i} className="flex items-center justify-between gap-4 text-sm">
                        <span className="text-ink-soft">{s.label}</span>
                        <span className="flex items-center gap-1 shrink-0">
                          {s.keys.map((k, j) => (
                            <kbd key={j} className="px-2 py-1 rounded-md bg-sunken border border-edge text-xs font-mono text-ink-soft">{k}</kbd>
                          ))}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
};
