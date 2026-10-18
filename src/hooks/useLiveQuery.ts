import { useEffect, useRef } from 'react';
import { useCollaboration } from '../context/CollaborationContext';
import { CLIENT_SESSION_ID } from '../utils/clientSession';

export type EntityType =
  | 'project' | 'task' | 'issue' | 'rfi' | 'dailyReport' | 'dailyReportCrew' | 'punch'
  | 'invoice' | 'changeOrder' | 'lienRelease' | 'payment' | 'aiaSov' | 'aiaPayApp'
  | 'file' | 'note' | 'customer' | 'user' | 'timeEntry' | 'template' | 'proposal'
  | 'mailThread' | 'mailAccount' | 'backupRun';

export interface EntityChangedEvent {
  type: EntityType; id: string; projectId?: string; version?: number;
  action: 'created' | 'updated' | 'deleted'; byUserId?: string; bySessionId?: string;
}

export interface LiveFilter { types: EntityType[]; projectId?: string; id?: string; }

export function useLiveQuery(
  load: () => void | Promise<void>,
  filter: LiveFilter,
  opts: { debounceMs?: number } = {},
): void {
  const { socket } = useCollaboration();
  const loadRef = useRef(load);
  loadRef.current = load;
  const filterKey = JSON.stringify([filter.types, filter.projectId ?? null, filter.id ?? null]);
  const debounceMs = opts.debounceMs ?? 300;

  // Initial load + reload when the filter identity changes.
  useEffect(() => { void loadRef.current(); }, [filterKey]);

  useEffect(() => {
    if (!socket) return;
    const [types, projectId, id] = JSON.parse(filterKey) as [EntityType[], string | null, string | null];
    const seenVersions = new Map<string, number>();
    let timer: ReturnType<typeof setTimeout> | null = null;

    const onEvent = (ev: EntityChangedEvent) => {
      if (ev.bySessionId === CLIENT_SESSION_ID) return;
      if (!types.includes(ev.type)) return;
      if (projectId && ev.projectId && ev.projectId !== projectId) return;
      if (id && ev.id !== id) return;
      if (typeof ev.version === 'number') {
        const key = `${ev.type}:${ev.id}`;
        const seen = seenVersions.get(key) ?? 0;
        if (ev.version <= seen) return;
        seenVersions.set(key, ev.version);
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; void loadRef.current(); }, debounceMs);
    };
    const onConnect = () => { void loadRef.current(); };

    socket.on('entity-changed', onEvent);
    socket.on('connect', onConnect);
    return () => {
      if (timer) clearTimeout(timer);
      socket.off('entity-changed', onEvent);
      socket.off('connect', onConnect);
    };
  }, [socket, filterKey, debounceMs]);
}
