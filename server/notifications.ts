// server/notifications.ts — the notification bell (ONLYOFFICE Phase 5).
//
// One row per person told about something: an @mention in a document comment,
// a task or RFI assigned to them, a GC's answer to an RFI. The bell lists the
// newest, counts the unread, and gets new ones live over the socket (each
// signed-in socket sits in its user's room, server/realtime/registerRealtime).
// No email: the bell is the whole feature (decision 2026-09-25).
import crypto from 'crypto';
import type Database from 'better-sqlite3';

export const NOTIFICATION_TYPES = ['mention', 'comment-reply', 'task-assigned', 'rfi-assigned', 'rfi-answered'] as const;
export type NotificationType = typeof NOTIFICATION_TYPES[number];

export interface Notification {
  id: string;
  userId: string;
  type: NotificationType;
  title: string;
  body: string | null;
  /** An in-app path ("/tasks?open=…"), never an outside URL. */
  link: string | null;
  actorUserId: string | null;
  createdAt: number;
  readAt: number | null;
}

export interface NewNotification {
  userId: string;
  type: NotificationType;
  title: string;
  body?: string | null;
  link?: string | null;
  /** Who caused it. Nobody is notified about their own act. */
  actorUserId?: string | null;
}

/** What the socket layer does with a change: tell that user's open tabs. */
export type NotificationPush = (userId: string, event: NotificationEvent) => void;
export type NotificationEvent =
  | { kind: 'new'; notification: Notification }
  | { kind: 'read'; ids: string[] | 'all' };

/** The bell shows this many; older ones are still in the table until pruned. */
export const NOTIFICATION_LIST_LIMIT = 50;
const TITLE_MAX = 200;
const BODY_MAX = 500;
/** Read notifications older than this are pruned; unread ones after a year. */
const KEEP_READ_MS = 90 * 24 * 3600_000;
const KEEP_UNREAD_MS = 365 * 24 * 3600_000;

const clamp = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
/** Only same-app paths: a link is followed by the app's router. */
const safeLink = (link: string | null | undefined): string | null =>
  typeof link === 'string' && link.startsWith('/') && !link.startsWith('//') ? link : null;

export class Notifier {
  constructor(private readonly db: Database.Database, private push: NotificationPush = () => {}) {}

  /** Late binding: the socket server is set up after some of its users. */
  setPush(push: NotificationPush): void { this.push = push; }

  private readonly listeners: ((n: Notification) => void)[] = [];
  /** Also called with every new notification (phone push, server/push.ts). */
  onNew(listener: (n: Notification) => void): void { this.listeners.push(listener); }

  /** Records and pushes one notification. Null when there's nobody to tell
   *  (no such user, or they caused it themselves) or it couldn't be stored.
   *  Never throws: whatever triggered it has already happened. */
  notify(input: NewNotification): Notification | null {
    try { return this.record(input); } catch (e) {
      console.warn('[notifications] not stored:', e instanceof Error ? e.message : e);
      return null;
    }
  }

  private record(input: NewNotification): Notification | null {
    const userId = String(input.userId ?? '');
    if (!userId) return null;
    if (input.actorUserId != null && String(input.actorUserId) === userId) return null;
    if (!this.db.prepare('SELECT 1 FROM users WHERE id = ?').get(userId)) return null;
    const n: Notification = {
      id: crypto.randomUUID(),
      userId,
      type: input.type,
      title: clamp(input.title.trim() || 'Notification', TITLE_MAX),
      body: input.body?.trim() ? clamp(input.body.trim(), BODY_MAX) : null,
      link: safeLink(input.link),
      actorUserId: input.actorUserId != null ? String(input.actorUserId) : null,
      createdAt: Date.now(),
      readAt: null,
    };
    this.db.prepare(`INSERT INTO notifications (id, userId, type, title, body, link, actorUserId, createdAt, readAt)
                     VALUES (@id, @userId, @type, @title, @body, @link, @actorUserId, @createdAt, NULL)`).run(n);
    for (const listener of this.listeners) {
      try { listener(n); } catch (e) { console.warn('[notifications] listener failed:', e instanceof Error ? e.message : e); }
    }
    try { this.push(userId, { kind: 'new', notification: n }); } catch (e) {
      console.warn('[notifications] push failed:', e instanceof Error ? e.message : e);
    }
    return n;
  }

  /** Several people at once, each told once (e.g. an RFI's assignee and its
   *  sender are often the same person). */
  notifyEach(userIds: (string | null | undefined)[], input: Omit<NewNotification, 'userId'>): Notification[] {
    const out: Notification[] = [];
    for (const id of new Set(userIds.filter((u): u is string => !!u).map(String))) {
      const n = this.notify({ ...input, userId: id });
      if (n) out.push(n);
    }
    return out;
  }

  unreadCount(userId: string): number {
    return (this.db.prepare('SELECT COUNT(*) c FROM notifications WHERE userId = ? AND readAt IS NULL').get(String(userId)) as { c: number }).c;
  }

  list(userId: string, limit = NOTIFICATION_LIST_LIMIT): { items: Notification[]; unread: number } {
    const items = this.db.prepare('SELECT * FROM notifications WHERE userId = ? ORDER BY createdAt DESC, rowid DESC LIMIT ?')
      .all(String(userId), Math.max(1, Math.min(limit, 200))) as Notification[];
    const unread = (this.db.prepare('SELECT COUNT(*) c FROM notifications WHERE userId = ? AND readAt IS NULL')
      .get(String(userId)) as { c: number }).c;
    return { items, unread };
  }

  /** Marks one of the user's own notifications read. False when it isn't theirs. */
  markRead(userId: string, id: string): boolean {
    const r = this.db.prepare('UPDATE notifications SET readAt = ? WHERE id = ? AND userId = ? AND readAt IS NULL')
      .run(Date.now(), id, String(userId));
    const exists = r.changes > 0 || !!this.db.prepare('SELECT 1 FROM notifications WHERE id = ? AND userId = ?').get(id, String(userId));
    if (r.changes > 0) this.pushSafe(String(userId), { kind: 'read', ids: [id] });
    return exists;
  }

  markAllRead(userId: string): number {
    const r = this.db.prepare('UPDATE notifications SET readAt = ? WHERE userId = ? AND readAt IS NULL').run(Date.now(), String(userId));
    if (r.changes > 0) this.pushSafe(String(userId), { kind: 'read', ids: 'all' });
    return r.changes;
  }

  /** Clears out old ones. Returns how many went. */
  prune(now = Date.now()): number {
    return this.db.prepare(`DELETE FROM notifications
      WHERE (readAt IS NOT NULL AND createdAt < ?) OR createdAt < ?`).run(now - KEEP_READ_MS, now - KEEP_UNREAD_MS).changes;
  }

  /** A deleted user's notifications go with them. */
  removeUser(userId: string): void {
    this.db.prepare('DELETE FROM notifications WHERE userId = ?').run(String(userId));
  }

  private pushSafe(userId: string, ev: NotificationEvent): void {
    try { this.push(userId, ev); } catch { /* a push is a courtesy; the list is the truth */ }
  }
}
