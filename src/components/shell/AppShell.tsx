// src/components/shell/AppShell.tsx
import React, { useEffect, useState } from 'react';
import { useLocation, matchPath } from 'react-router-dom';
import { Menu, Search } from 'lucide-react';
import { Sidebar, SidebarState } from './Sidebar';
import { isBareRoute } from '../../utils/locationInfo';
import { useNotifications } from '../../context/NotificationsContext';

// Keep the legacy storage key so existing users keep their saved preference.
const SIDEBAR_STORAGE_KEY = 'sideDockState';

export const AppShell: React.FC<{ appName: string; children: React.ReactNode }> = ({ appName, children }) => {
  const location = useLocation();
  const isBare = isBareRoute(location.pathname);
  // Unread notifications show as a dot on the phone's menu button: the bell
  // itself is inside the drawer.
  const { unread } = useNotifications();
  const isCanvasPage = !!matchPath('/project/:projectId/page/:pageId', location.pathname);
  // A file open in the document editor gets the same thin rail as the canvas:
  // ONLYOFFICE's toolbar wants the width.
  const isEditorOpen = (location.pathname === '/tools/edit' && new URLSearchParams(location.search).has('fileId'))
    || location.pathname === '/tools/view';

  const [sidebarState, setSidebarState] = useState<SidebarState>(() => {
    const saved = localStorage.getItem(SIDEBAR_STORAGE_KEY) as SidebarState | null;
    return saved && ['expanded', 'collapsed', 'hidden'].includes(saved) ? saved : 'expanded';
  });

  const [isMobile, setIsMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const mq = window.matchMedia('(max-width: 767px)');
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches);
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Mobile-only slide-in drawer state. Desktop never touches this.
  const [mobileSidebarOpen, setMobileSidebarOpen] = useState(false);
  // Close the drawer whenever the route changes (covers nav-item clicks too,
  // which navigate).
  useEffect(() => {
    setMobileSidebarOpen(false);
  }, [location.pathname]);
  // Never leave the drawer "open" lingering when crossing back to desktop.
  useEffect(() => {
    if (!isMobile) setMobileSidebarOpen(false);
  }, [isMobile]);

  const handleChange = (s: SidebarState) => {
    setSidebarState(s);
    localStorage.setItem(SIDEBAR_STORAGE_KEY, s);
  };

  // Canvas is full-bleed (spec §4.3): thin rail on desktop, no sidebar on
  // mobile. The stored preference is left untouched.
  const effectiveState: SidebarState = isCanvasPage || isEditorOpen ? 'collapsed' : sidebarState;
  const showSidebar = !isBare && !(isMobile && isCanvasPage);

  // On mobile the sidebar never consumes horizontal space on ANY route — it
  // becomes an overlay drawer instead. Desktop keeps the inline-marginLeft offset.
  const marginLeft = isMobile
    ? 0
    : !showSidebar || effectiveState === 'hidden'
      ? 0
      : effectiveState === 'collapsed'
        ? 64
        : 208;

  // Mobile top bar: only for non-canvas routes (canvas has its own chrome) and
  // only while logged in.
  const showMobileTopBar = isMobile && !isCanvasPage && !isBare;

  return (
    <>
      {showSidebar &&
        (isMobile ? (
          <>
            {/* Dimmed backdrop behind the drawer */}
            {mobileSidebarOpen && (
              <div
                className="fixed inset-0 z-[45] bg-black/50 md:hidden"
                aria-hidden="true"
                onClick={() => setMobileSidebarOpen(false)}
              />
            )}
            {/* Slide-in overlay drawer (always expanded on mobile). The wrapper
                MUST carry the sidebar's width (w-52): the inner <Sidebar> is
                position:fixed and out of flow, so without an explicit width the
                wrapper collapses to 0px and `-translate-x-full` (−100% of 0)
                moves nothing — leaving the drawer stuck open. The wrapper's
                translate makes it the containing block for the fixed child, so
                the child slides with it. */}
            <div
              className={`fixed inset-y-0 left-0 w-52 z-[46] md:hidden transition-transform duration-200 ${
                mobileSidebarOpen ? 'translate-x-0' : '-translate-x-full'
              }`}
            >
              <Sidebar
                state="expanded"
                onChange={handleChange}
                locked
                onNavigate={() => setMobileSidebarOpen(false)}
              />
            </div>
          </>
        ) : (
          <Sidebar state={effectiveState} onChange={handleChange} locked={isCanvasPage} />
        ))}

      {showMobileTopBar && (
        <header className="fixed top-0 inset-x-0 z-40 flex items-center gap-2 h-14 px-2 pt-safe glass-panel border-b border-edge md:hidden">
          <button
            onClick={() => setMobileSidebarOpen(true)}
            aria-label={unread ? `Open navigation (${unread} unread notifications)` : 'Open navigation'}
            className="relative flex items-center justify-center min-h-11 min-w-11 rounded-lg text-ink-soft hover:bg-hover active:bg-hover transition-colors"
          >
            <Menu size={20} />
            {unread > 0 && (
              <span data-testid="mobile-notification-dot" className="absolute right-2 top-2 h-2.5 w-2.5 rounded-full bg-red-500 ring-2 ring-surface" />
            )}
          </button>
          <span className="flex-1 truncate font-semibold text-ink">{appName}</span>
          <button
            onClick={() => window.dispatchEvent(new CustomEvent('open-command-palette'))}
            aria-label="Search"
            className="flex items-center justify-center min-h-11 min-w-11 rounded-lg text-ink-soft hover:bg-hover active:bg-hover transition-colors"
          >
            <Search size={20} />
          </button>
        </header>
      )}

      <div
        className="min-h-screen"
        style={{
          marginLeft,
          transition: 'margin-left 200ms',
          // Offset content below the fixed mobile top bar (h-14) plus the
          // top safe-area inset it reserves via pt-safe.
          ...(showMobileTopBar
            ? { paddingTop: 'calc(3.5rem + env(safe-area-inset-top))' }
            : {}),
        }}
      >
        {children}
      </div>
    </>
  );
};
