// server/mail/push.test.ts — Graph change-notification plumbing (spec §4.2 push column)
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import { runMigrations } from '../migrations';
import { migrations } from '../migrationList';
import { MailCrypto } from './crypto';
import * as accounts from './accountStore';
import { FakeMailProvider } from './providers/fake';
import { runIncremental, runBackfill } from './sync/engine';
import {
  getWebhookSecret, handleGraphWebhook, ensureGraphSubscription,
  pickPushState, writeSyncState, MAX_SUBSCRIPTION_MINUTES, type GraphPushApi,
  getGooglePushSecret, handleGoogleWebhook, ensureGmailWatch, GOOGLE_WEBHOOK_PATH,
  hasGmailWatchApi, releaseGmailWatch, clearPushState, type GmailWatchApi,
} from './push';
import { ProviderNotFoundError } from './providers/types';
import type { GraphProvider } from './providers/microsoft';
import type { GmailProvider } from './providers/google';
import type { MailContext } from './context';

// Compile-time proof that the real provider still satisfies the narrow surface
// push.ts asks for — `npm run lint` fails if either signature drifts.
const _graphSatisfiesPushApi: GraphPushApi = null as unknown as GraphProvider;
void _graphSatisfiesPushApi;
const _gmailSatisfiesWatchApi: GmailWatchApi = null as unknown as GmailProvider;
void _gmailSatisfiesWatchApi;

const crypto = new MailCrypto(Buffer.alloc(32, 9));
let db: Database.Database;
let ctx: MailContext;
let acct: accounts.MailAccountRow;
let provider: FakeMailProvider;

const env = (id: string) => ({
  providerMessageId: id, references: [], from: { addr: 'x@y.com' }, to: [], cc: [], bcc: [],
  subject: 's', snippet: '', date: new Date().toISOString(), isRead: false, isStarred: false, isDraft: false,
  attachments: [], sizeBytes: 1, folderProviderIds: ['INBOX'], messageIdHeader: id + '@y.com',
});
const stateOf = (id: string) => JSON.parse(accounts.getAccountAny(db, id)!.syncState || '{}') as Record<string, unknown>;
const setState = (id: string, state: unknown) => accounts.updateAccount(db, id, { syncState: JSON.stringify(state) });

beforeEach(() => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-push-'));
  db = openDb(':memory:');
  runMigrations(db, dir, migrations, { mailCrypto: crypto });
  db.prepare(`INSERT INTO users (id, username, password, role) VALUES ('u1','a','x','admin')`).run();
  acct = accounts.createAccount(db, crypto, { userId: 'u1', provider: 'microsoft', emailAddress: 'me@birchwood.example', auth: { refreshToken: 'r' } });
  provider = new FakeMailProvider();
  provider.seed([env('seeded')]);
  ctx = { db, dataDir: dir, crypto, providerFactory: () => provider, broadcastChange: () => {} };
});

/** A stand-in for GraphProvider's two subscription calls. */
function stubGraph(over: Partial<GraphPushApi> = {}) {
  const create = vi.fn(async (_url: string, _clientState: string, expiration: string) => ({ id: 'sub-new', expirationDateTime: expiration }));
  const renew = vi.fn(async (id: string, expiration: string) => ({ id, expirationDateTime: expiration }));
  return { createSubscription: create, renewSubscription: renew, ...over } as GraphPushApi & { createSubscription: typeof create; renewSubscription: typeof renew };
}

describe('getWebhookSecret', () => {
  it('generates a hex secret on first use and returns the same one afterwards', () => {
    const a = getWebhookSecret(db);
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(getWebhookSecret(db)).toBe(a);
    const row = db.prepare("SELECT value FROM settings WHERE key = 'mail.webhookSecret'").get() as { value: string };
    expect(row.value).toBe(a);
  });
});

