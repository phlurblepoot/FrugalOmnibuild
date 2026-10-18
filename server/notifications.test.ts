// The notification bell (ONLYOFFICE Phase 5): the store, its routes, and the
// live push into the recipient's own socket room.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import { Notifier, type NotificationEvent } from './notifications';
import { registerNotificationRoutes } from './notificationRoutes';
import { NOTIFICATION_EVENT, userRoom } from './realtime/registerRealtime';
import { connectClient, makeToken, startRealtimeServer, waitFor } from './realtime/testHarness';

let db: Database.Database;
let pushed: { userId: string; ev: NotificationEvent }[];
let notifier: Notifier;

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, fs.mkdtempSync(path.join(os.tmpdir(), 'ft-notif-')), migrations);
  for (const [id, name] of [['u1', 'noah'], ['u2', 'maria'], ['u3', 'joe']]) {
    db.prepare('INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, ?)').run(id, name, 'x', 'user');
  }
  pushed = [];
  notifier = new Notifier(db, (userId, ev) => pushed.push({ userId, ev }));
});

describe('Notifier', () => {
  it('stores a notification and pushes it to that user', () => {
    const n = notifier.notify({ userId: 'u2', type: 'task-assigned', title: 'noah assigned you a task', body: 'Hang board', link: '/tasks?open=t1', actorUserId: 'u1' });
    expect(n).toMatchObject({ userId: 'u2', type: 'task-assigned', link: '/tasks?open=t1', readAt: null, actorUserId: 'u1' });
    expect(pushed).toEqual([{ userId: 'u2', ev: { kind: 'new', notification: n } }]);
    expect(notifier.list('u2')).toEqual({ items: [n], unread: 1 });
    expect(notifier.list('u1')).toEqual({ items: [], unread: 0 });
  });

  it('tells nobody about their own act, or a user that does not exist', () => {
    expect(notifier.notify({ userId: 'u1', type: 'task-assigned', title: 't', actorUserId: 'u1' })).toBeNull();
    expect(notifier.notify({ userId: 'ghost', type: 'task-assigned', title: 't' })).toBeNull();
    expect(notifier.notify({ userId: '', type: 'task-assigned', title: 't' })).toBeNull();
    expect(pushed).toEqual([]);
  });

  it('tells each person once, and keeps links inside the app', () => {
    const sent = notifier.notifyEach(['u2', 'u2', null, 'u3', 'u1'], { type: 'rfi-answered', title: 'Reply received', link: 'https://evil.example/x', actorUserId: 'u1' });
    expect(sent.map(n => n.userId)).toEqual(['u2', 'u3']);
    expect(sent.every(n => n.link === null)).toBe(true);
    expect(notifier.notify({ userId: 'u2', type: 'mention', title: 't', link: '//evil.example' })!.link).toBeNull();
  });

  it('lists newest first, marks one or all read, and only your own', () => {
    const a = notifier.notify({ userId: 'u2', type: 'mention', title: 'first' })!;
    const b = notifier.notify({ userId: 'u2', type: 'mention', title: 'second' })!;
    const other = notifier.notify({ userId: 'u3', type: 'mention', title: 'not yours' })!;
    expect(notifier.list('u2').items.map(n => n.title)).toEqual(['second', 'first']);

    expect(notifier.markRead('u2', other.id)).toBe(false);
    expect(notifier.markRead('u2', a.id)).toBe(true);
    expect(notifier.markRead('u2', a.id)).toBe(true); // already read: still yours
    expect(notifier.list('u2').unread).toBe(1);
    expect(pushed.filter(p => p.ev.kind === 'read')).toEqual([{ userId: 'u2', ev: { kind: 'read', ids: [a.id] } }]);

    expect(notifier.markAllRead('u2')).toBe(1);
    expect(notifier.markAllRead('u2')).toBe(0);
    expect(notifier.list('u2').unread).toBe(0);
    expect(notifier.list('u3').unread).toBe(1);
    expect(notifier.list('u2').items.find(n => n.id === b.id)!.readAt).toEqual(expect.any(Number));
  });

  it('prunes read ones after 90 days and unread ones after a year; a deleted user takes theirs', () => {
    const now = Date.now();
    const at = (title: string, ageDays: number, read: boolean) => {
      const n = notifier.notify({ userId: 'u2', type: 'mention', title })!;
      db.prepare('UPDATE notifications SET createdAt = ?, readAt = ? WHERE id = ?').run(now - ageDays * 86400_000, read ? now : null, n.id);
    };
    at('old read', 100, true);
    at('recent read', 10, true);
    at('old unread', 100, false);
    at('ancient unread', 400, false);
    expect(notifier.prune(now)).toBe(2);
    expect(notifier.list('u2').items.map(n => n.title).sort()).toEqual(['old unread', 'recent read']);
    notifier.removeUser('u2');
    expect(notifier.list('u2').items).toEqual([]);
  });

  it('never throws at whatever triggered it', () => {
    db.exec('DROP TABLE notifications');
    expect(notifier.notify({ userId: 'u2', type: 'mention', title: 't' })).toBeNull();
  });

  it('clips long text', () => {
    const n = notifier.notify({ userId: 'u2', type: 'mention', title: 'x'.repeat(500), body: 'y'.repeat(2000) })!;
    expect(n.title.length).toBe(200);
    expect(n.body!.length).toBe(500);
  });
});

