// src/components/shell/Sidebar.tsx
import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Menu, PanelLeftClose, Search, FolderKanban, ListTodo, Clock,
  FileEdit, Settings, LogOut, Sun, Moon,
  FolderOpen, LayoutDashboard, Users, Mail, BarChart3,
} from 'lucide-react';
import { useTheme } from '../../context/ThemeContext';
import { useMailUnread } from '../../pages/mail/useMailUnread';
import { SidebarPresence } from './SidebarPresence';
import { NotificationBell } from './NotificationBell';
import { isBareRoute } from '../../utils/locationInfo';
import { endMediaSession } from '../../utils/store';

export type SidebarState = 'expanded' | 'collapsed' | 'hidden';

interface NavEntry {
  id: string;
  label: string;
  Icon: React.FC<{ size?: number; className?: string }>;
  path: string;
  match: (pathname: string) => boolean;
  // Shown to admins only (billing is admin-only everywhere) — same flag as
  // ProjectSection.adminOnly on the project tab bar.
  adminOnly?: boolean;
}

const WORKSPACE_NAV: NavEntry[] = [
  { id: 'dashboard', label: 'Dashboard', Icon: LayoutDashboard, path: '/dashboard', match: p => p === '/' || p.startsWith('/dashboard') },
  { id: 'projects', label: 'Projects', Icon: FolderKanban, path: '/projects', match: p => p.startsWith('/projects') || p === '/new' || p.startsWith('/project') },
  { id: 'customers', label: 'Customers', Icon: Users, path: '/customers', match: p => p.startsWith('/customers') },
  { id: 'tasks', label: 'Tasks', Icon: ListTodo, path: '/tasks', match: p => p.startsWith('/tasks') },
  { id: 'documents', label: 'Documents', Icon: FolderOpen, path: '/documents', match: p => p.startsWith('/documents') },
  { id: 'mail', label: 'Mail', Icon: Mail, path: '/mail', match: p => p.startsWith('/mail') },
  { id: 'time', label: 'Time', Icon: Clock, path: '/time', match: p => p.startsWith('/time') },
  { id: 'reports', label: 'Reports', Icon: BarChart3, path: '/reports', match: p => p.startsWith('/reports'), adminOnly: true },
];

const TOOLS_NAV: NavEntry[] = [
  { id: 'document-editor', label: 'Document Editor', Icon: FileEdit, path: '/tools/edit', match: p => p.startsWith('/tools/edit') },
];

// Row used by every nav item. The active item gets the glow treatment —
// spec §5 rule 2: glow is for primary buttons, active nav, progress bars only.
const NavRow: React.FC<{
  label: string;
  Icon: NavEntry['Icon'];
  active?: boolean;
  expanded: boolean;
  onClick: (e?: React.MouseEvent) => void;
  trailing?: React.ReactNode;
  // Unread-style count badge (currently just Mail). >0 shows a pill with the
  // count when expanded, or a plain dot on the icon when collapsed.
  badge?: number;
  // Names the badge for e2e (the dot and the pill are the same badge in two
  // widths, so both carry it — only one is ever rendered).
  badgeTestId?: string;
}> = ({ label, Icon, active = false, expanded, onClick, trailing, badge, badgeTestId }) => (
  <button
    onClick={e => onClick(e)}
    title={!expanded ? label : undefined}
    className={`w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors group ${
      active ? 'glow-accent text-white active:brightness-95' : 'text-ink-soft hover:bg-hover hover:text-ink active:bg-hover'
    }`}
  >
    <span className="relative shrink-0 nav-icon inline-flex">
      <Icon size={18} className="shrink-0" />
      {!expanded && !!badge && badge > 0 && (
        <span
          role="img"
          aria-label={`${badge} unread`}
          data-testid={badgeTestId}
          className="absolute -top-0.5 -right-0.5 h-2 w-2 rounded-full bg-accent-500"
        />
      )}
    </span>
    {expanded && <span className="flex-1 truncate text-left">{label}</span>}
    {expanded && !!badge && badge > 0 && (
      <span
        role="img"
        aria-label={`${badge} unread`}
        data-testid={badgeTestId}
        className="bg-accent-500 text-white text-[10px] font-semibold rounded-full px-1.5 leading-normal"
      >
        {badge}
      </span>
    )}
    {expanded && trailing}
  </button>
);

const SectionLabel: React.FC<{ show: boolean; children: React.ReactNode }> = ({ show, children }) =>
  show ? (
    <p className="px-3 pt-4 pb-1 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
      {children}
    </p>
  ) : null;

interface SidebarProps {
  state: SidebarState;
  onChange: (s: SidebarState) => void;
  // True on canvas routes: the rail is forced thin and the size toggles hide.
  locked?: boolean;
  // Fired when a nav item is clicked — lets the mobile drawer close itself.
  onNavigate?: () => void;
}