describe('handleGraphWebhook', () => {
  beforeEach(() => setState(acct.id, { deltaLinks: { INBOX: 'l' }, subscriptionId: 'sub-1' }));

  it('maps a notification back to the account that owns the subscription', () => {
    const ids = handleGraphWebhook(ctx, { value: [{ subscriptionId: 'sub-1', clientState: 'secret', resource: 'me/messages' }] }, 'secret');
    expect(ids).toEqual([acct.id]);
  });

  it('ignores a notification whose clientState does not match', () => {
    expect(handleGraphWebhook(ctx, { value: [{ subscriptionId: 'sub-1', clientState: 'wrong' }] }, 'secret')).toEqual([]);
    expect(handleGraphWebhook(ctx, { value: [{ subscriptionId: 'sub-1' }] }, 'secret')).toEqual([]);
  });

  it('ignores a subscription id no account claims, and never matches a different account', () => {
    const other = accounts.createAccount(db, crypto, { userId: 'u1', provider: 'microsoft', emailAddress: 'other@birchwood.example', auth: { refreshToken: 'r' } });
    setState(other.id, { deltaLinks: {}, subscriptionId: 'sub-2' });
    expect(handleGraphWebhook(ctx, { value: [{ subscriptionId: 'sub-unknown', clientState: 'secret' }] }, 'secret')).toEqual([]);
    expect(handleGraphWebhook(ctx, { value: [{ subscriptionId: 'sub-2', clientState: 'secret' }] }, 'secret')).toEqual([other.id]);
  });

  it('does not match on a subscription id that is only a prefix of the stored one', () => {
    expect(handleGraphWebhook(ctx, { value: [{ subscriptionId: 'sub-', clientState: 'secret' }] }, 'secret')).toEqual([]);
  });

  it('treats LIKE wildcards in the id as literal text', () => {
    expect(handleGraphWebhook(ctx, { value: [{ subscriptionId: 'sub%', clientState: 'secret' }] }, 'secret')).toEqual([]);
    expect(handleGraphWebhook(ctx, { value: [{ subscriptionId: 'sub_1', clientState: 'secret' }] }, 'secret')).toEqual([]);
  });

  it('returns each account once for a batch that names it repeatedly, and survives junk', () => {
    const body = { value: [
      { subscriptionId: 'sub-1', clientState: 'secret' },
      { subscriptionId: 'sub-1', clientState: 'secret' },
      null, 'nope', { clientState: 'secret' }, { subscriptionId: 42, clientState: 'secret' },
    ] };
    expect(handleGraphWebhook(ctx, body, 'secret')).toEqual([acct.id]);
  });

  it('returns nothing for a body that is not a notification batch', () => {
    expect(handleGraphWebhook(ctx, undefined, 'secret')).toEqual([]);
    expect(handleGraphWebhook(ctx, { value: 'no' }, 'secret')).toEqual([]);
    expect(handleGraphWebhook(ctx, 'garbage', 'secret')).toEqual([]);
  });
});

