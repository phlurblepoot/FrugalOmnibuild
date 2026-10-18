import { describe, it, expect, beforeEach, vi } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { openDb } from '../../db'; import { runMigrations } from '../../migrations'; import { migrations } from '../../migrationList';
import { MailCrypto } from '../crypto'; import * as accounts from '../accountStore';
import { FakeMailProvider } from '../providers/fake'; import { AuthExpiredError, RateLimitedError } from '../providers/types';
import type { MailProvider } from '../providers/types';
import { MailScheduler } from './scheduler';
import type { MailContext } from '../context';

const crypto = new MailCrypto(Buffer.alloc(32, 4));
let ctx: MailContext; let provider: FakeMailProvider; let acct: accounts.MailAccountRow;
const env = (id: string) => ({ providerMessageId: id, references: [], from: { addr: 'x@y' }, to: [], cc: [], bcc: [], subject: 's', snippet: '', date: new Date().toISOString(), isRead: false, isStarred: false, isDraft: false, attachments: [], sizeBytes: 1, folderProviderIds: ['INBOX'], messageIdHeader: id + '@y' });
beforeEach(() => {
  const db = openDb(':memory:'); runMigrations(db, fs.mkdtempSync(path.join(os.tmpdir(), 'ft-sc-')), migrations, { mailCrypto: crypto });
  db.prepare(`INSERT INTO users (id, username, password, role) VALUES ('u1','a','x','admin')`).run();
  acct = accounts.createAccount(db, crypto, { userId: 'u1', provider: 'fake', emailAddress: 'me@birchwood.example', auth: { refreshToken: 'r' } });
  provider = new FakeMailProvider(); provider.seed([env('seeded')]);
  ctx = { db, dataDir: '', crypto, providerFactory: () => provider, broadcastChange: () => {} };
});

