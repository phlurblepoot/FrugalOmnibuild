// server/push.ts — phone push notifications (ONLYOFFICE Phase 5, added
// 2026-09-27). Everything the bell shows can also pop up on a person's phone
// (or computer) while the app is closed, on each device they turned it on for.
//
// Standard Web Push: the browser gives each device a push-service address
// (Google's for Chrome and Android, Apple's for iPhone, Mozilla's for
// Firefox) plus keys; the server encrypts each message with those keys and
// posts it there, signed with this server's own VAPID key pair (made once and
// kept in settings, never shown). Nothing to sign up for.
//
// Only real push services are ever posted to: the address comes from the
// browser, so an allowlist keeps it from pointing the server anywhere else.
import crypto from 'crypto';
import webpush from 'web-push';
import type Database from 'better-sqlite3';

export interface PushSubscriptionInput {
  endpoint?: unknown;
  keys?: { p256dh?: unknown; auth?: unknown } | null;
}

export interface PushDevice {
  id: string;
  device: string | null;
  createdAt: number;
  lastUsedAt: number | null;
}

/** What the service worker (public/sw.js) shows. */
export interface PushPayload {
  title: string;
  body?: string | null;
  /** In-app path opened on tap. */
  link?: string | null;
  /** The notification's id, so a tap can mark it read. */
  id?: string;
  /** For the app icon's badge. */
  unread?: number;
}

export interface PushResult { sent: number; removed: number; failed: number }

export class PushError extends Error {}

const KEY_PUBLIC = 'push.vapidPublicKey';
const KEY_PRIVATE = 'push.vapidPrivateKey';
/** A day: an unread message still matters tomorrow morning, not next week. */
const TTL_SECONDS = 24 * 3600;
const SEND_TIMEOUT_MS = 10_000;
/** Push services only accept small messages (4 KB, before encryption). */
const MAX_BODY_CHARS = 300;

/** Push services browsers use. Google (Chrome, Edge on Android, Samsung,
 *  Opera…), Apple (Safari, iPhone home-screen apps), Mozilla (Firefox) and
 *  Microsoft (Edge on Windows). */
const PUSH_HOSTS = [/^fcm\.googleapis\.com$/, /^android\.googleapis\.com$/, /(^|\.)push\.apple\.com$/,
  /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)notify\.windows\.com$/];

export function isPushServiceEndpoint(endpoint: string): boolean {
  let url: URL;
  try { url = new URL(endpoint); } catch { return false; }
  return url.protocol === 'https:' && !url.username && !url.password && !url.port
    && PUSH_HOSTS.some(re => re.test(url.hostname));
}

const B64URL = /^[A-Za-z0-9_-]+={0,2}$/;

export interface PushServiceDeps {
  db: Database.Database;
  /** Who runs this server, for the push services (a mailto: or https: URL). */
  contact?: string | null;
  fetch?: typeof fetch;
  now?: () => number;
}

export class PushService {
  private readonly fetch: typeof fetch;
  constructor(private readonly deps: PushServiceDeps) {
    this.fetch = deps.fetch ?? globalThis.fetch;
  }

  private now = () => (this.deps.now ?? Date.now)();

  /** This server's VAPID key pair, made the first time it's needed. */
  keys(): { publicKey: string; privateKey: string } {
    const get = (k: string) => (this.deps.db.prepare('SELECT value FROM settings WHERE key = ?').get(k) as { value: string } | undefined)?.value;
    let publicKey = get(KEY_PUBLIC);
    let privateKey = get(KEY_PRIVATE);
    if (!publicKey || !privateKey) {
      ({ publicKey, privateKey } = webpush.generateVAPIDKeys());
      const put = this.deps.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
      this.deps.db.transaction(() => { put.run(KEY_PUBLIC, publicKey); put.run(KEY_PRIVATE, privateKey); })();
    }
    return { publicKey, privateKey };
  }