describe('ensureGraphSubscription', () => {
  it('creates a subscription when the account has none and stores it beside the delta links', async () => {
    setState(acct.id, { deltaLinks: { INBOX: 'link-1' } });
    const g = stubGraph();
    const now = Date.parse('2026-08-29T00:00:00.000Z');
    await ensureGraphSubscription(ctx, accounts.getAccountAny(db, acct.id)!, g, 'https://app.test/', now);
    expect(g.createSubscription).toHaveBeenCalledTimes(1);
    const [url, clientState, expiration] = g.createSubscription.mock.calls[0];
    expect(url).toBe('https://app.test/api/mail/ms/webhook');
    expect(clientState).toBe(getWebhookSecret(db));
    // Graph caps a message subscription at 4230 minutes; ours must sit under it.
    const minutes = (Date.parse(expiration) - now) / 60_000;
    expect(minutes).toBeGreaterThan(0);
    expect(minutes).toBeLessThanOrEqual(MAX_SUBSCRIPTION_MINUTES);
    expect(stateOf(acct.id)).toEqual({ deltaLinks: { INBOX: 'link-1' }, subscriptionId: 'sub-new', subscriptionExpires: expiration });
  });

  it('renews when less than 12 hours are left, keeping the same subscription id', async () => {
    const now = Date.parse('2026-08-29T00:00:00.000Z');
    setState(acct.id, { deltaLinks: { INBOX: 'l' }, subscriptionId: 'sub-1', subscriptionExpires: new Date(now + 6 * 3600_000).toISOString() });
    const g = stubGraph();
    await ensureGraphSubscription(ctx, accounts.getAccountAny(db, acct.id)!, g, 'https://app.test', now);
    expect(g.createSubscription).not.toHaveBeenCalled();
    expect(g.renewSubscription).toHaveBeenCalledTimes(1);
    expect(g.renewSubscription.mock.calls[0][0]).toBe('sub-1');
    const s = stateOf(acct.id);
    expect(s.subscriptionId).toBe('sub-1');
    expect(Date.parse(s.subscriptionExpires as string)).toBeGreaterThan(now + 24 * 3600_000);
    expect(s.deltaLinks).toEqual({ INBOX: 'l' });
  });

  it('does nothing when the subscription still has more than 12 hours left', async () => {
    const now = Date.parse('2026-08-29T00:00:00.000Z');
    const expires = new Date(now + 40 * 3600_000).toISOString();
    setState(acct.id, { subscriptionId: 'sub-1', subscriptionExpires: expires });
    const g = stubGraph();
    await ensureGraphSubscription(ctx, accounts.getAccountAny(db, acct.id)!, g, 'https://app.test', now);
    expect(g.createSubscription).not.toHaveBeenCalled();
    expect(g.renewSubscription).not.toHaveBeenCalled();
    expect(stateOf(acct.id).subscriptionExpires).toBe(expires);
  });

  it('re-creates the subscription when Graph says it no longer exists (404/410)', async () => {
    const now = Date.parse('2026-08-29T00:00:00.000Z');
    setState(acct.id, { subscriptionId: 'gone', subscriptionExpires: new Date(now + 3600_000).toISOString() });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const g = stubGraph({ renewSubscription: vi.fn(async () => { throw new ProviderNotFoundError('subscriptions/gone'); }) });
    await ensureGraphSubscription(ctx, accounts.getAccountAny(db, acct.id)!, g, 'https://app.test', now);
    expect(g.createSubscription).toHaveBeenCalledTimes(1);
    expect(stateOf(acct.id).subscriptionId).toBe('sub-new');
    warn.mockRestore();
  });

  it('does NOT create a second subscription when the renewal fails for any other reason', async () => {
    // A 429/5xx/dropped socket says nothing about whether the subscription still
    // exists. Creating one per failed tick would leak subscriptions and double
    // every notification; the stored id must survive for the next tick to retry.
    const now = Date.parse('2026-08-29T00:00:00.000Z');
    const expires = new Date(now + 3600_000).toISOString();
    setState(acct.id, { deltaLinks: { INBOX: 'l' }, subscriptionId: 'sub-1', subscriptionExpires: expires });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const g = stubGraph({ renewSubscription: vi.fn(async () => { throw new Error('Graph 503 — service unavailable'); }) });
    await expect(ensureGraphSubscription(ctx, accounts.getAccountAny(db, acct.id)!, g, 'https://app.test', now)).resolves.toBeUndefined();
    expect(g.createSubscription).not.toHaveBeenCalled();
    expect(stateOf(acct.id)).toEqual({ deltaLinks: { INBOX: 'l' }, subscriptionId: 'sub-1', subscriptionExpires: expires });
    expect(err).toHaveBeenCalled();
    err.mockRestore();
  });

  it('never rejects when Graph refuses outright, and leaves the stored state alone', async () => {
    setState(acct.id, { deltaLinks: { INBOX: 'l' } });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const g = stubGraph({ createSubscription: vi.fn(async () => { throw new Error('Graph 503'); }) });
    await expect(ensureGraphSubscription(ctx, accounts.getAccountAny(db, acct.id)!, g, 'https://app.test')).resolves.toBeUndefined();
    expect(stateOf(acct.id)).toEqual({ deltaLinks: { INBOX: 'l' } });
    err.mockRestore();
  });

  it('does nothing without a public URL to point Microsoft at', async () => {
    const g = stubGraph();
    await ensureGraphSubscription(ctx, accounts.getAccountAny(db, acct.id)!, g, '');
    await ensureGraphSubscription(ctx, accounts.getAccountAny(db, acct.id)!, g, null);
    expect(g.createSubscription).not.toHaveBeenCalled();
  });

  it('merges into the syncState written while the Graph call was in flight, never clobbering it', async () => {
    setState(acct.id, { deltaLinks: { INBOX: 'old' } });
    const g = stubGraph({
      createSubscription: vi.fn(async (_u: string, _c: string, exp: string) => {
        setState(acct.id, { deltaLinks: { INBOX: 'fresh-from-a-poll' } });   // a tick finished mid-flight
        return { id: 'sub-new', expirationDateTime: exp };
      }),
    });
    await ensureGraphSubscription(ctx, accounts.getAccountAny(db, acct.id)!, g, 'https://app.test');
    const s = stateOf(acct.id);
    expect(s.deltaLinks).toEqual({ INBOX: 'fresh-from-a-poll' });
    expect(s.subscriptionId).toBe('sub-new');
  });
});

