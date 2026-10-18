// Authenticated realtime core. Replaces the old inline socket block in
// server.ts. Identity comes ONLY from the verified JWT — never from
// client-supplied fields (the old code trusted a client-asserted userId).
import type { Server, Socket } from 'socket.io';
import type Database from 'better-sqlite3';
import { PresenceRegistry } from './presenceRegistry';
import { deviceLabel } from './deviceLabel';
import type { SessionInfo } from './types';
import { applyMeasurementOp, OpRejectedError, hydrateMeasurementRow, type MeasurementOpAction } from './measurementOps';
import type { BroadcastChange } from './changeFeed';

export interface RealtimeOptions {
  verifyToken: (token: string) => { id: string; username: string; role: string } | null;
  sweepIntervalMs?: number;
  staleAfterMs?: number;
  db?: Database.Database;
  broadcastChange?: BroadcastChange;
}

export interface RealtimeHandle {
  registry: PresenceRegistry;
  dispose: () => void;
}

const DEFAULT_COLOR = '#3b82f6';

// Public projection of a session (all of SessionInfo is safe to share today,
// but keep the seam so private fields can be added later).
function publicSession(s: SessionInfo): SessionInfo {
  return { ...s };
}

export const projectRoom = (id: string) => `project:${id}`;
export const pageRoom = (id: string) => `page:${id}`;
export const pathRoom = (path: string) => `path:${path}`;
/** Every socket of one signed-in user: where their notifications go. */
export const userRoom = (userId: string) => `user:${userId}`;
/** The socket event carrying a NotificationEvent (server/notifications.ts). */
export const NOTIFICATION_EVENT = 'notification';

function roomsForLocation(loc: { path: string; projectId?: string; pageId?: string }): string[] {
  const rooms = [pathRoom(loc.path)];
  if (loc.projectId) rooms.push(projectRoom(loc.projectId));
  if (loc.pageId) rooms.push(pageRoom(loc.pageId));
  return rooms;
}

