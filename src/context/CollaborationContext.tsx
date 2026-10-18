import React, { createContext, useContext, useEffect, useState, useRef } from 'react';
import { io, Socket } from 'socket.io-client';
import { useLocation, useNavigate } from 'react-router-dom';
import { locationFromPath } from '../utils/locationInfo';
import { CLIENT_SESSION_ID } from '../utils/clientSession';

interface User {
  id: string;
  // The authenticated user's id from the database. Multiple sockets/sessions
  // for the same logged-in user share this. Undefined for anonymous sessions.
  userId?: string;
  name: string;
  pageId: string;
  pageName: string;
  cursor: { x: number; y: number } | null;
  color: string;
  // Server-set timestamp of the last time this socket did something (cursor
  // move, page change, etc.). Used to pick the "active" session when one user
  // has multiple tabs open.
  lastActive?: number;
}

export interface SessionView {
  sessionId: string;
  userId: string;
  name: string;
  role: string;
  color: string;
  device: string;
  location: { path: string; projectId?: string; section?: string; pageId?: string; fileId?: string; label?: string } | null;
  editing: { type: string; id: string } | null;
  cursor: { x: number; y: number } | null;
  lastActive: number;
}

interface CollaborationContextType {
  socket: Socket | null;
  users: User[];
  globalUsers: User[];
  sessions: SessionView[];
  mySessionId: string | null;
  followedSessionId: string | null;
  setFollowedSessionId: (id: string | null) => void;
  sendCursor: (x: number, y: number) => void;
  sendMeasurementOp: (op: { projectId: string; pageId: string; action: 'add' | 'update' | 'delete';
    measurement: Record<string, unknown> & { id: string } }) =>
    Promise<{ ok: true; version: number } | { ok: false; error: string }>;
  joinCanvas: (projectId: string, pageId: string) =>
    Promise<{ ok: true; measurements: any[]; version: number } | { ok: false; error: string }>;
  updateUser: (name: string, color: string) => void;
  setPageName: (name: string) => void;
  onMeasurementApplied: (cb: (ev: { pageId: string; action: 'add' | 'update' | 'delete';
    measurement: any; version: number; bySessionId?: string }) => void) => () => void;
}

const CollaborationContext = createContext<CollaborationContextType | undefined>(undefined);