describe('push state survives the sync engine', () => {
  it('pickPushState reads only the push keys, and tolerates broken JSON', () => {
    expect(pickPushState('{"deltaLinks":{},"subscriptionId":"s","subscriptionExpires":"2026-01-01T00:00:00.000Z"}'))
      .toEqual({ subscriptionId: 's', subscriptionExpires: '2026-01-01T00:00:00.000Z' });
    expect(pickPushState(null)).toEqual({});
    expect(pickPushState('not json')).toEqual({});
  });

  it('writeSyncState replaces the provider state but carries the subscription across', () => {
    setState(acct.id, { deltaLinks: { A: '1' }, subscriptionId: 'sub-1', subscriptionExpires: 'x' });
    writeSyncState(db, acct.id, { deltaLinks: { B: '2' } });
    expect(stateOf(acct.id)).toEqual({ deltaLinks: { B: '2' }, subscriptionId: 'sub-1', subscriptionExpires: 'x' });
  });

  it('an incremental poll does not orphan the subscription the scheduler created', async () => {
    await runBackfill(ctx, accounts.getAccountAny(db, acct.id)!, provider);
    writeSyncState(db, acct.id, { ...stateOf(acct.id), subscriptionId: 'sub-1', subscriptionExpires: 'later' });
    provider.injectInbound(env('new-one'));
    await runIncremental(ctx, accounts.getAccountAny(db, acct.id)!, provider);
    const s = stateOf(acct.id);
    expect(s.subscriptionId).toBe('sub-1');
    expect(s.cursor).toBe(1);   // the provider's own state was still refreshed
  });

  it('a load-older backfill does not orphan the subscription either', async () => {
    await runBackfill(ctx, accounts.getAccountAny(db, acct.id)!, provider);
    writeSyncState(db, acct.id, { ...stateOf(acct.id), subscriptionId: 'sub-1' });
    await runBackfill(ctx, accounts.getAccountAny(db, acct.id)!, provider, new Date(0));
    expect(stateOf(acct.id).subscriptionId).toBe('sub-1');
  });
});

// ── Gmail real-time push (Cloud Pub/Sub) ────────────────────────────────────
// Gmail has no socket to hold and no subscription object of its own: it
// publishes to a topic we own, and Pub/Sub POSTs that to our webhook. So the
// moving parts here are the watch's renewal clock and the mapping from the
// email address in a push back to the accounts that hold it.

const HOUR = 3600_000;
const NOW = Date.parse('2026-08-29T00:00:00.000Z');
const TOPIC = 'projects/ft/topics/mail';

/** A stand-in for GmailProvider's two watch calls. */
function stubGmail(over: Partial<GmailWatchApi> = {}) {
  const watch = vi.fn(async (_topic: string) => ({ historyId: '4242', expiration: String(NOW + 7 * 24 * HOUR) }));
  const stopWatch = vi.fn(async () => {});
  return { watch, stopWatch, ...over } as GmailWatchApi & { watch: typeof watch; stopWatch: typeof stopWatch };
}

const googleAccount = (email = 'nick@birchwood.example', userId = 'u1') =>
  accounts.createAccount(db, crypto, { userId, provider: 'google', emailAddress: email, auth: { refreshToken: 'r' } });

