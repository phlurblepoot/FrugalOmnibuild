// server/realtime/changeFeed.ts
// The app-wide change feed: after a successful REST mutation, the route layer
// calls broadcastChange with identity + version ONLY (never entity data —
// clients refetch over authed REST). Emitted globally rather than into
// project rooms: dashboards and list views render cross-project rollups and
// would miss room-scoped events (ruled deviation from spec §4, see plan).
import type { Server } from 'socket.io';

export type EntityType =
  | 'project' | 'task' | 'issue' | 'rfi' | 'dailyReport' | 'dailyReportCrew' | 'punch'
  | 'invoice' | 'changeOrder' | 'lienRelease' | 'payment' | 'aiaSov' | 'aiaPayApp'
  | 'file' | 'note' | 'customer' | 'user' | 'timeEntry' | 'template' | 'proposal'
  | 'mailThread' | 'mailAccount' | 'backupRun';

export interface EntityChangedEvent {
  type: EntityType;
  id: string;
  projectId?: string;
  version?: number;
  action: 'created' | 'updated' | 'deleted';
  byUserId?: string;
  bySessionId?: string;
}

export const ENTITY_CHANGED = 'entity-changed';

export type BroadcastChange = (ev: EntityChangedEvent) => void;

export function createChangeFeed(io: Server): BroadcastChange {
  return (ev: EntityChangedEvent) => {
    io.emit(ENTITY_CHANGED, ev);
  };
}

export function requestMeta(req: { user?: { id?: string }; get(name: string): string | undefined }):
  { byUserId?: string; bySessionId?: string } {
  return {
    byUserId: typeof req.user?.id === 'string' ? req.user.id : undefined,
    bySessionId: req.get('x-session-id') || undefined,
  };
}
