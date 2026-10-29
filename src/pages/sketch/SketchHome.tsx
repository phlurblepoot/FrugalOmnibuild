// src/pages/sketch/SketchHome.tsx
// /tools/sketch with no file: every sketch you can see, newest first, and a
// New sketch button. ?new=1 (from Documents > New > Sketch) opens the New
// sketch dialog, with ?projectId= preselecting its project.
import React, { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { PencilRuler, Plus } from 'lucide-react';
import { Button, EmptyState, Skeleton } from '../../components/ui';
import { getDocuments, type DocumentRow } from '../../utils/store';
import { NewSketchModal } from './NewSketchModal';
import { sketchTitle } from './sketchNames';

export const SketchHome: React.FC = () => {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [rows, setRows] = useState<DocumentRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const newOpen = params.get('new') === '1';

  useEffect(() => {
    getDocuments({ kinds: ['sketch'], limit: 200 })
      .then(r => setRows([...r.rows].sort((a, b) => b.createdAt - a.createdAt)))
      .catch(e => setError(e instanceof Error ? e.message : 'Could not load sketches'));
  }, []);

  const closeNew = () => {
    const next = new URLSearchParams(params);
    next.delete('new');
    next.delete('projectId');
    setParams(next, { replace: true });
  };

  return (
    <div className="mx-auto max-w-4xl p-4 md:p-8">
      <div className="mb-6 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <PencilRuler size={22} className="text-accent-600 dark:text-accent-400" />
          <h1 className="text-xl font-bold text-ink">Sketch</h1>
        </div>
        <Button data-testid="sketch-new" onClick={() => setParams(p => { const n = new URLSearchParams(p); n.set('new', '1'); return n; })}>
          <Plus size={15} />New sketch
        </Button>
      </div>
      <p className="mb-6 max-w-2xl text-sm text-ink-soft">
        Draw measured details, such as a cornice profile, and pull them into 3D. Sketches are saved in Documents, each save as a new version.
      </p>

      {error ? (
        <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
      ) : rows === null ? (
        <div className="space-y-2">{[0, 1, 2].map(i => <Skeleton key={i} className="h-14 w-full" />)}</div>
      ) : rows.length === 0 ? (
        <EmptyState title="No sketches yet" description="Start one with New sketch." />
      ) : (
        <ul className="divide-y divide-edge rounded-xl border border-edge bg-raised" data-testid="sketch-list">
          {rows.map(r => (
            <li key={r.id}>
              <button
                type="button"
                onClick={() => navigate(`/tools/sketch?fileId=${encodeURIComponent(r.id)}`)}
                className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-hover"
              >
                <PencilRuler size={18} className="shrink-0 text-ink-faint" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-medium text-ink">{sketchTitle(r.name)}</span>
                  <span className="block truncate text-xs text-ink-faint">
                    {r.projectName ?? 'No project'} · {new Date(r.createdAt).toLocaleDateString()}
                    {r.versionNumber > 1 ? ` · version ${r.versionNumber}` : ''}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}

      <NewSketchModal
        open={newOpen}
        onClose={closeNew}
        defaultProjectId={params.get('projectId') ?? undefined}
        onCreated={fileId => navigate(`/tools/sketch?fileId=${encodeURIComponent(fileId)}`, { replace: true })}
      />
    </div>
  );
};