const pubsubBody = (payload: unknown, over: Record<string, unknown> = {}) => ({
  message: {
    data: Buffer.from(typeof payload === 'string' ? payload : JSON.stringify(payload), 'utf8').toString('base64'),
    messageId: '1',
    ...over,
  },
  subscription: 'projects/ft/subscriptions/mail-push',
});

describe('getGooglePushSecret', () => {
  it('generates its own hex secret, stable and separate from the Graph one', () => {
    const a = getGooglePushSecret(db);
    expect(a).toMatch(/^[0-9a-f]{48}$/);
    expect(getGooglePushSecret(db)).toBe(a);
    expect(a).not.toBe(getWebhookSecret(db));
    const row = db.prepare("SELECT value FROM settings WHERE key = 'mail.googlePushSecret'").get() as { value: string };
    expect(row.value).toBe(a);
  });

  it('names the path Pub/Sub posts to', () => {
    expect(GOOGLE_WEBHOOK_PATH).toBe('/api/mail/google/webhook');
  });
});

describe('hasGmailWatchApi', () => {
  it('recognises a provider that can carry a watch, and nothing else', () => {
    expect(hasGmailWatchApi(stubGmail())).toBe(true);
    expect(hasGmailWatchApi(provider)).toBe(false);
    expect(hasGmailWatchApi(null)).toBe(false);
    expect(hasGmailWatchApi({ watch: 1 })).toBe(false);
  });
});