describe('notification routes', () => {
  const app = (as: string) => {
    const a = express();
    a.use(express.json());
    registerNotificationRoutes(a, {
      authenticateToken: (req: any, _res, next) => { req.user = { id: as, role: 'user' }; next(); },
      notifier,
    });
    return a;
  };

  it('lists your own, marks one read, and marks them all read', async () => {
    const a = notifier.notify({ userId: 'u2', type: 'mention', title: 'a' })!;
    notifier.notify({ userId: 'u2', type: 'mention', title: 'b' });
    notifier.notify({ userId: 'u3', type: 'mention', title: 'c' });

    const list = await request(app('u2')).get('/api/notifications');
    expect(list.body.unread).toBe(2);
    expect(list.body.items.map((n: any) => n.title)).toEqual(['b', 'a']);

    expect((await request(app('u3')).post(`/api/notifications/${a.id}/read`)).status).toBe(404);
    expect((await request(app('u2')).post(`/api/notifications/${a.id}/read`)).status).toBe(200);
    expect((await request(app('u2')).get('/api/notifications')).body.unread).toBe(1);

    expect((await request(app('u2')).post('/api/notifications/read-all')).body).toEqual({ marked: 1 });
    expect((await request(app('u2')).get('/api/notifications')).body.unread).toBe(0);
    expect((await request(app('u3')).get('/api/notifications')).body.unread).toBe(1);
  });
});

describe('live push', () => {
  let rt: Awaited<ReturnType<typeof startRealtimeServer>>;
  afterEach(async () => { await rt?.close(); });

  it('reaches every tab of the recipient and nobody else', async () => {
    rt = await startRealtimeServer();
    const live = new Notifier(db, (userId, ev) => { rt.io.to(userRoom(userId)).emit(NOTIFICATION_EVENT, ev); });
    const mariaTab1 = connectClient(rt.port, makeToken({ id: 'u2', username: 'maria', role: 'user' }));
    const mariaTab2 = connectClient(rt.port, makeToken({ id: 'u2', username: 'maria', role: 'user' }));
    const joe = connectClient(rt.port, makeToken({ id: 'u3', username: 'joe', role: 'user' }));
    await Promise.all([mariaTab1, mariaTab2, joe].map(s => waitFor(s, 'sessions-snapshot')));
    let joeGot = 0;
    joe.on(NOTIFICATION_EVENT, () => { joeGot++; });

    const got = Promise.all([waitFor<NotificationEvent>(mariaTab1, NOTIFICATION_EVENT), waitFor<NotificationEvent>(mariaTab2, NOTIFICATION_EVENT)]);
    const n = live.notify({ userId: 'u2', type: 'task-assigned', title: 'joe assigned you a task', actorUserId: 'u3' })!;
    const [e1, e2] = await got;
    expect(e1).toEqual({ kind: 'new', notification: n });
    expect(e2).toEqual(e1);

    const read = waitFor<NotificationEvent>(mariaTab2, NOTIFICATION_EVENT);
    live.markAllRead('u2');
    expect(await read).toEqual({ kind: 'read', ids: 'all' });
    await new Promise(r => setTimeout(r, 50));
    expect(joeGot).toBe(0);
    for (const s of [mariaTab1, mariaTab2, joe]) s.close();
  });
});