describe('MailScheduler', () => {
  it('backfills on start, then polls incrementally on the slow timer', async () => {
    vi.useFakeTimers();
    const s = new MailScheduler(ctx, { fastMs: 1000, slowMs: 5000 });
    s.start(); await vi.runOnlyPendingTimersAsync();
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 1 });
    provider.injectInbound(env('later'));
    await vi.advanceTimersByTimeAsync(5001);
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 2 });
    await s.stop(); vi.useRealTimers();
  });
  it('uses the fast timer while viewed and poke runs immediately', async () => {
    vi.useFakeTimers();
    const s = new MailScheduler(ctx, { fastMs: 1000, slowMs: 5000 });
    s.start(); await vi.runOnlyPendingTimersAsync();
    s.markViewed([acct.id]); provider.injectInbound(env('fast'));
    await vi.advanceTimersByTimeAsync(1001);
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 2 });
    provider.injectInbound(env('poked')); s.pokeAccount(acct.id); await vi.runOnlyPendingTimersAsync();
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 3 });
    await s.stop(); vi.useRealTimers();
  });
  it('stops the worker and flags auth_error on AuthExpiredError', async () => {
    vi.useFakeTimers();
    provider.failNextWith(new AuthExpiredError('expired'));
    const s = new MailScheduler(ctx, { fastMs: 1000, slowMs: 5000 });
    s.start(); await vi.runOnlyPendingTimersAsync();
    expect(accounts.getAccountAny(ctx.db, acct.id)!.status).toBe('auth_error');
    expect(s.isRunning(acct.id)).toBe(false);
    await s.stop(); vi.useRealTimers();
  });
  it('start() survives an account whose provider cannot be built: it is parked in auth_error, the rest still sync', async () => {
    vi.useFakeTimers();
    const events: { type: string; id: string }[] = [];
    ctx.broadcastChange = ev => { events.push(ev as { type: string; id: string }); };
    const bad = accounts.createAccount(ctx.db, crypto, { userId: 'u1', provider: 'fake', emailAddress: 'bad@birchwood.example', auth: { refreshToken: 'r' } });
    ctx.providerFactory = (a) => { if (a.id === bad.id) throw new Error('auth blob unreadable'); return provider; };
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const s = new MailScheduler(ctx, { fastMs: 1000, slowMs: 5000 });
    expect(() => s.start()).not.toThrow();
    await vi.runOnlyPendingTimersAsync();
    const parked = accounts.getAccountAny(ctx.db, bad.id)!;
    expect(parked.status).toBe('auth_error');
    expect(parked.lastError).toBe('auth blob unreadable');
    expect(s.isRunning(bad.id)).toBe(false);
    expect(events.some(e => e.type === 'mailAccount' && e.id === bad.id)).toBe(true);
    // the healthy account's worker still ran its backfill
    expect(s.isRunning(acct.id)).toBe(true);
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 1 });
    errSpy.mockRestore();
    await s.stop(); vi.useRealTimers();
  });
  it('getProvider creates a provider for an account without a worker', () => {
    const s = new MailScheduler(ctx);
    expect(s.getProvider(acct.id)).toBe(provider);
  });
  it('clamps the backoff delay after applying jitter, never scheduling past backoffMaxMs', async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, 'random').mockReturnValue(1);   // worst-case jitter multiplier: 1.2x
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    provider.listFolders = async () => { throw new Error('listFolders down'); };   // fails every backfill attempt
    // slowMs alone (1000) already exceeds backoffMaxMs (100) once doubled for a single failure,
    // so a pre-jitter clamp (buggy) would yield 100 * 1.2 = 120; a post-jitter clamp caps at 100.
    const s = new MailScheduler(ctx, { fastMs: 1000, slowMs: 1000, backoffMaxMs: 100 });
    s.start();
    await vi.runOnlyPendingTimersAsync();
    const delays = setTimeoutSpy.mock.calls.map(c => c[1] as number).filter((d): d is number => typeof d === 'number');
    expect(delays.length).toBeGreaterThan(0);
    expect(Math.max(...delays)).toBeLessThanOrEqual(100);
    await s.stop();
    randomSpy.mockRestore(); setTimeoutSpy.mockRestore(); vi.useRealTimers();
  });
  it('retries backfill on the next tick after a transient failure, instead of switching to incremental against a null syncState', async () => {
    vi.useFakeTimers();
    provider.failNextWith(new Error('net blip'));
    const s = new MailScheduler(ctx, { fastMs: 1000, slowMs: 1000, backoffMaxMs: 5000 });
    s.start();
    // Settle only the microtask-only first attempt (no macrotask boundary needed for it to fail),
    // without also racing ahead into the just-scheduled retry timer.
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 0 });
    expect(accounts.getAccountAny(ctx.db, acct.id)!.syncState).toBeNull();
    await vi.advanceTimersByTimeAsync(2500);   // past the single-failure backoff (max 1000*2*1.2 = 2400ms)
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 1 });
    expect(accounts.getAccountAny(ctx.db, acct.id)!.syncState).not.toBeNull();
    await s.stop(); vi.useRealTimers();
  });
  it('an account deleted between ticks stops the worker without an unhandled rejection', async () => {
    vi.useFakeTimers();
    const s = new MailScheduler(ctx, { fastMs: 1000, slowMs: 1000 });
    s.start();
    await vi.runOnlyPendingTimersAsync();   // first backfill completes successfully
    expect(s.isRunning(acct.id)).toBe(true);
    accounts.deleteAccount(ctx.db, acct.id);   // account vanishes before the next tick's DB read
    await vi.advanceTimersByTimeAsync(1001);
    expect(s.isRunning(acct.id)).toBe(false);
    await s.stop(); vi.useRealTimers();
  });
  it('pokeAccount mid-tick queues a re-run instead of dropping it, and does not start a second concurrent tick', async () => {
    vi.useFakeTimers();
    const s = new MailScheduler(ctx, { fastMs: 1000, slowMs: 5000 });
    s.start(); await vi.runOnlyPendingTimersAsync();
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 1 });

    let resolveDeferred: () => void = () => {};
    const deferred = new Promise<void>(res => { resolveDeferred = res; });
    const origIncremental = provider.incremental.bind(provider);
    let calls = 0;
    provider.incremental = async (state: any) => {
      calls++;
      if (calls === 1) await deferred;
      return origIncremental(state);
    };

    provider.injectInbound(env('during'));
    s.pokeAccount(acct.id);                 // starts tick #2, blocks inside incremental on `deferred`
    expect(calls).toBe(1);
    provider.injectInbound(env('after'));
    s.pokeAccount(acct.id);                 // mid-tick poke: must queue, not start a second concurrent call
    expect(calls).toBe(1);

    resolveDeferred();
    await vi.advanceTimersByTimeAsync(0);   // settle the queued re-run's microtask chain without also firing the next real poll timer
    expect(calls).toBe(2);                  // the queued poke ran once tick #2 finished
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 3 });
    await s.stop(); vi.useRealTimers();
  });
});