describe('ensureGmailWatch', () => {
  it('registers a watch when the account has none, keeping the history watermark', async () => {
    const g = googleAccount();
    setState(g.id, { historyId: '100' });
    const api = stubGmail();
    await ensureGmailWatch(ctx, accounts.getAccountAny(db, g.id)!, api, TOPIC, NOW);

    expect(api.watch).toHaveBeenCalledWith(TOPIC);
    // The watch's own historyId is NOT adopted: the poll owns that watermark,
    // and overwriting it here would skip everything between the two.
    expect(stateOf(g.id)).toEqual({ historyId: '100', watchExpiration: NOW + 7 * 24 * HOUR });
  });

  it('renews once less than a day is left', async () => {
    const g = googleAccount();
    setState(g.id, { historyId: '100', watchExpiration: NOW + 20 * HOUR });
    const api = stubGmail();
    await ensureGmailWatch(ctx, accounts.getAccountAny(db, g.id)!, api, TOPIC, NOW);

    expect(api.watch).toHaveBeenCalledTimes(1);
    expect(stateOf(g.id).watchExpiration).toBe(NOW + 7 * 24 * HOUR);
  });

  it('does nothing while the watch has more than a day left', async () => {
    const g = googleAccount();
    setState(g.id, { historyId: '100', watchExpiration: NOW + 3 * 24 * HOUR });
    const api = stubGmail();
    await ensureGmailWatch(ctx, accounts.getAccountAny(db, g.id)!, api, TOPIC, NOW);

    expect(api.watch).not.toHaveBeenCalled();
    expect(stateOf(g.id).watchExpiration).toBe(NOW + 3 * 24 * HOUR);
  });

  it('does nothing without a topic — the deployment simply polls', async () => {
    const g = googleAccount();
    const api = stubGmail();
    await ensureGmailWatch(ctx, accounts.getAccountAny(db, g.id)!, api, null, NOW);
    await ensureGmailWatch(ctx, accounts.getAccountAny(db, g.id)!, api, '  ', NOW);
    expect(api.watch).not.toHaveBeenCalled();
  });

  it('never rejects when Gmail refuses, and stands the account down instead', async () => {
    // A 403 here is the topic missing its Publisher grant — an admin's console
    // step, not a broken account. It must not fail the tick that called it, and
    // it will not be fixed within 30 seconds, so retrying that fast would spend
    // quota on a certain failure.
    const g = googleAccount();
    setState(g.id, { historyId: '100' });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const api = stubGmail({ watch: vi.fn(async () => { throw new Error('Gmail 403: User not authorized to perform this action.'); }) });

    await expect(ensureGmailWatch(ctx, accounts.getAccountAny(db, g.id)!, api, TOPIC, NOW)).resolves.toBeUndefined();
    expect(stateOf(g.id)).toEqual({ historyId: '100', watchRetryAfter: NOW + 10 * 60_000 });
    expect(String(err.mock.calls[0])).toMatch(/User not authorized/);

    // The next few ticks cost nothing at all…
    await ensureGmailWatch(ctx, accounts.getAccountAny(db, g.id)!, api, TOPIC, NOW + 60_000);
    expect(api.watch).toHaveBeenCalledTimes(1);
    // …and one line a minute, not one per attempt.
    expect(err.mock.calls.length).toBe(1);

    // …until the stand-down runs out.
    await ensureGmailWatch(ctx, accounts.getAccountAny(db, g.id)!, api, TOPIC, NOW + 11 * 60_000);
    expect(api.watch).toHaveBeenCalledTimes(2);
    err.mockRestore();
  });

  it('a success ends the stand-down, so a fixed topic is not held back', async () => {
    const g = googleAccount();
    setState(g.id, { historyId: '100', watchRetryAfter: NOW - 1 });
    const api = stubGmail();
    await ensureGmailWatch(ctx, accounts.getAccountAny(db, g.id)!, api, TOPIC, NOW);

    expect(api.watch).toHaveBeenCalledTimes(1);
    expect(stateOf(g.id)).toEqual({ historyId: '100', watchExpiration: NOW + 7 * 24 * HOUR });
  });

  it('merges into a syncState written while the watch call was in flight', async () => {
    const g = googleAccount();
    setState(g.id, { historyId: '100' });
    const api = stubGmail({
      watch: vi.fn(async () => {
        setState(g.id, { historyId: '200' });   // a poll finished mid-flight
        return { historyId: '4242', expiration: String(NOW + 7 * 24 * HOUR) };
      }),
    });
    await ensureGmailWatch(ctx, accounts.getAccountAny(db, g.id)!, api, TOPIC, NOW);

    expect(stateOf(g.id)).toEqual({ historyId: '200', watchExpiration: NOW + 7 * 24 * HOUR });
  });

  it('falls back to Gmail\'s documented week when the response has no usable expiry', async () => {
    // Without a fallback an unparsable expiry would re-watch on every 30s tick.
    const g = googleAccount();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = stubGmail({ watch: vi.fn(async () => ({ historyId: '1', expiration: 'nonsense' })) });
    await ensureGmailWatch(ctx, accounts.getAccountAny(db, g.id)!, api, TOPIC, NOW);

    expect(stateOf(g.id).watchExpiration).toBe(NOW + 7 * 24 * HOUR);
    warn.mockRestore();
  });

  it('keeps the watch expiry across an incremental poll', async () => {
    const g = googleAccount();
    setState(g.id, { historyId: '100', watchExpiration: NOW + 3 * 24 * HOUR });
    writeSyncState(db, g.id, { historyId: '101' });
    expect(stateOf(g.id)).toEqual({ historyId: '101', watchExpiration: NOW + 3 * 24 * HOUR });
    expect(pickPushState(JSON.stringify({ historyId: 'x', watchExpiration: 5 }))).toEqual({ watchExpiration: 5 });
  });
});

