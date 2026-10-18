// src/context/NotificationsContext.tsx — the signed-in user's notifications
// for the bell (ONLYOFFICE Phase 5), shared by the sidebar bell and the phone
// top bar's unread dot.
//
// Loaded once the realtime socket exists (it only does while signed in) and
// again on every reconnect, so nothing missed while offline stays missed. New
// ones and "read" changes arrive on the socket's `notification` event, which
// also keeps the user's other tabs and devices in step.
//
// Phone push (public/sw.js): tapping a notification with the app already open
// brings it here to follow the link; opening the app fresh carries
// ?fromNotification=<id>. Either way that one is marked read. The unread count
// also goes on the installed app's icon.
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useCollaboration } from './CollaborationContext';
import { setAppBadge } from '../utils/push';
import {
  getNotifications, markAllNotificationsRead, markNotificationRead,
  type AppNotification, type NotificationEvent,
} from '../utils/store';

interface NotificationsValue {
  items: AppNotification[];
  unread: number;
  loaded: boolean;
  markRead: (id: string) => void;
  markAllRead: () => void;
  refresh: () => void;
}

const NotificationsContext = createContext<NotificationsValue | null>(null);

const countUnread = (items: AppNotification[]) => items.filter(n => !n.readAt).length;

export const NotificationsProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { socket } = useCollaboration();
  const [items, setItems] = useState<AppNotification[]>([]);
  // The server's count: the list holds only the newest few.
  const [unread, setUnread] = useState(0);
  const [loaded, setLoaded] = useState(false);
  // The latest list, for counting what a change affects (state updaters must
  // stay pure: React may run them twice).
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const navigate = useNavigate();
  const location = useLocation();

  // A load that set out before a live event may answer without it, and
  // answers can arrive out of order: only the newest load counts, and one
  // overtaken by an event loads again rather than undo it.
  const lastLoad = useRef(0);
  const eventsSeen = useRef(0);
  const refresh = useCallback(function load() {
    const thisLoad = ++lastLoad.current;
    const eventsBefore = eventsSeen.current;
    getNotifications()
      .then(r => {
        if (thisLoad !== lastLoad.current) return;
        if (eventsSeen.current !== eventsBefore) { load(); return; }
        setItems(r.items); setUnread(r.unread); setLoaded(true);
      })
      .catch(() => { /* the bell just stays as it was */ });
  }, []);

  useEffect(() => {
    if (!socket) { setItems([]); setUnread(0); setLoaded(false); return; }
    refresh();
    const onEvent = (ev: NotificationEvent) => {
      eventsSeen.current += 1;
      if (ev.kind === 'new') {
        if (itemsRef.current.some(n => n.id === ev.notification.id)) return;
        setItems(prev => (prev.some(n => n.id === ev.notification.id) ? prev : [ev.notification, ...prev]));
        setUnread(u => u + 1);
      } else if (ev.ids === 'all') {
        const now = Date.now();
        setItems(prev => prev.map(n => (n.readAt ? n : { ...n, readAt: now })));
        setUnread(0);
      } else {
        const ids = new Set(ev.ids);
        const now = Date.now();
        const hit = itemsRef.current.filter(n => ids.has(n.id) && !n.readAt).length;
        if (hit) setUnread(u => Math.max(0, u - hit));
        setItems(prev => prev.map(n => (ids.has(n.id) && !n.readAt ? { ...n, readAt: now } : n)));
      }
    };
    socket.on('notification', onEvent);
    socket.on('connect', refresh);
    return () => {
      socket.off('notification', onEvent);
      socket.off('connect', refresh);
    };
  }, [socket, refresh]);

  const markRead = useCallback((id: string) => {
    const target = itemsRef.current.find(n => n.id === id);
    if (!target || target.readAt) return;
    const now = Date.now();
    setItems(prev => prev.map(n => (n.id === id && !n.readAt ? { ...n, readAt: now } : n)));
    setUnread(u => Math.max(0, u - 1));
    // The socket echo of this is a no-op here (already read).
    markNotificationRead(id).catch(refresh);
  }, [refresh]);

  // A tapped phone notification, by id: marked read even if it isn't in the
  // list loaded here (yet).
  const markReadById = useCallback((id: string) => {
    if (itemsRef.current.some(n => n.id === id && !n.readAt)) { markRead(id); return; }
    markNotificationRead(id).then(refresh, () => {});
  }, [markRead, refresh]);

  // Tapped with the app already open (public/sw.js posts it here).
  useEffect(() => {
    const sw = typeof navigator !== 'undefined' ? navigator.serviceWorker : undefined;
    if (!sw || !socket) return;
    const onMessage = (e: MessageEvent) => {
      const data = e.data as { type?: string; link?: unknown; id?: unknown } | null;
      if (data?.type !== 'open-notification') return;
      if (typeof data.id === 'string') markReadById(data.id);
      if (typeof data.link === 'string' && data.link.startsWith('/')) navigate(data.link);
    };
    sw.addEventListener('message', onMessage);
    return () => sw.removeEventListener('message', onMessage);
  }, [socket, navigate, markReadById]);

  // Tapped with the app closed: it opened on the link with ?fromNotification=.
  const fromNotification = new URLSearchParams(location.search).get('fromNotification');
  useEffect(() => {
    if (!fromNotification || !socket) return;
    markReadById(fromNotification);
    const params = new URLSearchParams(location.search);
    params.delete('fromNotification');
    const search = params.toString();
    navigate({ pathname: location.pathname, search: search ? `?${search}` : '' }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fromNotification, socket]);

  const markAllRead = useCallback(() => {
    const now = Date.now();
    setItems(prev => prev.map(n => (n.readAt ? n : { ...n, readAt: now })));
    setUnread(0);
    markAllNotificationsRead().catch(refresh);
  }, [refresh]);

  const shownUnread = Math.max(unread, countUnread(items));
  useEffect(() => {
    if (loaded) setAppBadge(shownUnread);
    else if (!socket) setAppBadge(0);
  }, [shownUnread, loaded, socket]);

  const value = useMemo(
    () => ({ items, unread: shownUnread, loaded, markRead, markAllRead, refresh }),
    [items, shownUnread, loaded, markRead, markAllRead, refresh],
  );
  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
};

/** The bell's state. Outside the provider (tests, bare pages) it's empty. */
export function useNotifications(): NotificationsValue {
  return useContext(NotificationsContext) ?? EMPTY;
}

const EMPTY: NotificationsValue = {
  items: [], unread: 0, loaded: false, markRead: () => {}, markAllRead: () => {}, refresh: () => {},
};
