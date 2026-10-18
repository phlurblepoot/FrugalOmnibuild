import { useEffect, useRef } from 'react';
import { useToast } from './Toast';
import { getProject } from '../utils/store';

// Project version conflicts (48 saveProject call sites) once triggered a full
// page reload. With the live change feed, conflicts are rare races; recover
// in place: refetch the project, announce it, and let mounted screens re-render.
export default function ProjectConflictListener() {
  const { toast } = useToast();
  const refreshing = useRef(false);

  useEffect(() => {
    const onConflict = async (e: Event) => {
      const projectId = (e as CustomEvent).detail?.projectId as string | undefined;
      if (!projectId || refreshing.current) return;
      refreshing.current = true;
      try {
        const project = await getProject(projectId);
        window.dispatchEvent(new CustomEvent('project-refreshed', { detail: { projectId, project } }));
        toast('This project was changed elsewhere — refreshed with the latest.', { type: 'info' });
      } catch {
        // Refetch failed (offline?): fall back to the old behavior rather than leave a stale tab.
        toast('This project was changed elsewhere — reloading…', { type: 'error' });
        setTimeout(() => window.location.reload(), 2000);
      } finally {
        refreshing.current = false;
      }
    };
    window.addEventListener('project-conflict', onConflict);
    return () => window.removeEventListener('project-conflict', onConflict);
  }, [toast]);

  return null;
}