describe('handleGoogleWebhook', () => {
  it('maps the pushed address to every google account that holds it, case-insensitively', () => {
    db.prepare(`INSERT INTO users (id, username, password, role) VALUES ('u2','b','x','user')`).run();
    const a = googleAccount('Nick@Birchwood.example', 'u1');
    const b = googleAccount('nick@birchwood.example', 'u2');
    const ids = handleGoogleWebhook(ctx, pubsubBody({ emailAddress: 'NICK@birchwood.example', historyId: 9 }));
    expect(new Set(ids)).toEqual(new Set([a.id, b.id]));
  });

  it('never pokes an account on another provider that happens to share the address', () => {
    const g = googleAccount('me@birchwood.example');           // acct (microsoft) already has me@birchwood.example
    expect(handleGoogleWebhook(ctx, pubsubBody({ emailAddress: 'me@birchwood.example' }))).toEqual([g.id]);
  });

  it('returns nothing for an address no account holds', () => {
    googleAccount();
    expect(handleGoogleWebhook(ctx, pubsubBody({ emailAddress: 'stranger@elsewhere.com' }))).toEqual([]);
  });

  it('shrugs off a body that is not a decodable Pub/Sub push, logging at most once a minute', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(handleGoogleWebhook(ctx, { message: { data: '!!!not base64!!!' } })).toEqual([]);
    expect(handleGoogleWebhook(ctx, pubsubBody('{ not json'))).toEqual([]);
    expect(handleGoogleWebhook(ctx, pubsubBody({ historyId: 9 }))).toEqual([]);   // no emailAddress
    expect(handleGoogleWebhook(ctx, { message: {} })).toEqual([]);
    expect(handleGoogleWebhook(ctx, undefined)).toEqual([]);
    expect(handleGoogleWebhook(ctx, 'garbage')).toEqual([]);
    expect(warn.mock.calls.length).toBeLessThanOrEqual(1);
    warn.mockRestore();
  });
});

