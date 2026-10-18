// Phone push notifications (ONLYOFFICE Phase 5, added 2026-09-27): the
// server's key pair, device subscriptions (push services only), sending
// through a stand-in push service that decrypts what it receives with the
// "browser's" keys, forgetting devices the service no longer knows, the
// routes, and the manifest that makes the app installable.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import jwt from 'jsonwebtoken';
import type Database from 'better-sqlite3';
// No types; a dependency of web-push that does the RFC 8188 decryption.
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ece = require('http_ece') as { decrypt: (buf: Buffer, opts: Record<string, unknown>) => Buffer };
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import { PushService, isPushServiceEndpoint } from './push';
import { registerPushRoutes, webAppManifest } from './pushRoutes';
import { Notifier } from './notifications';

let db: Database.Database;
let posted: { url: string; headers: Record<string, string>; body: Buffer }[];
let answer: (url: string) => number;
const fakeFetch = (async (url: any, init: any) => {
  posted.push({ url: String(url), headers: init.headers, body: Buffer.from(init.body) });
  return new Response(null, { status: answer(String(url)) });
}) as typeof fetch;

/** A browser's side of a subscription: its keys, and the JSON it hands over. */
function browser(endpoint = `https://fcm.googleapis.com/fcm/send/${crypto.randomUUID()}`) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    ecdh, auth,
    subscription: { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } },
    read: (body: Buffer) => JSON.parse(ece.decrypt(body, { version: 'aes128gcm', privateKey: ecdh, authSecret: auth }).toString()),
  };
}

beforeEach(() => {
  db = openDb(':memory:');
  runMigrations(db, fs.mkdtempSync(path.join(os.tmpdir(), 'ft-push-')), migrations);
  for (const id of ['u1', 'u2']) db.prepare('INSERT INTO users (id, username, password, role) VALUES (?, ?, ?, ?)').run(id, id, 'x', 'user');
  posted = [];
  answer = () => 201;
});

const service = (contact?: string) => new PushService({ db, fetch: fakeFetch, contact });

describe('PushService', () => {
  it('makes its key pair once and keeps it', () => {
    const a = service().keys();
    expect(a.publicKey).toMatch(/^[A-Za-z0-9_-]{87}$/);
    expect(service().keys()).toEqual(a);
  });

  it('only takes subscriptions from real push services', () => {
    for (const ok of ['https://fcm.googleapis.com/fcm/send/x', 'https://web.push.apple.com/QAB', 'https://updates.push.services.mozilla.com/wpush/v2/x', 'https://wns2-bl2p.notify.windows.com/w/?token=x']) {
      expect(isPushServiceEndpoint(ok)).toBe(true);
    }
    for (const bad of ['http://fcm.googleapis.com/x', 'https://fcm.googleapis.com.evil.com/x', 'https://evil.com/fcm.googleapis.com',
      'https://localhost/x', 'http://onlyoffice/command', 'https://user:pw@fcm.googleapis.com/x', 'https://fcm.googleapis.com:8443/x', 'not a url']) {
      expect(isPushServiceEndpoint(bad)).toBe(false);
    }
    const s = service();
    expect(() => s.subscribe('u1', { endpoint: 'http://app:3000/api/x', keys: browser().subscription.keys }, null)).toThrow(/push service/);
    expect(() => s.subscribe('u1', { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'not base64!', auth: 'x' } }, null)).toThrow(/malformed/);
  });

  it('encrypts the message so only that browser can read it, signed with the server key', async () => {
    const s = service('https://takeoff.example.com');
    const phone = browser();
    s.subscribe('u1', phone.subscription, 'iPhone · Safari');
    const result = await s.send('u1', { title: 'maria assigned you a task', body: 'Hang board', link: '/tasks?open=t1', id: 'n1', unread: 3 });
    expect(result).toEqual({ sent: 1, removed: 0, failed: 0 });
    const [req] = posted;
    expect(req.url).toBe(phone.subscription.endpoint);
    expect(phone.read(req.body)).toEqual({ title: 'maria assigned you a task', body: 'Hang board', link: '/tasks?open=t1', id: 'n1', unread: 3 });
    expect(req.headers.TTL).toBe('86400');
    const [, token] = /^vapid t=([^,]+), k=(.+)$/.exec(req.headers.Authorization)!;
    const claims = jwt.decode(token) as { aud: string; sub: string };
    expect(claims).toMatchObject({ aud: 'https://fcm.googleapis.com', sub: 'https://takeoff.example.com' });
    expect(s.devices('u1')[0]).toMatchObject({ device: 'iPhone · Safari', lastUsedAt: expect.any(Number) });
  });

  it('falls back to a neutral contact when none is configured', async () => {
    const s = service();
    s.subscribe('u1', browser().subscription, 'Phone');
    await s.send('u1', { title: 't', body: 'b', link: '/', id: 'n1', unread: 1 });
    const [, token] = /^vapid t=([^,]+), k=(.+)$/.exec(posted[0].headers.Authorization)!;
    expect((jwt.decode(token) as { sub: string }).sub).toBe('mailto:admin@example.com');
  });

  it('sends to each of that person’s devices only, and forgets ones the service no longer knows', async () => {
    const s = service();
    const [phone, laptop, gone, other] = [browser(), browser('https://web.push.apple.com/abc'), browser(), browser()];
    s.subscribe('u1', phone.subscription, null);
    s.subscribe('u1', laptop.subscription, null);
    s.subscribe('u1', gone.subscription, null);
    s.subscribe('u2', other.subscription, null);
    answer = url => (url === gone.subscription.endpoint ? 410 : url === laptop.subscription.endpoint ? 503 : 201);
    expect(await s.send('u1', { title: 'hi' })).toEqual({ sent: 1, removed: 1, failed: 1 });
    expect(posted.map(p => p.url).sort()).toEqual([phone, laptop, gone].map(b => b.subscription.endpoint).sort());
    expect(s.devices('u1')).toHaveLength(2);
    expect(await s.send('nobody', { title: 'hi' })).toEqual({ sent: 0, removed: 0, failed: 0 });
  });

  it('never throws when the push service cannot be reached', async () => {
    const s = new PushService({ db, fetch: (async () => { throw new TypeError('fetch failed'); }) as typeof fetch });
    s.subscribe('u1', browser().subscription, null);
    expect(await s.send('u1', { title: 'hi' })).toEqual({ sent: 0, removed: 0, failed: 1 });
  });

  it('moves a browser to whoever signs in on it, and turns off per device or for a deleted user', () => {
    const s = service();
    const b = browser();
    const first = s.subscribe('u1', b.subscription, 'Android · Chrome');
    const moved = s.subscribe('u2', b.subscription, 'Android · Chrome');
    expect(moved.id).toBe(first.id);
    expect(s.devices('u1')).toEqual([]);
    expect(s.devices('u2')).toHaveLength(1);
    expect(s.removeDevice('u1', first.id)).toBe(false);
    expect(s.unsubscribe('u2', b.subscription.endpoint)).toBe(true);
    s.subscribe('u2', browser().subscription, null);
    s.removeUser('u2');
    expect(s.devices('u2')).toEqual([]);
  });

  it('clips a long message so it fits', async () => {
    const s = service();
    const phone = browser();
    s.subscribe('u1', phone.subscription, null);
    await s.send('u1', { title: 't', body: 'x'.repeat(2000) });
    expect(phone.read(posted[0].body).body).toHaveLength(300);
  });
});

