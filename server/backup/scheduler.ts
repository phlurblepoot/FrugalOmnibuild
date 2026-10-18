// server/backup/scheduler.ts — daily backups (spec §Scheduler). Local and
// Drive each have their own time. Polls the schedule settings each minute so a
// settings change needs no restart.
import type Database from 'better-sqlite3';
import { readSchedule, type BackupSchedule } from './settings';
import { isRunActive } from './snapshot';

export type ScheduledTarget = 'local' | 'drive';
// Checked in this order on every tick, so when both are due at once local
// goes first and Drive follows it.
const TARGETS: readonly ScheduledTarget[] = ['local', 'drive'];

export function nextOccurrence(now: number, hour: number, minute: number): number {
  const d = new Date(now); d.setHours(hour, minute, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}

export interface SchedulerDeps {
  db: Database.Database;
  run: (target: ScheduledTarget, trigger: 'schedule') => Promise<unknown>;
  hasDrive: () => boolean;
  now?: () => number; setTimeout?: typeof setTimeout; clearTimeout?: typeof clearTimeout;
}
const POLL_MS = 60_000;

interface Slot { due: number | null; lastFired: number | null }

export class BackupScheduler {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private slots: Record<ScheduledTarget, Slot> = { local: { due: null, lastFired: null }, drive: { due: null, lastFired: null } };
  private readonly now: () => number;
  constructor(private deps: SchedulerDeps) { this.now = deps.now ?? (() => Date.now()); }

  nextRunAt(target: ScheduledTarget): number | null { return this.slots[target].due; }

  /** A Drive schedule means nothing until Drive is connected. */
  private active(target: ScheduledTarget, s: BackupSchedule): boolean {
    return s.enabled && (target === 'local' || this.deps.hasDrive());
  }

  /** Computes the next runs straight away (without firing) so the status card
   *  does not read "Not scheduled" for the first minute after a restart. */
  start(): void {
    const all = readSchedule(this.deps.db);
    for (const t of TARGETS) if (this.active(t, all[t])) this.slots[t].due = nextOccurrence(this.now(), all[t].hour, all[t].minute);
    this.arm();
  }
  stop(): void { if (this.timer) (this.deps.clearTimeout ?? clearTimeout)(this.timer); this.timer = null; }
  private arm(): void {
    const st = this.deps.setTimeout ?? setTimeout;
    this.timer = st(() => { this.tick().catch(e => console.error('[backup] scheduler tick failed', e)); }, POLL_MS);
    (this.timer as any).unref?.();
  }

  async tick(): Promise<void> {
    try {
      // One at a time: a run is awaited before the next target is looked at,
      // with the clock and the schedule read afresh for it.
      for (const t of TARGETS) await this.tickTarget(t);
    } finally { this.arm(); }
  }

  private async tickTarget(t: ScheduledTarget): Promise<void> {
    const s = readSchedule(this.deps.db)[t];
    const slot = this.slots[t];
    if (!this.active(t, s)) { slot.due = null; return; }
    const now = this.now();
    if (slot.due === null || (slot.lastFired !== null && slot.due <= slot.lastFired)) slot.due = nextOccurrence(now, s.hour, s.minute);
    // schedule changed → recompute
    const expected = nextOccurrence(slot.due - 1, s.hour, s.minute);
    if (expected !== slot.due) slot.due = nextOccurrence(now, s.hour, s.minute);
    if (now < slot.due) return;
    // Any run in progress holds this one back without consuming it, so it
    // fires on the first tick after that run has finished.
    if (isRunActive(this.deps.db, 'local') || isRunActive(this.deps.db, 'drive')) { console.warn(`[backup] scheduled ${t} run waiting: a backup is still in progress`); return; }
    slot.lastFired = now;
    slot.due = nextOccurrence(now, s.hour, s.minute);
    try { await this.deps.run(t, 'schedule'); } catch (e) { console.error(`[backup] scheduled ${t === 'local' ? 'local' : 'Drive'} backup failed`, e); }
  }
}