describe('MailScheduler push', () => {
  it('starts the provider push channel and re-syncs when it fires', async () => {
    vi.useFakeTimers();
    let onChange: (() => void) | null = null;
    const p: MailProvider = provider;
    p.startPush = vi.fn(async (cb: () => void) => { onChange = cb; });
    const s = new MailScheduler(ctx, { fastMs: 1000, slowMs: 500_000 });
    s.start(); await vi.runOnlyPendingTimersAsync();
    expect(p.startPush).toHaveBeenCalledTimes(1);
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 1 });

    provider.injectInbound(env('pushed'));
    onChange!();                                   // the provider says something moved
    await vi.runOnlyPendingTimersAsync();
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 2 });
    await s.stop(); vi.useRealTimers();
  });

  it('parks the account in auth_error when the push channel reports dead credentials', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const events: { type: string; id: string }[] = [];
    ctx.broadcastChange = ev => { events.push(ev as { type: string; id: string }); };
    let onAuthError: ((e: Error) => void) | null = null;
    const p: MailProvider = provider;
    p.startPush = vi.fn(async (_cb: () => void, onErr?: (e: Error) => void) => { onAuthError = onErr ?? null; });
    const s = new MailScheduler(ctx, { fastMs: 1000, slowMs: 500_000 });
    s.start(); await vi.runOnlyPendingTimersAsync();

    onAuthError!(new Error('mailbox rejected the password'));
    await vi.runOnlyPendingTimersAsync();
    const row = accounts.getAccountAny(ctx.db, acct.id)!;
    expect(row.status).toBe('auth_error');
    expect(row.lastError).toBe('mailbox rejected the password');
    expect(s.isRunning(acct.id)).toBe(false);
    expect(events.some(e => e.type === 'mailAccount' && e.id === acct.id)).toBe(true);
    errSpy.mockRestore();
    await s.stop(); vi.useRealTimers();
  });

  it('does not park the account when a sync succeeded after the push error fired', async () => {
    // The IDLE socket can be rejected while the tick already in flight completes
    // happily against a still-valid session. The poll path is the source of
    // truth: the account keeps polling and the channel is reopened on the next
    // startAccount().
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-30T12:00:00.000Z'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let onAuthError: ((e: Error) => void) | null = null;
    const p: MailProvider = provider;
    p.startPush = vi.fn(async (_cb: () => void, onErr?: (e: Error) => void) => { onAuthError = onErr ?? null; });
    // The scheduler's clock, held one second BEHIND the sync the backfill records —
    // i.e. the channel gave up before that sync landed.
    let clock = Date.parse('2026-08-30T11:59:59.000Z');
    const s = new MailScheduler(ctx, { fastMs: 1000, slowMs: 500_000, now: () => clock });
    s.start(); await vi.runOnlyPendingTimersAsync();
    const syncedAt = accounts.getAccountAny(ctx.db, acct.id)!.lastSyncAt!;
    expect(Date.parse(syncedAt)).toBeGreaterThan(clock);

    onAuthError!(new Error('IDLE says the password is wrong'));
    await vi.advanceTimersByTimeAsync(0);
    const row = accounts.getAccountAny(ctx.db, acct.id)!;
    expect(row.status).toBe('ok');
    expect(row.lastError).toBeNull();
    expect(s.isRunning(acct.id)).toBe(true);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore(); clock = Date.now();
    await s.stop(); vi.useRealTimers();
  });

  it('does not park an account whose worker was replaced before the push error settled', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    let onAuthError: ((e: Error) => void) | null = null;
    const p: MailProvider = provider;
    p.startPush = vi.fn(async (_cb: () => void, onErr?: (e: Error) => void) => { onAuthError = onErr ?? null; });
    const s = new MailScheduler(ctx, { fastMs: 1000, slowMs: 500_000 });
    s.start(); await vi.runOnlyPendingTimersAsync();
    const dead = onAuthError!;
    // A reconnect: the old worker is torn down and a new one takes the account.
    s.stopAccount(acct.id); s.startAccount(acct.id);
    await vi.advanceTimersByTimeAsync(0);
    dead(new Error('the channel we already replaced is dead'));
    await vi.advanceTimersByTimeAsync(0);
    expect(accounts.getAccountAny(ctx.db, acct.id)!.status).toBe('ok');
    expect(s.isRunning(acct.id)).toBe(true);
    errSpy.mockRestore();
    await s.stop(); vi.useRealTimers();
  });

  it('a rejected startPush does not take the worker down', async () => {
    vi.useFakeTimers();
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const p: MailProvider = provider;
    p.startPush = vi.fn(async () => { throw new Error('IDLE refused'); });
    const s = new MailScheduler(ctx, { fastMs: 1000, slowMs: 500_000 });
    s.start(); await vi.runOnlyPendingTimersAsync();
    expect(s.isRunning(acct.id)).toBe(true);
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 1 });
    errSpy.mockRestore();
    await s.stop(); vi.useRealTimers();
  });

  it('stopAccount closes the push channel', async () => {
    vi.useFakeTimers();
    const p: MailProvider = provider;
    p.startPush = vi.fn(async () => {});
    p.stopPush = vi.fn(async () => {});
    const s = new MailScheduler(ctx, { fastMs: 1000, slowMs: 500_000 });
    s.start(); await vi.runOnlyPendingTimersAsync();
    s.stopAccount(acct.id);
    await vi.advanceTimersByTimeAsync(0);   // startPush/stopPush are dispatched off a microtask
    expect(p.stopPush).toHaveBeenCalledTimes(1);
    await s.stop(); vi.useRealTimers();
  });

  it('opens the push channel before the first tick, so a worker that stops immediately still closes it', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const p: MailProvider = provider;
    p.startPush = vi.fn(async () => { order.push('start'); });
    p.stopPush = vi.fn(async () => { order.push('stop'); });
    // The account vanishes between the provider being built and the first tick
    // reading the row, so tick() calls stopAccount() before startAccount returns.
    const inner = ctx.providerFactory;
    ctx.providerFactory = (a, auth) => { accounts.deleteAccount(ctx.db, a.id); return inner(a, auth); };
    const s = new MailScheduler(ctx, { fastMs: 1000, slowMs: 500_000 });
    s.startAccount(acct.id);
    await vi.runOnlyPendingTimersAsync();
    expect(s.isRunning(acct.id)).toBe(false);
    // Not just "both were called" — a stop that lands before the start leaves the
    // IDLE connection open with no worker left to close it.
    expect(order).toEqual(['start', 'stop']);
    await s.stop(); vi.useRealTimers();
  });

  it('keeps a Graph subscription alive on each tick when a public URL is configured', async () => {
    vi.useFakeTimers();
    const ms = accounts.createAccount(ctx.db, crypto, { userId: 'u1', provider: 'microsoft', emailAddress: 'ms@birchwood.example', auth: { refreshToken: 'r' } });
    const graph = provider as FakeMailProvider & {
      createSubscription: ReturnType<typeof vi.fn>; renewSubscription: ReturnType<typeof vi.fn>;
    };
    graph.createSubscription = vi.fn(async (_u: string, _c: string, exp: string) => ({ id: 'sub-1', expirationDateTime: exp }));
    graph.renewSubscription = vi.fn(async (id: string, exp: string) => ({ id, expirationDateTime: exp }));
    const s = new MailScheduler(ctx, { fastMs: 1000, slowMs: 5000, publicUrl: 'https://app.test' });
    s.start(); await vi.runOnlyPendingTimersAsync();
    expect(graph.createSubscription).toHaveBeenCalledTimes(1);
    const state = JSON.parse(accounts.getAccountAny(ctx.db, ms.id)!.syncState || '{}');
    expect(state.subscriptionId).toBe('sub-1');
    expect(state.cursor).toBe(0);                       // the provider's own sync state is intact

    await vi.advanceTimersByTimeAsync(5001);            // next tick: still fresh, so no second call
    expect(graph.createSubscription).toHaveBeenCalledTimes(1);
    expect(graph.renewSubscription).not.toHaveBeenCalled();
    await s.stop(); vi.useRealTimers();
  });

  it('keeps a Gmail watch alive on each tick when a Pub/Sub topic is configured', async () => {
    vi.useFakeTimers();
    const g = accounts.createAccount(ctx.db, crypto, { userId: 'u1', provider: 'google', emailAddress: 'g@birchwood.example', auth: { refreshToken: 'r' } });
    const gmail = provider as FakeMailProvider & { watch: ReturnType<typeof vi.fn>; stopWatch: ReturnType<typeof vi.fn> };
    gmail.watch = vi.fn(async () => ({ historyId: '7', expiration: String(Date.now() + 7 * 24 * 3600_000) }));
    gmail.stopWatch = vi.fn(async () => {});
    const s = new MailScheduler(ctx, { fastMs: 1000, slowMs: 5000, googlePubsubTopic: 'projects/ft/topics/mail' });
    s.start(); await vi.runOnlyPendingTimersAsync();
    expect(gmail.watch).toHaveBeenCalledWith('projects/ft/topics/mail');
    const state = JSON.parse(accounts.getAccountAny(ctx.db, g.id)!.syncState || '{}');
    expect(typeof state.watchExpiration).toBe('number');
    expect(state.cursor).toBe(0);                       // the provider's own sync state is intact

    await vi.advanceTimersByTimeAsync(5001);            // next tick: still days of life left
    expect(gmail.watch).toHaveBeenCalledTimes(1);
    await s.stop(); vi.useRealTimers();
  });

  it('leaves Gmail alone when no Pub/Sub topic is configured — polling is the whole story', async () => {
    vi.useFakeTimers();
    accounts.createAccount(ctx.db, crypto, { userId: 'u1', provider: 'google', emailAddress: 'g@birchwood.example', auth: { refreshToken: 'r' } });
    const gmail = provider as FakeMailProvider & { watch: ReturnType<typeof vi.fn>; stopWatch: ReturnType<typeof vi.fn> };
    gmail.watch = vi.fn(); gmail.stopWatch = vi.fn();
    const s = new MailScheduler(ctx, { fastMs: 1000, slowMs: 5000 });
    s.start(); await vi.runOnlyPendingTimersAsync();
    expect(gmail.watch).not.toHaveBeenCalled();
    await s.stop(); vi.useRealTimers();
  });

  it('leaves Graph alone when no public URL is configured', async () => {
    vi.useFakeTimers();
    accounts.createAccount(ctx.db, crypto, { userId: 'u1', provider: 'microsoft', emailAddress: 'ms@birchwood.example', auth: { refreshToken: 'r' } });
    const graph = provider as FakeMailProvider & { createSubscription: ReturnType<typeof vi.fn> };
    graph.createSubscription = vi.fn();
    const s = new MailScheduler(ctx, { fastMs: 1000, slowMs: 5000 });
    s.start(); await vi.runOnlyPendingTimersAsync();
    expect(graph.createSubscription).not.toHaveBeenCalled();
    await s.stop(); vi.useRealTimers();
  });
  // ── rate limiting ─────────────────────────────────────────────────────────
  it('routes the tick back to the backfill while a parked import is still in the syncState', async () => {
    vi.useFakeTimers();
    let backfills = 0;
    const origBackfill = provider.backfill.bind(provider);
    provider.backfill = async (o: any) => { backfills++; return origBackfill(o); };
    // A non-null syncState that nevertheless holds an unfinished import: before
    // the resume work this fell through to the incremental poll, which happily
    // reported "nothing new" over a mailbox that was never fully read.
    accounts.updateAccount(ctx.db, acct.id, { syncState: JSON.stringify({ cursor: 3, backfillCursor: 'PT2', backfillSince: acct.indexedSince }) });

    const s = new MailScheduler(ctx, { fastMs: 1000, slowMs: 5000 });
    s.start(); await vi.runOnlyPendingTimersAsync();

    expect(backfills).toBe(1);
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 1 });
    // …and the completed import clears the parked keys, so the next tick polls.
    expect(JSON.parse(accounts.getAccountAny(ctx.db, acct.id)!.syncState!).backfillCursor).toBeUndefined();
    await s.stop(); vi.useRealTimers();
  });
  it('waits exactly as long as a throttling provider asked, and does not count the throttle as a failure', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const throttled = new RateLimitedError('Gmail 403 — rate limited');
    throttled.retryAfterMs = 120_000;
    provider.failNextWith(throttled);

    const s = new MailScheduler(ctx, { fastMs: 1000, slowMs: 1000, backoffMaxMs: 5000 });
    s.start();
    await vi.advanceTimersByTimeAsync(0);   // the first attempt fails without needing a macrotask
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 0 });
    const delays = () => setTimeoutSpy.mock.calls.map(c => c[1]).filter((d): d is number => typeof d === 'number');
    expect(Math.max(...delays())).toBe(120_000);

    // The normal backoff would have come back inside a couple of seconds.
    await vi.advanceTimersByTimeAsync(119_000);
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 0 });
    await vi.advanceTimersByTimeAsync(2_000);
    expect(ctx.db.prepare('SELECT COUNT(*) c FROM mail_messages').get()).toEqual({ c: 1 });
    // Exactly slowMs, with no jittered multiplier over it: the throttle never
    // entered the failure count, so the account is not left in retreat.
    expect(delays().at(-1)).toBe(1000);
    await s.stop(); warn.mockRestore(); setTimeoutSpy.mockRestore(); vi.useRealTimers();
  });
  it('caps the stand-down, so a provider asking for an hour does not strand the account', async () => {
    vi.useFakeTimers();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');
    const throttled = new RateLimitedError('Gmail 429 — rate limited');
    throttled.retryAfterMs = 3600_000;
    provider.failNextWith(throttled);

    const s = new MailScheduler(ctx, { fastMs: 1000, slowMs: 1000, backoffMaxMs: 5000 });
    s.start();
    await vi.advanceTimersByTimeAsync(0);
    const delays = setTimeoutSpy.mock.calls.map(c => c[1]).filter((d): d is number => typeof d === 'number');
    expect(Math.max(...delays)).toBe(15 * 60_000);
    await s.stop(); warn.mockRestore(); setTimeoutSpy.mockRestore(); vi.useRealTimers();
  });
});