describe('push routes', () => {
  let push: PushService;
  const app = (as = 'u1') => {
    push = service();
    const a = express();
    a.use(express.json());
    registerPushRoutes(a, {
      db, push,
      authenticateToken: (req: any, _res, next) => { req.user = { id: as, role: 'user' }; next(); },
    });
    return a;
  };

  it('hands out the public key, turns push on for this device (named from the browser), lists and removes it', async () => {
    const a = app();
    const key = (await request(a).get('/api/push/config')).body.publicKey;
    expect(key).toBe(push.keys().publicKey);
    const b = browser();
    const sub = await request(a).post('/api/push/subscribe')
      .set('User-Agent', 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1')
      .send({ subscription: b.subscription });
    expect(sub.body.device).toMatchObject({ device: 'iPhone · Safari' });
    expect((await request(a).get('/api/push/devices')).body.devices).toHaveLength(1);
    expect((await request(app('u2')).delete(`/api/push/devices/${sub.body.device.id}`)).status).toBe(404);
    expect((await request(a).delete(`/api/push/devices/${sub.body.device.id}`)).status).toBe(200);
    expect((await request(a).post('/api/push/subscribe').send({ subscription: { endpoint: 'https://evil.com/x', keys: b.subscription.keys } })).status).toBe(400);
  });

  it('sends a test to my devices', async () => {
    const a = app();
    const b = browser();
    await request(a).post('/api/push/subscribe').send({ subscription: b.subscription });
    expect((await request(a).post('/api/push/test')).body).toEqual({ sent: 1, removed: 0, failed: 0 });
    expect(b.read(posted[0].body)).toMatchObject({ title: 'Test notification', link: '/dashboard' });
  });

  it('serves the manifest that makes the app installable, named from Settings', async () => {
    db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('appName', 'FrugalOmnibuild')").run();
    const r = await request(app()).get('/manifest.webmanifest');
    expect(r.headers['content-type']).toMatch(/^application\/manifest\+json/);
    expect(JSON.parse(r.text)).toMatchObject({ name: 'FrugalOmnibuild', short_name: 'Omnibuild', display: 'standalone', start_url: '/dashboard' });
    expect(webAppManifest('').name).toBe('FrugalOmnibuild');
    for (const icon of webAppManifest('x').icons as { src: string }[]) {
      expect(fs.existsSync(path.join(__dirname, '..', 'public', icon.src))).toBe(true);
    }
  });
});

describe('the bell also rings on the phone', () => {
  it('every new notification is pushed, with the unread count for the app badge', async () => {
    const push = service();
    const notifier = new Notifier(db);
    const sent = vi.fn((userId: string, payload: unknown) => push.send(userId, payload as any));
    notifier.onNew(n => { void sent(n.userId, { id: n.id, title: n.title, body: n.body, link: n.link, unread: notifier.unreadCount(n.userId) }); });
    const phone = browser();
    push.subscribe('u2', phone.subscription, null);
    notifier.notify({ userId: 'u2', type: 'task-assigned', title: 'u1 assigned you a task', body: 'Patch soffit', link: '/tasks?open=t1', actorUserId: 'u1' });
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(phone.read(posted[0].body)).toMatchObject({ title: 'u1 assigned you a task', link: '/tasks?open=t1', unread: 1 });
    // Nobody is pushed about their own act, same as the bell.
    notifier.notify({ userId: 'u2', type: 'task-assigned', title: 'self', actorUserId: 'u2' });
    expect(sent).toHaveBeenCalledTimes(1);
  });
});
