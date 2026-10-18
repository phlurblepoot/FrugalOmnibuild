// src/hooks/useFavoriteProjects.ts
import { useCallback, useEffect, useState } from 'react';
import {
  getFavoriteProjects, peekFavoriteProjects, subscribeFavoriteProjects, toggleFavoriteProject,
} from '../utils/store';

// The signed-in user's favorite project ids, shared across every star on
// screen. `toggle` is optimistic; a failed save rolls back and rejects.
export function useFavoriteProjects() {
  const [ids, setIds] = useState<string[]>(() => peekFavoriteProjects() ?? []);
  useEffect(() => {
    let live = true;
    const sync = () => { const v = peekFavoriteProjects(); if (live && v) setIds(v); };
    const unsub = subscribeFavoriteProjects(sync);
    getFavoriteProjects().then(sync).catch(() => {});
    return () => { live = false; unsub(); };
  }, []);
  const toggle = useCallback((projectId: string) => toggleFavoriteProject(projectId), []);
  return { favorites: ids, isFavorite: (id: string) => ids.includes(id), toggle };
}