export const CollaborationProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [sessions, setSessions] = useState<SessionView[]>([]);
  const [mySessionId, setMySessionId] = useState<string | null>(null);
  const [followedSessionId, setFollowedSessionId] = useState<string | null>(null);
  // Defaults to 'Projects' — on canvas entry this briefly flashes as the page
  // label before the location-sync effect below sets the real page name from
  // the route; cosmetic only, behavior unchanged.
  const [currentPageName, setCurrentPageName] = useState('Projects');
  // authEpoch bumps when a login happens so the connect effect re-runs
  const [authEpoch, setAuthEpoch] = useState(0);
  const measurementAppliedCallbacks = useRef<((data: any) => void)[]>([]);
  // Latest location payload, re-emitted on every (re)connect. socket.io-client
  // reuses the same socket object across auto-reconnects, so the set-location
  // effect below (keyed on socket/path/search/pageName) doesn't re-fire just
  // because the underlying transport dropped and came back — without this,
  // the new server-side session has location=null and joins no rooms, so
  // cursor/measurement relay goes silently dead until manual navigation.
  const latestLocationRef = useRef<ReturnType<typeof locationFromPath> | null>(null);

  const location = useLocation();
  const navigate = useNavigate();

  useEffect(() => {
    const onPrefsSync = () => setAuthEpoch(e => e + 1);
    window.addEventListener('app:prefs-sync', onPrefsSync);
    return () => window.removeEventListener('app:prefs-sync', onPrefsSync);
  }, []);

  useEffect(() => {
    const token = localStorage.getItem('token');
    if (!token) return; // not logged in — no socket until app:prefs-sync fires

    const storedColor = localStorage.getItem('userColor');
    const colors = ['#ef4444', '#3b82f6', '#10b981', '#f59e0b', '#8b5cf6', '#ec4899'];
    const userColor = storedColor || colors[Math.floor(Math.random() * colors.length)];
    if (!storedColor) localStorage.setItem('userColor', userColor);

    const newSocket = io({
      // function form: reconnect attempts re-read the (possibly refreshed) token
      auth: (cb) => cb({ token: localStorage.getItem('token'), color: localStorage.getItem('userColor') || userColor }),
    });
    setSocket(newSocket);

    newSocket.on('sessions-snapshot', ({ selfId, sessions }: { selfId: string; sessions: SessionView[] }) => {
      setMySessionId(selfId);
      setSessions(sessions);
    });
    newSocket.on('session-joined', (s: SessionView) => {
      setSessions(prev => [...prev.filter(p => p.sessionId !== s.sessionId), s]);
    });
    newSocket.on('session-left', ({ sessionId }: { sessionId: string }) => {
      setSessions(prev => prev.filter(p => p.sessionId !== sessionId));
    });
    newSocket.on('session-updated', (s: SessionView) => {
      setSessions(prev => prev.map(p => (p.sessionId === s.sessionId ? s : p)));
    });
    newSocket.on('user-cursor', ({ id, cursor }: { id: string; cursor: { x: number; y: number } }) => {
      const now = Date.now();
      setSessions(prev => prev.map(p => (p.sessionId === id ? { ...p, cursor, lastActive: now } : p)));
    });
    newSocket.on('measurement-applied', (data) => {
      measurementAppliedCallbacks.current.forEach(cb => cb(data));
    });
    newSocket.on('connect', () => {
      if (latestLocationRef.current) newSocket.emit('set-location', latestLocationRef.current);
    });

    const beat = setInterval(() => newSocket.emit('heartbeat'), 25_000);

    return () => {
      clearInterval(beat);
      newSocket.close();
      setSocket(null);
      setSessions([]);
      setMySessionId(null);
    };
  }, [authEpoch]);

  // Report structured location on every route change (and page-label change).
  // Label is only meaningful on canvas routes — off-canvas it would carry a
  // stale page name from whatever canvas page was last visited.
  useEffect(() => {
    if (!socket) return;
    const isCanvas = location.pathname.includes('/page/');
    const payload = locationFromPath(location.pathname, location.search, isCanvas ? currentPageName : undefined);
    latestLocationRef.current = payload;
    socket.emit('set-location', payload);
  }, [socket, location.pathname, location.search, currentPageName]);

  // Reset page label off-canvas
  useEffect(() => {
    if (location.pathname === '/') setCurrentPageName('Projects');
  }, [location.pathname]);

  // Legacy derived shapes — keeps CanvasView/PdfCanvas/SidebarPresence untouched in WS1
  const globalUsers: User[] = sessions.map(s => ({
    id: s.sessionId, userId: s.userId, name: s.name,
    pageId: s.location?.path ?? '', pageName: s.location?.label ?? '',
    cursor: s.cursor, color: s.color, lastActive: s.lastActive,
  }));
  const users: User[] = globalUsers.filter(u => u.pageId === location.pathname);

  // Follow: navigate to wherever the followed session goes; clear when it
  // vanishes or when the user manually navigates away. Merged into one
  // effect (was two, one keyed on [followedUserId, sessions, pathname,
  // navigate] for auto-nav and one keyed on [pathname] alone for the
  // manual-nav check) so the manual check always runs — deterministically,
  // before any auto-nav in the same commit can overwrite the ref — instead
  // of racing effect declaration order: a batched session-update (new
  // followed path) landing in the same commit as a pathname change used to
  // let the auto-nav effect re-arm followNavRef and fire an errant
  // navigate() before the manual-nav effect's check ran, since both effects
  // shared that commit but only the auto-nav one was declared first.
  const followNavRef = useRef<string | null>(null);
  // Tracks the followedSessionId as of the last run so a fresh follow
  // (null->id, or switching directly from one followed session to another)
  // can seed followNavRef with the current pathname as a baseline — without
  // this, the manual-nav check below would immediately misfire on the very
  // first run (nothing has auto-navigated yet, so the ref wouldn't match
  // the followed path OR the current pathname).
  const prevFollowedSessionIdRef = useRef<string | null>(null);
  // Tracks location.pathname as of the last run. react-router defers a
  // navigate()'s actual location update via React.startTransition, so there's
  // a window — sometimes spanning several renders triggered by unrelated
  // `sessions` updates (e.g. a presence heartbeat) — where followNavRef
  // already points at our own pending auto-nav target but location.pathname
  // hasn't caught up yet. Gating the manual-nav check on "did the pathname
  // itself actually change since we last checked" (mirroring the pre-merge
  // effect's pathname-only dependency array) is what keeps that window from
  // being misread as the user having navigated away.
  const prevPathnameRef = useRef(location.pathname);
  useEffect(() => {
    if (!followedSessionId) {
      followNavRef.current = null;
      prevFollowedSessionIdRef.current = null;
      prevPathnameRef.current = location.pathname;
      return;
    }
    const isNewFollow = prevFollowedSessionIdRef.current !== followedSessionId;
    if (isNewFollow) {
      prevFollowedSessionIdRef.current = followedSessionId;
      followNavRef.current = location.pathname;
    }
    const followed = sessions.find(s => s.sessionId === followedSessionId);
    if (!followed) {
      setFollowedSessionId(null);
      followNavRef.current = null;
      prevPathnameRef.current = location.pathname;
      return;
    }
    const followedPath = followed.location?.path;
    const pathnameChanged = prevPathnameRef.current !== location.pathname;
    prevPathnameRef.current = location.pathname;

    // Manual-nav check first: only meaningful on a run where the URL itself
    // just moved (see prevPathnameRef comment above) and never on the same
    // run that just started following. If the URL moved somewhere that is
    // neither the followed session's path nor our own last auto-nav target,
    // the user navigated manually — stop following.
    if (!isNewFollow && pathnameChanged &&
        location.pathname !== followedPath && location.pathname !== followNavRef.current) {
      setFollowedSessionId(null);
      followNavRef.current = null;
      return;
    }

    // Auto-nav: the followed session moved to a new path — follow it there.
    if (followedPath && followedPath !== location.pathname) {
      followNavRef.current = followedPath;
      navigate(followedPath);
    }
  }, [followedSessionId, sessions, location.pathname, navigate]);

  const sendCursor = (x: number, y: number) => { socket?.emit('cursor-move', { x, y }); };
  const sendMeasurementOp = (op: { projectId: string; pageId: string; action: 'add' | 'update' | 'delete';
    measurement: Record<string, unknown> & { id: string } }): Promise<{ ok: true; version: number } | { ok: false; error: string }> => {
    if (!socket || !socket.connected) return Promise.resolve({ ok: false, error: 'offline' });
    return new Promise((resolve) => {
      socket.emit('measurement-op', { ...op, clientTabId: CLIENT_SESSION_ID }, (res: { ok: true; version: number } | { ok: false; error: string }) => resolve(res));
    });
  };
  const joinCanvas = (projectId: string, pageId: string): Promise<{ ok: true; measurements: any[]; version: number } | { ok: false; error: string }> => {
    if (!socket || !socket.connected) return Promise.resolve({ ok: false, error: 'offline' });
    return new Promise((resolve) => {
      socket.emit('canvas-join', { projectId, pageId }, (res: { ok: true; measurements: any[]; version: number } | { ok: false; error: string }) => resolve(res));
    });
  };
  const updateUser = (name: string, color: string) => {
    localStorage.setItem('userColor', color);
    socket?.emit('update-user', { name, color });
  };
  const onMeasurementApplied = (callback: (data: any) => void) => {
    measurementAppliedCallbacks.current.push(callback);
    return () => { measurementAppliedCallbacks.current = measurementAppliedCallbacks.current.filter(cb => cb !== callback); };
  };
  return (
    <CollaborationContext.Provider value={{
      socket, users, globalUsers, sessions, mySessionId,
      followedSessionId, setFollowedSessionId,
      sendCursor, sendMeasurementOp, joinCanvas, updateUser,
      setPageName: setCurrentPageName, onMeasurementApplied,
    }}>
      {children}
    </CollaborationContext.Provider>
  );
};

export const useCollaboration = () => {
  const context = useContext(CollaborationContext);
  if (!context) {
    throw new Error('useCollaboration must be used within a CollaborationProvider');
  }
  return context;
};