export const Sidebar: React.FC<SidebarProps> = ({ state, onChange, locked = false, onNavigate }) => {
  const location = useLocation();
  const navigate = useNavigate();
  // Wrap navigation so the mobile drawer closes on selection.
  const go = (path: string) => { navigate(path); onNavigate?.(); };
  const { mode, toggleMode } = useTheme();
  const mailUnread = useMailUnread();

  if (isBareRoute(location.pathname) || !localStorage.getItem('token')) return null;

  const user = JSON.parse(localStorage.getItem('user') || '{}');
  const isAdmin = user.role === 'admin';
  const visible = (items: NavEntry[]) => items.filter(item => !item.adminOnly || isAdmin);
  const expanded = state === 'expanded';

  const handleLogout = () => {
    endMediaSession();
    localStorage.removeItem('token');
    localStorage.removeItem('user');
    window.location.href = '/login';
  };

  if (state === 'hidden') {
    return (
      <button
        onClick={() => onChange('collapsed')}
        title="Open navigation"
        className="fixed top-4 left-4 z-50 flex items-center justify-center min-h-11 min-w-11 md:min-h-0 md:min-w-0 p-2.5 bg-raised rounded-xl shadow-lg border border-edge text-ink-soft hover:bg-hover active:bg-hover transition-colors"
      >
        <Menu size={18} />
      </button>
    );
  }

  return (
    <div
      className={`fixed left-0 top-0 h-full z-40 flex flex-col glass-panel border-r border-edge overflow-hidden transition-all duration-200 ${
        expanded ? 'w-52' : 'w-16'
      }`}
    >
      {/* Header */}
      <div className={`flex items-center h-14 px-3 border-b border-edge shrink-0 ${expanded ? 'justify-between' : 'justify-center'}`}>
        {!locked ? (
          <button
            onClick={() => onChange(expanded ? 'collapsed' : 'expanded')}
            title={expanded ? 'Collapse' : 'Expand navigation'}
            className="flex items-center justify-center min-h-11 min-w-11 md:min-h-0 md:min-w-0 p-1.5 rounded-lg hover:bg-hover active:bg-hover text-ink-soft transition-colors"
          >
            <Menu size={18} />
          </button>
        ) : (
          <div className="p-1.5 text-ink-faint"><Menu size={18} /></div>
        )}
        {expanded && !locked && (
          <button
            onClick={() => onChange('hidden')}
            title="Hide sidebar"
            className="flex items-center justify-center min-h-11 min-w-11 md:min-h-0 md:min-w-0 p-1.5 rounded-lg hover:bg-hover active:bg-hover text-ink-faint transition-colors"
          >
            <PanelLeftClose size={18} />
          </button>
        )}
      </div>

      {/* Nav */}
      <div className="flex-1 py-2 px-2 overflow-y-auto scroll-fade">
        <NavRow
          label="Search"
          Icon={Search}
          expanded={expanded}
          onClick={() => { onNavigate?.(); window.dispatchEvent(new CustomEvent('open-command-palette')); }}
          trailing={
            <kbd className="hidden md:inline-flex text-[10px] font-mono text-ink-faint border border-edge rounded px-1 py-0.5">⌘K</kbd>
          }
        />
        <SectionLabel show={expanded}>Workspace</SectionLabel>
        <div className="space-y-0.5">
          {visible(WORKSPACE_NAV).map(item => (
            <NavRow
              key={item.id}
              label={item.label}
              Icon={item.Icon}
              expanded={expanded}
              active={item.match(location.pathname)}
              onClick={() => go(item.path)}
              badge={item.id === 'mail' ? mailUnread : undefined}
              badgeTestId={item.id === 'mail' ? 'sidebar-mail-badge' : undefined}
            />
          ))}
        </div>
        <SectionLabel show={expanded}>Tools</SectionLabel>
        <div className="space-y-0.5">
          {visible(TOOLS_NAV).map(item => (
            <NavRow
              key={item.id}
              label={item.label}
              Icon={item.Icon}
              expanded={expanded}
              active={item.match(location.pathname)}
              onClick={() => go(item.path)}
            />
          ))}
        </div>
      </div>

      {/* Footer */}
      <div className="px-2 pb-3 pt-2 pb-safe border-t border-edge space-y-0.5 shrink-0">
        {/* Who's online, with the notification bell beside it (stacked on the thin rail). */}
        <div className={expanded ? 'flex items-center gap-1' : 'flex flex-col gap-0.5'}>
          <div className="min-w-0 flex-1"><SidebarPresence expanded={expanded} /></div>
          <NotificationBell expanded={expanded} />
        </div>
        <NavRow
          label={mode === 'dark' ? 'Light mode' : 'Dark mode'}
          Icon={mode === 'dark' ? Sun : Moon}
          expanded={expanded}
          onClick={(e?: React.MouseEvent) => {
            const rect = (e?.currentTarget as HTMLElement | undefined)?.getBoundingClientRect();
            window.dispatchEvent(new CustomEvent('theme-wipe', {
              detail: { x: rect ? rect.left + rect.width / 2 : 32, y: rect ? rect.top + rect.height / 2 : window.innerHeight - 96 },
            }));
            toggleMode();
          }}
        />
        <NavRow
          label="Settings"
          Icon={Settings}
          expanded={expanded}
          active={location.pathname === '/settings'}
          onClick={() => go('/settings')}
        />
        <button
          onClick={handleLogout}
          title={!expanded ? `${user.username || 'User'} — Logout` : undefined}
          className="w-full flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium text-ink-soft hover:bg-red-50 dark:hover:bg-red-900/20 hover:text-red-600 dark:hover:text-red-400 transition-colors"
        >
          <LogOut size={18} className="shrink-0" />
          {expanded && (
            <div className="text-left min-w-0">
              <p className="text-sm font-medium truncate">{user.username || 'User'}</p>
              <p className="text-[11px] text-ink-faint">Logout</p>
            </div>
          )}
        </button>
      </div>
    </div>
  );
};
