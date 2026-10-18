// src/pages/project/ProjectLayout.tsx
import React, { useRef, useState } from 'react';
import { Outlet, useOutletContext, useParams, useLocation, matchPath } from 'react-router-dom';
import { ProjectSummary, getProjectSummary } from '../../utils/store';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import { ProjectTabBar } from './ProjectTabBar';
import { FavoriteStar } from '../../components/FavoriteStar';

export interface ProjectOutletCtx {
  summary: ProjectSummary | null;
  refreshSummary: () => void;
}

// Convenience for section pages.
export const useProjectOutlet = () => useOutletContext<ProjectOutletCtx>();

// Thin frame for all project sections: renders the sticky header + tab bar
// (hidden on canvas routes) and shares a lightweight summary via outlet
// context. Sections that need full project data (ProjectView, CanvasView)
// keep loading it themselves.
export const ProjectLayout: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const [summary, setSummary] = useState<ProjectSummary | null>(null);

  // Manual refresh (e.g. after a stage change) — refetches the current
  // project, so a late resolution can't be stale.
  const refreshSummary = () => {
    if (!projectId) return;
    getProjectSummary(projectId).then(setSummary).catch(() => {});
  };

  // useLiveQuery re-runs this on mount, whenever `projectId` changes (it's
  // part of the filter identity), and on foreign project-changed socket
  // events. Only reset `summary` to null on an actual project switch — not on
  // every live refresh of the SAME project, which would otherwise flash the
  // sidebar name on background sync. loadSeqRef guards the project-switch
  // case against an out-of-order resolution (A→B fast, A's request resolves
  // after B's).
  const lastProjectIdRef = useRef<string | undefined>(undefined);
  const loadSeqRef = useRef(0);
  const load = () => {
    const seq = ++loadSeqRef.current;
    if (projectId !== lastProjectIdRef.current) {
      lastProjectIdRef.current = projectId;
      setSummary(null);
    }
    if (!projectId) return;
    getProjectSummary(projectId).then(s => { if (loadSeqRef.current === seq) setSummary(s); }).catch(() => {});
  };
  useLiveQuery(load, { types: ['project'], projectId, id: projectId });

  const location = useLocation();
  const isCanvas = !!matchPath('/project/:projectId/page/:pageId', location.pathname);
  const user = JSON.parse(localStorage.getItem('user') || '{}');
  const isAdmin = user.role === 'admin';

  return (
    <>
      {!isCanvas && (
        <div className="glass-panel sticky top-0 z-30 border-b border-edge px-4 pt-3 pb-2 space-y-2 md:px-6">
          <div className="flex items-center gap-1">
            <p className="min-w-0 truncate text-lg font-bold tracking-tight text-ink">
              {summary?.name ?? 'Project'}
            </p>
            {projectId && <FavoriteStar projectId={projectId} size={17} />}
          </div>
          {projectId && <ProjectTabBar projectId={projectId} isAdmin={isAdmin} />}
        </div>
      )}
      {isCanvas ? (
        <Outlet context={{ summary, refreshSummary } satisfies ProjectOutletCtx} />
      ) : (
        <div key={location.pathname} className="anim-tab-in">
          <Outlet context={{ summary, refreshSummary } satisfies ProjectOutletCtx} />
        </div>
      )}
    </>
  );
};
