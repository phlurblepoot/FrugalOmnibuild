// server/mail/sync/scheduler.ts  (spec §4.2 freshness table; providers push via pokeAccount)
// Single-process assumption: workers, providers, and viewed/draining state all live in this
// process's memory. Running more than one server process against the same DB would double-sync.
import type { MailContext } from '../context';
import * as accounts from '../accountStore';
import type { MailProvider } from '../providers/types';
import { AuthExpiredError, RateLimitedError } from '../providers/types';
import { hasParkedBackfill, runBackfill, runIncremental } from './engine';
import { ensureGmailWatch, ensureGraphSubscription, hasGmailWatchApi, hasGraphPushApi } from '../push';

interface Worker {
  accountId: string; provider: MailProvider; timer: NodeJS.Timeout | null; failures: number;
  running: Promise<void> | null; stopped: boolean; pokeRequested: boolean;
  /** Set when the provider asked us to slow down: no tick before this moment. */
  rateLimitedUntil?: number;
}

/** However long a provider asks us to stand down for, we come back inside this.
 *  A Retry-After measured in hours would otherwise strand the account with no
 *  sync and no way back short of a restart. */
const RATE_LIMIT_MAX_STANDDOWN_MS = 15 * 60_000;

export class MailScheduler {
  private workers = new Map<string, Worker>();
  private providers = new Map<string, MailProvider>();
  private viewedAt = new Map<string, number>();
  // Tracks a just-stopped worker's still-in-flight tick, keyed by accountId, so a rapid
  // stopAccount()+startAccount() for the same account doesn't run two ticks concurrently.
  private draining = new Map<string, Promise<void>>();
  private readonly fastMs: number; private readonly slowMs: number; private readonly backoffMaxMs: number; private readonly now: () => number;
  /** Where Microsoft should post change notifications. Null (APP_PUBLIC_URL
   *  unset) means Graph accounts fall back to polling only — spec §4.2. */
  private readonly publicUrl: string | null;
  /** The Cloud Pub/Sub topic Gmail should publish to (GOOGLE_PUBSUB_TOPIC).
   *  Null means Google accounts poll only, exactly as they did before. */
  private readonly googlePubsubTopic: string | null;
  constructor(private ctx: MailContext, opts: { fastMs?: number; slowMs?: number; backoffMaxMs?: number; now?: () => number; publicUrl?: string | null; googlePubsubTopic?: string | null } = {}) {
    this.fastMs = opts.fastMs ?? 30_000; this.slowMs = opts.slowMs ?? 300_000; this.backoffMaxMs = opts.backoffMaxMs ?? 600_000; this.now = opts.now ?? (() => Date.now());
    this.publicUrl = opts.publicUrl ?? null;
    this.googlePubsubTopic = opts.googlePubsubTopic ?? null;
  }
  // Never throws: one account whose provider cannot be constructed (bad/undecryptable
  // auth blob, provider factory blowing up) must not take the whole mail subsystem —
  // or server startup — down with it.
  start(): void { for (const a of accounts.listActiveAccounts(this.ctx.db)) this.startAccount(a.id); }
  async stop(): Promise<void> { for (const id of [...this.workers.keys()]) this.stopAccount(id); await Promise.all([...this.workers.values()].map(w => w.running ?? Promise.resolve())); await Promise.all([...this.draining.values()]); }
  isRunning(accountId: string): boolean { const w = this.workers.get(accountId); return !!w && !w.stopped; }
  markViewed(accountIds: string[]): void {
    accountIds.forEach(id => {
      this.viewedAt.set(id, this.now());
      // A view mid-cycle should shorten an already-scheduled slow-interval
      // wait down to the fast interval, not wait out the stale delay.
      const w = this.workers.get(id);
      if (w && w.timer && !w.running) { clearTimeout(w.timer); this.schedule(w); }
    });
  }
  getProvider(accountId: string): MailProvider {
    let p = this.providers.get(accountId);
    if (!p) {
      const account = accounts.getAccountAny(this.ctx.db, accountId); if (!account) throw new Error('Account not found');
      const auth = accounts.readAuth(this.ctx.db, this.ctx.crypto, accountId)!;
      p = this.ctx.providerFactory(account, auth); this.providers.set(accountId, p);
    }
    return p;
  }
  dropProvider(accountId: string): void { this.providers.delete(accountId); }
  startAccount(accountId: string): void {
    if (this.workers.has(accountId)) return;
    let provider: MailProvider;
    // getProvider() reaches into the DB, the crypto seal and the provider factory —
    // any of those can throw for a single broken account. Park that account in
    // auth_error and carry on with the others instead of propagating.
    try { provider = this.getProvider(accountId); }
    catch (e) { this.markUnstartable(accountId, e); return; }
    const w: Worker = { accountId, provider, timer: null, failures: 0, running: null, stopped: false, pokeRequested: false };
    this.workers.set(accountId, w);
    // Before the first tick, not after: a tick runs synchronously up to its
    // first await, so it can stopAccount() (deleted account) before this line
    // is reached — and then nothing would ever close the channel we opened.
    this.startPush(w);
    const prevDrain = this.draining.get(accountId);
    if (prevDrain) void prevDrain.then(() => { if (!w.stopped) void this.tick(w); });
    else void this.tick(w);
  }
  /** Opens the provider's live-change channel, when it has one (IMAP IDLE).
   *  Fire-and-forget: a channel that will not open is a downgrade to polling,
   *  not a reason to lose the worker. */
  private startPush(w: Worker): void {
    if (!w.provider.startPush || w.stopped) return;
    void Promise.resolve().then(() => w.provider.startPush!(
      () => { if (!w.stopped) this.pokeAccount(w.accountId); },
      (err) => {
        // The channel says the credentials are gone for good — but a push
        // channel dying and a poll succeeding can race (an IDLE socket can be
        // rejected while the tick already in flight completes happily against a
        // still-valid session). Parking on the push error alone would knock out
        // a healthy account, so the decision waits for the in-flight tick.
        void this.settlePushAuthError(w, err, this.now());
      },
    )).catch(e => console.error(`[mail] could not open the push channel for ${w.accountId}:`, (e as Error).message));
  }
  /** Park the account whose push channel reported dead credentials — unless the
   *  poll path says otherwise. Two things can veto the parking:
   *    * the worker is no longer the one that opened this channel (a
   *      stop+start, a reconnect, a deleted account) — that new worker owns the
   *      account now and this error is about a channel that is already closed;
   *    * a sync completed AFTER the error fired, which means the stored
   *      credentials still work. Polling keeps the account fresh, and the push
   *      channel is reopened by the next startAccount().
   *  `firedAt` is captured by the caller, not read here: the whole point is to
   *  compare against the moment the channel gave up, not the moment we looked. */
  private async settlePushAuthError(w: Worker, err: Error, firedAt: number): Promise<void> {
    await w.running;   // tick() never rejects, so this cannot throw
    if (this.workers.get(w.accountId) !== w) return;
    const account = accounts.getAccountAny(this.ctx.db, w.accountId);
    const syncedAt = account?.lastSyncAt ? Date.parse(account.lastSyncAt) : NaN;
    if (Number.isFinite(syncedAt) && syncedAt > firedAt) {
      console.warn(`[mail] push reported dead credentials for ${w.accountId}, but a sync succeeded afterwards — keeping the account on polling instead of parking it:`, err.message);
      return;
    }
    this.stopAccount(w.accountId);
    this.markUnstartable(w.accountId, err, 'push reported dead credentials for');
  }
  private markUnstartable(accountId: string, e: unknown, what = 'cannot start sync for'): void {
    const message = e instanceof Error ? e.message : String(e);
    console.error(`[mail] ${what} ${accountId}:`, message);
    this.providers.delete(accountId);
    const account = accounts.getAccountAny(this.ctx.db, accountId);
    if (!account) return;
    try {
      accounts.updateAccount(this.ctx.db, accountId, { status: 'auth_error', lastError: message });
      this.ctx.broadcastChange({ type: 'mailAccount', id: accountId, action: 'updated', byUserId: account.userId });
    } catch (inner) {
      console.error(`[mail] could not flag ${accountId} as auth_error:`, inner);
    }
  }
  stopAccount(accountId: string): void {
    const w = this.workers.get(accountId); if (!w) return;
    w.stopped = true; if (w.timer) clearTimeout(w.timer); w.timer = null;
    this.workers.delete(accountId);
    void Promise.resolve().then(() => w.provider.stopPush?.())
      .catch(e => console.error(`[mail] could not close the push channel for ${accountId}:`, (e as Error).message));
    if (w.running) {
      const p = w.running;
      this.draining.set(accountId, p);
      void p.finally(() => { if (this.draining.get(accountId) === p) this.draining.delete(accountId); });
    }
  }
  pokeAccount(accountId: string): void {
    const w = this.workers.get(accountId); if (!w) return;
    if (w.running) { w.pokeRequested = true; return; }   // queue: run again as soon as the in-flight tick finishes
    if (w.timer) clearTimeout(w.timer);
    void this.tick(w);
  }
  private schedule(w: Worker): void {
    if (w.stopped) return;
    const viewed = (this.now() - (this.viewedAt.get(w.accountId) ?? -Infinity)) < 60_000;
    const base = viewed ? this.fastMs : this.slowMs;
    // Clamp AFTER jitter, not before — otherwise a maxed-out failure count can still push the
    // delay up to backoffMaxMs * 1.2.
    const delay = w.failures ? Math.min(this.backoffMaxMs, base * 2 ** w.failures * (0.8 + Math.random() * 0.4)) : base;
    // A provider that told us how long to wait outranks our own cadence: going
    // back early only spends the account's remaining quota on another refusal.
    const standDown = (w.rateLimitedUntil ?? 0) - this.now();
    w.rateLimitedUntil = undefined;
    w.timer = setTimeout(() => void this.tick(w), Math.max(delay, standDown));
  }
  private async tick(w: Worker): Promise<void> {
    if (w.stopped || w.running) return;
    w.running = (async () => {
      try {
        const account = accounts.getAccountAny(this.ctx.db, w.accountId);
        if (!account) { this.stopAccount(w.accountId); return; }
        // Gate on the DB's own syncState every tick (not just the worker's first tick) so a
        // transient backfill failure gets retried on the next tick instead of silently falling
        // through to runIncremental against a null syncState forever. A state that still holds
        // a parked import counts as "backfill": the run picks up from that cursor.
        if (!account.syncState || hasParkedBackfill(account.syncState)) await runBackfill(this.ctx, account, w.provider);
        else await runIncremental(this.ctx, account, w.provider);
        w.failures = 0;
        // Graph push is a subscription that expires, not a socket, so the tick
        // doubles as its renewal timer. Cheap (no network) until renewal is due,
        // and it never throws, so a Graph outage cannot fail the poll.
        if (this.publicUrl && account.provider === 'microsoft' && hasGraphPushApi(w.provider)) {
          const fresh = accounts.getAccountAny(this.ctx.db, w.accountId);
          if (fresh) await ensureGraphSubscription(this.ctx, fresh, w.provider, this.publicUrl, this.now());
        }
        // Gmail's watch is the same shape of problem: a registration that lapses
        // after about a week, with no socket to hold in the meantime. Same rules
        // — no network until renewal is due, and it never throws, so a Pub/Sub
        // misconfiguration costs latency rather than the poll.
        if (this.googlePubsubTopic && account.provider === 'google' && hasGmailWatchApi(w.provider)) {
          const fresh = accounts.getAccountAny(this.ctx.db, w.accountId);
          if (fresh) await ensureGmailWatch(this.ctx, fresh, w.provider, this.googlePubsubTopic, this.now());
        }
      } catch (e) {
        if (e instanceof AuthExpiredError) { this.stopAccount(w.accountId); this.providers.delete(w.accountId); return; }
        if (e instanceof RateLimitedError) {
          // Being throttled is the provider pacing us, not the account failing:
          // it must not feed the failure backoff (which would keep growing for
          // as long as a big import keeps hitting the limit, and would leave
          // the account in escalating retreat once it finally succeeded).
          const wait = Math.min(e.retryAfterMs, RATE_LIMIT_MAX_STANDDOWN_MS);
          w.rateLimitedUntil = this.now() + wait;
          console.warn(`[mail] ${w.accountId} is rate limited by the provider — standing down for ${Math.round(wait / 1000)}s`);
          return;
        }
        w.failures = Math.min(w.failures + 1, 6);
        console.error(`[mail] sync failed for ${w.accountId}:`, (e as Error).message);
      }
    })();   // never rejects: every throwable path above is caught, so `await w.running` below is safe.
    try { await w.running; } finally {
      w.running = null;
      if (w.pokeRequested) { w.pokeRequested = false; void this.tick(w); }
      else this.schedule(w);
    }
  }
}
