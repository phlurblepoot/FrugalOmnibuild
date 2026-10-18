// src/pages/customers/CustomerProjectsTab.tsx
// Grouped Bidding / In progress rows + a collapsed Archived group. Row style
// mirrors src/pages/ProjectsPage.tsx's ProjectRow.
import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, Clock, FolderKanban } from 'lucide-react';
import { CustomerOverviewProject } from '../../utils/store';
import { Card, EmptyState, LostBadge, ProjectStatusPill } from '../../components/ui';

const fmtDate = (v: number | string | null): string | null => {
  if (v == null) return null;
  const d = new Date(v);
  return isNaN(d.getTime()) ? null : d.toLocaleDateString();
};

const ProjectRow: React.FC<{ p: CustomerOverviewProject; showStatus?: boolean }> = ({ p, showStatus }) => {
  const updated = fmtDate(p.updatedAt);
  return (
    <Link
      to={`/project/${p.id}/takeoff`}
      data-testid="customer-project-row"
      data-project-id={p.id}
      className="flex items-center gap-3 border-b border-edge px-3 py-3 transition-colors last:border-b-0 hover:bg-hover"
    >
      <FolderKanban size={14} className="shrink-0 text-ink-faint" />
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-semibold text-ink" title={p.name}>{p.name}</p>
        {updated && (
          <p className="mt-0.5 flex items-center gap-1 text-xs text-ink-faint">
            <Clock size={11} />Updated {updated}
          </p>
        )}
      </div>
      {showStatus && (
        p.lostBid ? <LostBadge className="shrink-0" /> : <ProjectStatusPill status={p.status} className="shrink-0" />
      )}
    </Link>
  );
};

const GroupHeading: React.FC<{ label: string; count: number }> = ({ label, count }) => (
  <h2 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-faint">
    {label}
    <span className="rounded-full bg-sunken px-1.5 py-0.5 text-[11px] font-semibold text-ink-faint">{count}</span>
  </h2>
);

export const CustomerProjectsTab: React.FC<{ projects: CustomerOverviewProject[] }> = ({ projects }) => {
  const [archiveOpen, setArchiveOpen] = useState(false);

  if (projects.length === 0) {
    return (
      <EmptyState
        icon={<FolderKanban size={22} />}
        title="No projects yet"
        description="Projects assigned to this customer will show up here."
      />
    );
  }

  const bidding = projects.filter(p => !p.archived && p.status === 'bidding');
  const inProgress = projects.filter(p => !p.archived && p.status === 'in_progress');
  const archived = projects.filter(p => p.archived);

  return (
    <div className="space-y-5">
      {bidding.length > 0 && (
        <section>
          <GroupHeading label="Bidding" count={bidding.length} />
          <Card className="overflow-hidden">
            {bidding.map(p => <ProjectRow key={p.id} p={p} />)}
          </Card>
        </section>
      )}

      {inProgress.length > 0 && (
        <section>
          <GroupHeading label="In progress" count={inProgress.length} />
          <Card className="overflow-hidden">
            {inProgress.map(p => <ProjectRow key={p.id} p={p} />)}
          </Card>
        </section>
      )}

      {archived.length > 0 && (
        <section>
          <button
            data-testid="customer-projects-archive-toggle"
            onClick={() => setArchiveOpen(o => !o)}
            className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-ink-faint transition-colors hover:text-ink-soft"
          >
            {archiveOpen ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
            Archived
            <span className="rounded-full bg-sunken px-1.5 py-0.5 text-[11px] font-semibold text-ink-faint">{archived.length}</span>
          </button>
          {archiveOpen && (
            <Card className="overflow-hidden">
              {archived.map(p => <ProjectRow key={p.id} p={p} showStatus />)}
            </Card>
          )}
        </section>
      )}
    </div>
  );
};
