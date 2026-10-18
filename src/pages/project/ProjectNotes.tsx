// src/pages/project/ProjectNotes.tsx
import React, { useRef, useState } from 'react';
import { useParams } from 'react-router-dom';
import { NotesBoard } from '../../components/NotesBoard';
import { getProjectNotes, saveProjectNotes } from '../../utils/store';
import { ProjectNote } from '../../types';
import { useToast } from '../../components/Toast';
import { Skeleton } from '../../components/ui';
import { useLiveQuery } from '../../hooks/useLiveQuery';
import { useCollabEditing } from '../../hooks/useCollabEditing';
import { EditPresenceBanner } from '../../components/EditPresenceBanner';

// Full-page notes section. The same NotesBoard still powers the canvas
// overlay (NotesOverlay) — this page just gives it a permanent home.
export const ProjectNotes: React.FC = () => {
  const { projectId } = useParams<{ projectId: string }>();
  const { toast } = useToast();
  const [note, setNote] = useState<ProjectNote | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Which project's initial load has already landed. A background refresh
  // (foreign note event) for the SAME project updates `note` in place
  // without flipping `loaded` back to false — NotesBoard saves on ~14
  // interactions including pan/zoom, and unmounting it to a skeleton on
  // every refresh would throw away the user's current viewport mid-session.
  const loadedForProjectRef = useRef<string | null>(null);

  const load = () => {
    if (!projectId) return;
    if (loadedForProjectRef.current !== projectId) setLoaded(false);
    getProjectNotes(projectId)
      .then(setNote)
      .catch(() => {})
      .finally(() => {
        loadedForProjectRef.current = projectId;
        setLoaded(true);
      });
  };
  useLiveQuery(load, { types: ['note'], projectId });

  // Presence only — useLiveQuery above already reloads on foreign 'note'
  // events, so onFresh must be a no-op here or every event double-loads
  // (useLiveQuery's debounced load + this undebounced one racing each other).
  const collab = useCollabEditing({
    type: 'note',
    id: projectId ?? '',
    isDirty: () => false,
    onFresh: () => {},
  });

  const handleSave = async (n: ProjectNote) => {
    if (!projectId) return;
    try {
      await saveProjectNotes(projectId, n);
      setNote(n);
    } catch {
      toast('Failed to save notes', { type: 'error' });
    }
  };

  if (!projectId) return null;
  return (
    <div className="flex h-screen flex-col">
      {!loaded ? (
        <div className="p-6"><Skeleton className="h-64" /></div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {collab.othersEditing.length > 0 && (
            <div className="px-4 pt-3"><EditPresenceBanner state={collab} /></div>
          )}
          <div className="min-h-0 flex-1">
            <NotesBoard projectId={projectId} initialNote={note} onSave={handleSave} />
          </div>
        </div>
      )}
    </div>
  );
};
