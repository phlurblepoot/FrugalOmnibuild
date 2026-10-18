// src/pages/project/ProjectOverview.tsx
import React, { useEffect, useState } from 'react';
import { Navigate, useLocation, useParams, useSearchParams } from 'react-router-dom';
import { getDefaultProjectTab, peekDefaultProjectTab } from '../../utils/store';
import { PROJECT_SECTIONS } from './ProjectTabBar';
import { useProjectOutlet } from './ProjectLayout';
import { ProjectStageControl } from '../../components/ProjectStageControl';
import { Skeleton } from '../../components/ui';
import { CardGrid } from '../../cards';

// Wave 2 rehaul: this page is now a progress-story overview — a header
// (name + stage control, unchanged) followed by the project card grid
// (financial band / open items / happenings are the defaults; Details,
// Actions, Activity, and Hours return as library cards — Task 9 — that a
// user can add back via Customize). All per-card data fetching lives inside
// the cards themselves (src/cards/project/coreCards.tsx).
export const ProjectOverview: React.FC = () => {
  const [searchParams] = useSearchParams();
  const { summary, refreshSummary } = useProjectOutlet();
  const isAdmin = (JSON.parse(localStorage.getItem('user') || '{}').role) === 'admin';
  const location = useLocation();
  const { projectId } = useParams();
  // "Open projects on" (Settings): opening a project lands on that tab. The
  // Overview tab button passes state.stay so choosing Overview still works.
  const stay = !!(location.state as { stay?: boolean } | null)?.stay;
  const [defaultTab, setDefaultTab] = useState<string | null>(peekDefaultProjectTab());
  useEffect(() => {
    if (stay || defaultTab !== null) return;
    let cancelled = false;
    getDefaultProjectTab().then(t => { if (!cancelled) setDefaultTab(t); });
    return () => { cancelled = true; };
  }, [stay, defaultTab]);

  // Pre-3b bookmarks looked like /project/:id?tab=takeoffs — forward them.
  const legacyTab = searchParams.get('tab');
  if (legacyTab) return <Navigate to={`takeoff?tab=${encodeURIComponent(legacyTab)}`} replace />;

  if (!stay) {
    if (defaultTab === null) {
      return (
        <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
          <Skeleton className="h-7 w-64" />
        </div>
      );
    }
    const target = PROJECT_SECTIONS.find(sec => sec.id === defaultTab);
    if (target && target.id !== 'overview' && (!target.adminOnly || isAdmin)) {
      return <Navigate to={`/project/${projectId}${target.path}`} replace />;
    }
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8">
      {/* Header: name + stage */}
      <div className="mb-5">
        {summary ? (
          <>
            <h1 className="text-xl font-bold text-ink">{summary.name}</h1>
            <div className="mt-2">
              <ProjectStageControl
                projectId={summary.id}
                version={summary.version}
                status={summary.status}
                onChanged={() => refreshSummary()}
              />
            </div>
          </>
        ) : (
          <Skeleton className="h-7 w-64" />
        )}
      </div>

      {summary ? (
        <CardGrid page="project" ctx={{ isAdmin, projectId: summary.id }} key={summary.id} />
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {[0, 1, 2].map(i => <Skeleton key={i} className="h-40 rounded-xl" />)}
        </div>
      )}
    </div>
  );
};