export function registerRealtime(io: Server, opts: RealtimeOptions): RealtimeHandle {
  const registry = new PresenceRegistry();

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    const payload = typeof token === 'string' && token ? opts.verifyToken(token) : null;
    if (!payload) return next(new Error('unauthorized'));
    socket.data.user = { id: String(payload.id), name: String(payload.username), role: String(payload.role) };
    next();
  });

  io.on('connection', (socket: Socket) => {
    // socket.id doubles as the sessionId: it's server-generated and unique per
    // connection (our model is one connection = one session), and legacy
    // client consumers self-identify by comparing against socket.id.
    const sessionId = socket.id;
    socket.data.sessionId = sessionId;
    const auth = socket.handshake.auth ?? {};
    const session: SessionInfo = {
      sessionId,
      userId: socket.data.user.id,
      name: socket.data.user.name,
      role: socket.data.user.role,
      color: typeof auth.color === 'string' ? auth.color : DEFAULT_COLOR,
      device: deviceLabel(socket.handshake.headers['user-agent']),
      location: null,
      editing: null,
      cursor: null,
      lastActive: Date.now(),
    };
    registry.add(session);
    socket.join(userRoom(socket.data.user.id));

    // Engine-level packets (incl. ping/pong) are sent from message handlers,
    // which browsers do NOT throttle in hidden tabs — unlike the client's
    // 25s heartbeat timer. Touching here makes the sweep a true last resort
    // for zombie connections instead of a killer of backgrounded tabs.
    socket.conn.on('packet', () => registry.touch(sessionId));

    socket.emit('sessions-snapshot', {
      selfId: sessionId,
      sessions: registry.all().map(publicSession),
    });
    socket.broadcast.emit('session-joined', publicSession(session));

    socket.on('set-location', (loc: unknown) => {
      if (!loc || typeof loc !== 'object' || typeof (loc as any).path !== 'string') return;
      const l = loc as { path: string; projectId?: string; section?: string; pageId?: string; fileId?: string; label?: string };
      const prev = registry.get(sessionId)?.location;
      if (prev) for (const room of roomsForLocation(prev)) socket.leave(room);
      const next = {
        path: l.path,
        projectId: typeof l.projectId === 'string' ? l.projectId : undefined,
        section: typeof l.section === 'string' ? l.section : undefined,
        pageId: typeof l.pageId === 'string' ? l.pageId : undefined,
        fileId: typeof l.fileId === 'string' ? l.fileId : undefined,
        label: typeof l.label === 'string' ? l.label : undefined,
      };
      for (const room of roomsForLocation(next)) socket.join(room);
      registry.setLocation(sessionId, next);
      const s = registry.get(sessionId);
      if (s) io.emit('session-updated', publicSession(s));
    });

    socket.on('update-user', (patch: unknown) => {
      if (!patch || typeof patch !== 'object') return;
      const p = patch as { name?: unknown; color?: unknown };
      const allowed: { name?: string; color?: string } = {};
      if (typeof p.name === 'string' && p.name) allowed.name = p.name;
      if (typeof p.color === 'string' && p.color) allowed.color = p.color;
      registry.update(sessionId, allowed);
      const s = registry.get(sessionId);
      if (s) io.emit('session-updated', publicSession(s));
    });

    socket.on('set-editing', (payload: unknown) => {
      let editing: { type: string; id: string } | null = null;
      if (payload && typeof payload === 'object') {
        const p = payload as { type?: unknown; id?: unknown };
        if (typeof p.type === 'string' && p.type && typeof p.id === 'string' && p.id) {
          editing = { type: p.type, id: p.id };
        } else return; // malformed object — ignore
      } else if (payload !== null) return; // only null or {type,id}
      registry.update(sessionId, { editing });
      const s = registry.get(sessionId);
      if (s) io.emit('session-updated', publicSession(s));
    });

    socket.on('heartbeat', () => registry.touch(sessionId));

    // permanent: canvas cursor relay
    socket.on('cursor-move', (pos: unknown) => {
      if (!pos || typeof pos !== 'object') return;
      const { x, y } = pos as { x?: unknown; y?: unknown };
      if (typeof x !== 'number' || typeof y !== 'number') return;
      registry.update(sessionId, { cursor: { x, y } });
      const s = registry.get(sessionId);
      if (s?.location) {
        socket.to(pathRoom(s.location.path)).emit('user-cursor', { id: sessionId, cursor: { x, y } });
      }
    });

    // Canvas measurement mutation: authoritative write path (WS4). Membership
    // is project-scoped, not page-scoped — a project member may legally op on
    // any page in that project (e.g. paste-across-pages), so the check is
    // "somewhere in the project", not "on this exact page".
    //
    // Full ack error enum for measurement-op / canvas-join:
    //   not_in_project    — sender's socket isn't in this project's room
    //   page_not_found    — pageId doesn't exist under projectId
    //   page_superseded   — target page is a frozen older plan-set revision
    //   invalid_measurement — applyMeasurementOp rejected the measurement's
    //                         own shape/id (bad type/points, cross-page id
    //                         collision) — thrown from inside applyMeasurementOp
    //   invalid_request   — the envelope itself is malformed (missing/wrong-typed
    //                       pageId/projectId/action, or payload isn't an object)
    //   no_db             — server has no database wired (should not happen in prod)
    //   internal          — an unexpected (non-OpRejectedError) exception was
    //                       caught; logged server-side, never rethrown, so a
    //                       transient DB error can't crash the whole process
    socket.on('measurement-op', (payload: unknown, ack?: (res: unknown) => void) => {
      const respond = typeof ack === 'function' ? ack : () => {};
      if (!payload || typeof payload !== 'object') return respond({ ok: false, error: 'invalid_request' });
      const { pageId, projectId, action, measurement, clientTabId } = payload as {
        pageId?: unknown; projectId?: unknown; action?: unknown; measurement?: unknown; clientTabId?: unknown;
      };
      if (
        typeof pageId !== 'string' || !pageId ||
        typeof projectId !== 'string' || !projectId ||
        (action !== 'add' && action !== 'update' && action !== 'delete') ||
        !measurement || typeof measurement !== 'object'
      ) {
        return respond({ ok: false, error: 'invalid_request' });
      }
      if (!socket.rooms.has(projectRoom(projectId))) return respond({ ok: false, error: 'not_in_project' });
      if (!opts.db) return respond({ ok: false, error: 'no_db' });

      const bySessionId = typeof clientTabId === 'string' ? clientTabId : undefined;
      try {
        const { version } = applyMeasurementOp(opts.db, {
          projectId,
          pageId,
          action: action as MeasurementOpAction,
          measurement: measurement as Record<string, unknown> & { id: string },
        });
        respond({ ok: true, version });
        socket.to(projectRoom(projectId)).emit('measurement-applied', {
          pageId, action, measurement, version, bySessionId,
        });
        opts.broadcastChange?.({
          type: 'project',
          id: projectId,
          projectId,
          version,
          action: 'updated',
          byUserId: socket.data.user.id,
          bySessionId,
        });
      } catch (err) {
        if (err instanceof OpRejectedError) return respond({ ok: false, error: err.reason });
        // I1 fix: this handler runs inside a socket event listener, so an
        // uncaught exception here is NOT scoped to the request — it escapes
        // as an uncaught exception on the process and kills the whole
        // (single-process) server. A transient DB error must degrade to a
        // failed ack, never a crash.
        console.error('measurement-op failed', err);
        return respond({ ok: false, error: 'internal' });
      }
    });

    // Canvas join: hydrates a page's current measurements + the project's
    // version for a client opening/reconnecting to the canvas, so it doesn't
    // need a separate REST round-trip to catch up before accepting local ops.
    socket.on('canvas-join', (payload: unknown, ack?: (res: unknown) => void) => {
      const respond = typeof ack === 'function' ? ack : () => {};
      if (!payload || typeof payload !== 'object') return respond({ ok: false, error: 'invalid_request' });
      const { pageId, projectId } = payload as { pageId?: unknown; projectId?: unknown };
      if (typeof pageId !== 'string' || !pageId || typeof projectId !== 'string' || !projectId) {
        return respond({ ok: false, error: 'invalid_request' });
      }
      if (!socket.rooms.has(projectRoom(projectId))) return respond({ ok: false, error: 'not_in_project' });
      if (!opts.db) return respond({ ok: false, error: 'no_db' });

      // I1 fix: same catch-all as measurement-op — an unexpected DB error
      // here must not escape this listener uncaught and crash the process.
      try {
        const page = opts.db.prepare('SELECT id FROM pages WHERE id = ? AND projectId = ?').get(pageId, projectId);
        if (!page) return respond({ ok: false, error: 'page_not_found' });

        const rows = opts.db
          .prepare('SELECT id, takeoffId, type, name, color, points, attrs FROM measurements WHERE pageId = ? ORDER BY sortOrder')
          .all(pageId) as Parameters<typeof hydrateMeasurementRow>[0][];
        const measurements = rows.map(hydrateMeasurementRow);
        const project = opts.db.prepare('SELECT version FROM projects WHERE id = ?').get(projectId) as
          | { version: number }
          | undefined;
        respond({ ok: true, measurements, version: project?.version ?? 0 });
      } catch (err) {
        console.error('canvas-join failed', err);
        respond({ ok: false, error: 'internal' });
      }
    });

    socket.on('disconnect', () => {
      const removed = registry.remove(sessionId);
      if (removed) io.emit('session-left', { sessionId });
    });
  });

  const sweepIntervalMs = opts.sweepIntervalMs ?? 30_000;
  const staleAfterMs = opts.staleAfterMs ?? 60_000;
  const sweepTimer = setInterval(() => {
    const swept = registry.sweep(staleAfterMs);
    for (const s of swept) {
      io.emit('session-left', { sessionId: s.sessionId });
      for (const [, sock] of io.of('/').sockets) {
        if (sock.data.sessionId === s.sessionId) { sock.disconnect(true); break; }
      }
    }
  }, sweepIntervalMs);
  // unref() so a leaked handle can never keep the process (or vitest) alive
  sweepTimer.unref?.();

  return { registry, dispose: () => clearInterval(sweepTimer) };
}