describe('releaseGmailWatch', () => {
  const flush = () => new Promise(r => setTimeout(r, 0));

  it('stops the watch and can clear the key so a re-enable re-watches', async () => {
    const g = googleAccount();
    setState(g.id, { historyId: '100', watchExpiration: NOW + 3 * 24 * HOUR });
    const api = stubGmail();
    releaseGmailWatch(ctx, accounts.getAccountAny(db, g.id)!, () => api, { clearState: true });
    await flush();

    expect(api.stopWatch).toHaveBeenCalledTimes(1);
    // The poll's own watermark stays; only the push bookkeeping goes.
    expect(stateOf(g.id)).toEqual({ historyId: '100' });

    // …and with no expiry on the row, the next tick registers a fresh watch.
    await ensureGmailWatch(ctx, accounts.getAccountAny(db, g.id)!, api, TOPIC, NOW);
    expect(api.watch).toHaveBeenCalledTimes(1);
  });

  it('leaves a shared mailbox\'s watch alone and re-arms the accounts that remain', async () => {
    // users/me/stop is scoped to the MAILBOX. Two people can connect the same
    // shared mailbox — the webhook pokes both on purpose — so stopping here on
    // behalf of one would silently cancel the other's push, and their stored
    // expiry would hide it for up to six days.
    db.prepare(`INSERT INTO users (id, username, password, role) VALUES ('u2','b','x','user')`).run();
    const a = googleAccount('Shared@birchwood.example', 'u1');
    const b = googleAccount('shared@birchwood.example', 'u2');
    setState(a.id, { historyId: '100', watchExpiration: NOW + 3 * 24 * HOUR });
    setState(b.id, { historyId: '200', watchExpiration: NOW + 3 * 24 * HOUR, watchRetryAfter: NOW + HOUR });
    const api = stubGmail();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    releaseGmailWatch(ctx, accounts.getAccountAny(db, a.id)!, () => api, { clearState: true });
    await flush();

    expect(api.stopWatch).not.toHaveBeenCalled();
    // The survivor keeps its watermark but loses the bookkeeping, so its next
    // tick re-asserts the watch rather than trusting one it did not place.
    expect(stateOf(b.id)).toEqual({ historyId: '200' });
    await ensureGmailWatch(ctx, accounts.getAccountAny(db, b.id)!, api, TOPIC, NOW);
    expect(api.watch).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it('still stops the watch when the address is connected only once', async () => {
    const g = googleAccount('sole@birchwood.example');
    setState(g.id, { watchExpiration: NOW + 3 * 24 * HOUR });
    // A microsoft account on the same address is not a sibling — its push is a
    // Graph subscription and nothing about it is mailbox-scoped here.
    accounts.createAccount(db, crypto, { userId: 'u1', provider: 'microsoft', emailAddress: 'sole@birchwood.example', auth: { refreshToken: 'r' } });
    const api = stubGmail();
    releaseGmailWatch(ctx, accounts.getAccountAny(db, g.id)!, () => api);
    await flush();
    expect(api.stopWatch).toHaveBeenCalledTimes(1);
  });

  it('leaves the stored state alone when the caller only wants the watch stopped', async () => {
    // The delete path: the row is about to vanish, so there is nothing to clear.
    const g = googleAccount();
    setState(g.id, { historyId: '100', watchExpiration: NOW + 3 * 24 * HOUR });
    const api = stubGmail();
    releaseGmailWatch(ctx, accounts.getAccountAny(db, g.id)!, () => api);
    await flush();

    expect(api.stopWatch).toHaveBeenCalledTimes(1);
    expect(stateOf(g.id).watchExpiration).toBe(NOW + 3 * 24 * HOUR);
  });

  it('clears the failure backoff too, so a re-enable is not held down by it', async () => {
    const g = googleAccount();
    setState(g.id, { historyId: '100', watchExpiration: NOW + 3 * 24 * HOUR, watchRetryAfter: NOW + 9 * 60_000 });
    const api = stubGmail();
    releaseGmailWatch(ctx, accounts.getAccountAny(db, g.id)!, () => api, { clearState: true });
    await flush();

    expect(api.stopWatch).toHaveBeenCalledTimes(1);
    expect(stateOf(g.id)).toEqual({ historyId: '100' });
    // Re-enabled: the very next tick watches, rather than sitting out the
    // stand-down left over from before it was disabled.
    await ensureGmailWatch(ctx, accounts.getAccountAny(db, g.id)!, api, TOPIC, NOW);
    expect(api.watch).toHaveBeenCalledTimes(1);
  });

  it('clears a stand-down on an account whose watch never once succeeded', async () => {
    // Misconfigured topic since the day it was connected: watchRetryAfter is
    // set and watchExpiration never was. There is no watch to stop — but the
    // key still has to go, or a re-enable inherits the backoff.
    const g = googleAccount();
    setState(g.id, { historyId: '100', watchRetryAfter: NOW + 9 * 60_000 });
    const api = stubGmail();
    releaseGmailWatch(ctx, accounts.getAccountAny(db, g.id)!, () => api, { clearState: true });
    await flush();

    expect(api.stopWatch).not.toHaveBeenCalled();
    expect(stateOf(g.id)).toEqual({ historyId: '100' });
    await ensureGmailWatch(ctx, accounts.getAccountAny(db, g.id)!, api, TOPIC, NOW);
    expect(api.watch).toHaveBeenCalledTimes(1);
  });

  it('costs nothing for an account that never had a watch, or is not Gmail at all', async () => {
    const g = googleAccount();
    setState(g.id, { historyId: '100' });                       // google, but never watched
    const resolve = vi.fn(() => stubGmail());
    releaseGmailWatch(ctx, accounts.getAccountAny(db, g.id)!, resolve, { clearState: true });
    // acct is the microsoft one, with a subscription rather than a watch
    setState(acct.id, { deltaLinks: {}, subscriptionId: 'sub-1' });
    releaseGmailWatch(ctx, accounts.getAccountAny(db, acct.id)!, resolve);
    await flush();

    // The provider is never even built — no token refresh for a no-op.
    expect(resolve).not.toHaveBeenCalled();
    expect(stateOf(acct.id).subscriptionId).toBe('sub-1');
  });

  it('never throws when the provider cannot be built or the stop fails', async () => {
    const g = googleAccount();
    setState(g.id, { watchExpiration: NOW + HOUR });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => releaseGmailWatch(ctx, accounts.getAccountAny(db, g.id)!, () => { throw new Error('auth blob unreadable'); })).not.toThrow();
    const broken = stubGmail({ stopWatch: vi.fn(async () => { throw new Error('Gmail 500'); }) });
    expect(() => releaseGmailWatch(ctx, accounts.getAccountAny(db, g.id)!, () => broken)).not.toThrow();
    await flush();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('clearPushState drops only the named keys', () => {
    setState(acct.id, { deltaLinks: { A: '1' }, subscriptionId: 's', watchExpiration: 5 });
    clearPushState(db, acct.id, ['watchExpiration']);
    expect(stateOf(acct.id)).toEqual({ deltaLinks: { A: '1' }, subscriptionId: 's' });
  });
});
