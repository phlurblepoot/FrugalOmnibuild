// src/pages/project/ProjectTabBar.tsx
// Horizontal project-section nav (rehaul spec §4). The section data moved
// here verbatim from the old sidebar PROJECT_NAV. Labels are an e2e
// contract (collab-follow.spec.ts clicks them by accessible name).
import React from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  LayoutGrid, Ruler, FileText, FolderOpen, ClipboardCheck, StickyNote, Clock,
  AlertCircle, MessageCircleQuestion, CalendarDays, Mail, DollarSign, SlidersHorizontal,
} from 'lucide-react';

export interface ProjectSection {
  id: string;
  label: string;
  Icon: React.FC<{ size?: number; className?: string }>;
  path: string;
  match: (pathname: string, base: string) => boolean;
  adminOnly?: boolean;
}

export const PROJECT_SECTIONS: ProjectSection[] = [
  { id: 'overview',  label: 'Overview',           Icon: LayoutGrid,  path: '',           match: (p, b) => p === b },
  { id: 'takeoff',   label: 'Takeoff & Estimate', Icon: Ruler,       path: '/takeoff',   match: (p, b) => p.startsWith(`${b}/takeoff`) || p.startsWith(`${b}/page/`) },
  { id: 'proposal',  label: 'Proposal',           Icon: FileText,    path: '/proposal',  match: (p, b) => p.startsWith(`${b}/proposal`), adminOnly: true },
  { id: 'documents', label: 'Documents',          Icon: FolderOpen,  path: '/documents', match: (p, b) => p.startsWith(`${b}/documents`) },
  { id: 'punch',     label: 'Punch & Checklists', Icon: ClipboardCheck, path: '/punch',  match: (p, b) => p.startsWith(`${b}/punch`) },
  { id: 'notes',     label: 'Notes',              Icon: StickyNote,  path: '/notes',     match: (p, b) => p.startsWith(`${b}/notes`) },
  { id: 'time',      label: 'Time',               Icon: Clock,       path: '/time',      match: (p, b) => p.startsWith(`${b}/time`) },
  { id: 'issues',    label: 'Issues',             Icon: AlertCircle, path: '/issues',    match: (p, b) => p.startsWith(`${b}/issues`) },
  { id: 'rfis',      label: 'RFIs',               Icon: MessageCircleQuestion, path: '/rfis', match: (p, b) => p.startsWith(`${b}/rfis`) },
  { id: 'daily-reports', label: 'Daily Reports',  Icon: CalendarDays, path: '/daily-reports', match: (p, b) => p.startsWith(`${b}/daily-reports`) },
  { id: 'mail',      label: 'Mail',               Icon: Mail,        path: '/mail',      match: (p, b) => p.startsWith(`${b}/mail`) },
  { id: 'billing',   label: 'Billing',            Icon: DollarSign,  path: '/billing',   match: (p, b) => p.startsWith(`${b}/billing`), adminOnly: true },
  { id: 'settings',  label: 'Project Settings',   Icon: SlidersHorizontal, path: '/settings', match: (p, b) => p.startsWith(`${b}/settings`), adminOnly: true },
];

export const ProjectTabBar: React.FC<{ projectId: string; isAdmin: boolean }> = ({ projectId, isAdmin }) => {
  const location = useLocation();
  const navigate = useNavigate();
  const base = `/project/${projectId}`;

  return (
    <nav aria-label="Project sections" className="flex gap-1 overflow-x-auto no-scrollbar px-1 -mx-1">
      {PROJECT_SECTIONS.filter(s => !s.adminOnly || isAdmin).map(s => {
        const active = s.match(location.pathname, base);
        return (
          <button
            key={s.id}
            onClick={() => navigate(`${base}${s.path}`, { state: { stay: true } })}
            className={`flex items-center gap-1.5 shrink-0 px-3 py-1.5 rounded-lg text-sm font-medium transition-colors ${
              active ? 'glow-accent text-white active:brightness-95' : 'text-ink-soft hover:bg-hover hover:text-ink'
            }`}
          >
            <s.Icon size={15} className="shrink-0" />
            <span>{s.label}</span>
          </button>
        );
      })}
    </nav>
  );
};