  /** Records (or moves to this user) one device's subscription. */
  subscribe(userId: string, input: PushSubscriptionInput, device: string | null): PushDevice {
    const endpoint = typeof input?.endpoint === 'string' ? input.endpoint : '';
    const p256dh = typeof input?.keys?.p256dh === 'string' ? input.keys.p256dh : '';
    const auth = typeof input?.keys?.auth === 'string' ? input.keys.auth : '';
    if (!isPushServiceEndpoint(endpoint)) throw new PushError("That browser's push service isn't one this app sends to.");
    if (!B64URL.test(p256dh) || !B64URL.test(auth) || p256dh.length > 200 || auth.length > 100) {
      throw new PushError('The subscription keys are missing or malformed.');
    }
    const existing = this.deps.db.prepare('SELECT id FROM push_subscriptions WHERE endpoint = ?').get(endpoint) as { id: string } | undefined;
    const id = existing?.id ?? crypto.randomUUID();
    const now = this.now();
    // The same browser signing in as someone else: it now belongs to them.
    this.deps.db.prepare(`INSERT INTO push_subscriptions (id, userId, endpoint, p256dh, auth, device, createdAt, lastUsedAt)
      VALUES (@id, @userId, @endpoint, @p256dh, @auth, @device, @now, NULL)
      ON CONFLICT(endpoint) DO UPDATE SET userId = @userId, p256dh = @p256dh, auth = @auth, device = @device`)
      .run({ id, userId: String(userId), endpoint, p256dh, auth, device, now });
    return this.devices(userId).find(d => d.id === id)!;
  }

  /** Turns it off for one device (by its push address). */
  unsubscribe(userId: string, endpoint: string): boolean {
    return this.deps.db.prepare('DELETE FROM push_subscriptions WHERE userId = ? AND endpoint = ?').run(String(userId), endpoint).changes > 0;
  }

  devices(userId: string): PushDevice[] {
    return this.deps.db.prepare('SELECT id, device, createdAt, lastUsedAt FROM push_subscriptions WHERE userId = ? ORDER BY createdAt')
      .all(String(userId)) as PushDevice[];
  }

  removeDevice(userId: string, id: string): boolean {
    return this.deps.db.prepare('DELETE FROM push_subscriptions WHERE userId = ? AND id = ?').run(String(userId), id).changes > 0;
  }

  removeUser(userId: string): void {
    this.deps.db.prepare('DELETE FROM push_subscriptions WHERE userId = ?').run(String(userId));
  }

  /** Sends one message to every device the user turned push on for. A device
   *  the push service no longer knows (404/410) is forgotten. Never throws. */
  async send(userId: string, payload: PushPayload): Promise<PushResult> {
    const result: PushResult = { sent: 0, removed: 0, failed: 0 };
    const subs = this.deps.db.prepare('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE userId = ?')
      .all(String(userId)) as { id: string; endpoint: string; p256dh: string; auth: string }[];
    if (!subs.length) return result;
    let vapid: { publicKey: string; privateKey: string };
    try { vapid = this.keys(); } catch (e) {
      console.warn('[push] no VAPID keys:', e instanceof Error ? e.message : e);
      return { ...result, failed: subs.length };
    }
    const body = JSON.stringify({
      ...payload,
      body: payload.body ? (payload.body.length > MAX_BODY_CHARS ? `${payload.body.slice(0, MAX_BODY_CHARS - 1)}…` : payload.body) : undefined,
    });
    await Promise.all(subs.map(async sub => {
      // Checked again at send time: a row from before the allowlist changed
      // must not be followed anywhere else.
      if (!isPushServiceEndpoint(sub.endpoint)) {
        this.deps.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
        result.removed++;
        return;
      }
      try {
        const req = webpush.generateRequestDetails(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          body,
          { vapidDetails: { subject: this.subject(), ...vapid }, TTL: TTL_SECONDS, urgency: 'high' },
        );
        const res = await this.fetch(req.endpoint, {
          method: req.method,
          headers: Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)])),
          body: req.body as unknown as BodyInit,
          signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
        });
        if (res.status === 404 || res.status === 410) {
          this.deps.db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id);
          result.removed++;
        } else if (res.ok) {
          this.deps.db.prepare('UPDATE push_subscriptions SET lastUsedAt = ? WHERE id = ?').run(this.now(), sub.id);
          result.sent++;
        } else {
          result.failed++;
          console.warn(`[push] ${new URL(sub.endpoint).hostname} answered ${res.status}`);
        }
      } catch (e) {
        result.failed++;
        console.warn('[push] send failed:', e instanceof Error ? e.message : e);
      }
    }));
    return result;
  }

  /** Push services want a contact for whoever runs the server. */
  private subject(): string {
    const c = (this.deps.contact ?? '').trim();
    if (/^mailto:.+@.+/.test(c) || /^https:\/\/[^\s]+$/.test(c)) return c;
    return 'mailto:admin@example.com';
  }
}
