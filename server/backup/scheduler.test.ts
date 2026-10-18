import { describe, it, expect, beforeEach, vi } from 'vitest';
import type Database from 'better-sqlite3';
import { openDb } from '../db';
import { runMigrations } from '../migrations';
import { migrations } from '../migrationList';
import { readSchedule, writeSchedule } from './settings';
import { BackupScheduler, nextOccurrence } from './scheduler';
import fs from 'fs'; import os from 'os'; import path from 'path';

let db: Database.Database;
beforeEach(() => { db = openDb(':memory:'); runMigrations(db, fs.mkdtempSync(path.join(os.tmpdir(), 'ft-s-')), migrations); });

describe('nextOccurrence', () => {
  it('is today at hh:mm when still ahead, else tomorrow', () => {
    const base = new Date(2026, 8, 12, 1, 0, 0).getTime();
    expect(new Date(nextOccurrence(base, 2, 0)).getHours()).toBe(2);
    expect(nextOccurrence(base, 2, 0) - base).toBe(60 * 60_000);
    const later = new Date(2026, 8, 12, 3, 0, 0).getTime();
    expect(nextOccurrence(later, 2, 0) - later).toBe(23 * 60 * 60_000);
  });
});

const ON = (hour: number, minute: number) => ({ enabled: true, hour, minute });
const OFF = { enabled: false, hour: 2, minute: 0 };
const at = (d: number, h: number, m: number, sec = 0) => new Date(2026, 8, d, h, m, sec).getTime();
const quietTimers = { setTimeout: (() => ({ unref() {} })) as any, clearTimeout: (() => {}) as any };

describe('BackupScheduler', () => {
  it('does nothing while disabled; when enabled runs local then drive at the configured time and reschedules', async () => {
    let now = at(12, 1, 0);
    const timers: { fn: () => void; at: number }[] = [];
    const run = vi.fn(async (_t: 'local' | 'drive') => {});
    const s = new BackupScheduler({ db, run, hasDrive: () => true, now: () => now, setTimeout: ((fn: any, ms: number) => { timers.push({ fn, at: now + ms }); return { unref() {} } as any; }) as any, clearTimeout: (() => {}) as any });
    s.start();
    expect(s.nextRunAt('local')).toBeNull(); expect(s.nextRunAt('drive')).toBeNull(); expect(timers.length).toBe(1); // a poll timer, not a run
    writeSchedule(db, { local: ON(2, 0), drive: ON(2, 0) });
    // A restart with the schedule already on must publish the next runs at
    // once, not after the first poll a minute later.
    const restarted = new BackupScheduler({ db, run, hasDrive: () => true, now: () => now, ...quietTimers });
    restarted.start();
    expect(restarted.nextRunAt('local')).toBe(at(12, 2, 0));
    expect(restarted.nextRunAt('drive')).toBe(at(12, 2, 0));
    expect(run).not.toHaveBeenCalled();
    await s.tick();
    expect(s.nextRunAt('local')).toBe(at(12, 2, 0));
    now = at(12, 2, 0, 1);
    await s.tick();
    expect(run.mock.calls.map(c => c[0])).toEqual(['local', 'drive']);
    expect(s.nextRunAt('local')).toBe(at(13, 2, 0));
    expect(s.nextRunAt('drive')).toBe(at(13, 2, 0));
  });

  it('local and drive keep separate times, and each fires only at its own', async () => {
    let now = at(12, 1, 0);
    writeSchedule(db, { local: ON(2, 0), drive: ON(3, 30) });
    const run = vi.fn(async (_t: 'local' | 'drive') => {});
    const s = new BackupScheduler({ db, run, hasDrive: () => true, now: () => now, ...quietTimers });
    s.start();
    expect(s.nextRunAt('local')).toBe(at(12, 2, 0));
    expect(s.nextRunAt('drive')).toBe(at(12, 3, 30));

    now = at(12, 2, 0, 1);
    await s.tick();
    expect(run.mock.calls.map(c => c[0])).toEqual(['local']);
    expect(s.nextRunAt('local')).toBe(at(13, 2, 0));
    expect(s.nextRunAt('drive')).toBe(at(12, 3, 30));

    now = at(12, 3, 30, 1);
    await s.tick();
    expect(run.mock.calls.map(c => c[0])).toEqual(['local', 'drive']);
    expect(s.nextRunAt('drive')).toBe(at(13, 3, 30));
  });

  it('either one can be on alone', async () => {
    let now = at(12, 1, 0);
    writeSchedule(db, { local: OFF, drive: ON(2, 0) });
    const run = vi.fn(async (_t: 'local' | 'drive') => {});
    const s = new BackupScheduler({ db, run, hasDrive: () => true, now: () => now, ...quietTimers });
    s.start();
    expect(s.nextRunAt('local')).toBeNull();
    now = at(12, 2, 0, 1);
    await s.tick();
    expect(run.mock.calls.map(c => c[0])).toEqual(['drive']);

    writeSchedule(db, { local: ON(2, 0), drive: OFF });
    now = at(13, 2, 0, 1);
    await s.tick(); // the first tick after a change only works out the new time
    now = at(14, 2, 0, 1);
    await s.tick();
    expect(run.mock.calls.map(c => c[0])).toEqual(['drive', 'local']);
    expect(s.nextRunAt('drive')).toBeNull();
  });

  it('a Drive schedule is dormant while Drive is not connected', async () => {
    let now = at(12, 1, 0);
    let connected = false;
    writeSchedule(db, { local: OFF, drive: ON(2, 0) });
    const run = vi.fn(async () => {});
    const s = new BackupScheduler({ db, run, hasDrive: () => connected, now: () => now, ...quietTimers });
    s.start();
    expect(s.nextRunAt('drive')).toBeNull();
    now = at(12, 2, 0, 1);
    await s.tick();
    expect(run).not.toHaveBeenCalled();
    // Connecting later schedules the next occurrence, not a catch-up.
    connected = true;
    await s.tick();
    expect(run).not.toHaveBeenCalled();
    expect(s.nextRunAt('drive')).toBe(at(13, 2, 0));
  });

  it('a schedule saved before local and Drive were split drives both', async () => {
    db.prepare(`INSERT INTO settings (key, value) VALUES ('backup.schedule', ?)`).run(JSON.stringify({ enabled: true, hour: 2, minute: 0 }));
    expect(readSchedule(db)).toEqual({ local: ON(2, 0), drive: ON(2, 0) });
    // Saving local alone pins Drive where it was rather than dragging it along.
    writeSchedule(db, { local: ON(4, 15) });
    expect(readSchedule(db)).toEqual({ local: ON(4, 15), drive: ON(2, 0) });
  });

  it('holds a due run while another is in progress, and a failing local run still lets drive run', async () => {
    let now = at(12, 1, 59, 59);
    writeSchedule(db, { local: ON(2, 0), drive: ON(2, 0) });
    const run = vi.fn(async (t: string) => { if (t === 'local') throw new Error('disk'); });
    const s = new BackupScheduler({ db, run, hasDrive: () => true, now: () => now, ...quietTimers });
    await s.tick(); // sets due = today 02:00, not yet due
    const due = s.nextRunAt('local');
    expect(due).toBe(at(12, 2, 0));

    db.prepare(`INSERT INTO backup_runs (id, target, trigger, startedAt, status) VALUES ('x', 'local', 'manual', ?, 'running')`).run(now);
    now = at(12, 2, 0, 1);
    await s.tick();
    expect(run).not.toHaveBeenCalled();
    expect(s.nextRunAt('local')).toBe(due); // held: due is unchanged, not consumed
    expect(s.nextRunAt('drive')).toBe(due);

    db.prepare('DELETE FROM backup_runs').run();
    await s.tick();
    expect(run.mock.calls.map(c => c[0])).toEqual(['local', 'drive']);
  });

  it('a Drive run that comes due while local is still going waits for it, then fires', async () => {
    let now = at(12, 1, 0);
    writeSchedule(db, { local: ON(2, 0), drive: ON(2, 15) });
    const run = vi.fn(async (t: string) => { if (t === 'local') now = at(12, 2, 40); }); // local takes 40 minutes
    const s = new BackupScheduler({ db, run, hasDrive: () => true, now: () => now, ...quietTimers });
    s.start();
    now = at(12, 2, 0, 1);
    await s.tick();
    expect(run.mock.calls.map(c => c[0])).toEqual(['local', 'drive']);
    expect(s.nextRunAt('drive')).toBe(at(13, 2, 15));
  });

  it('does not fire a catch-up run when first ticked well after the configured time', async () => {
    const now = at(12, 3, 0);
    writeSchedule(db, { local: ON(2, 0), drive: ON(2, 30) });
    const run = vi.fn(async () => {});
    const s = new BackupScheduler({ db, run, hasDrive: () => true, now: () => now, ...quietTimers });
    s.start();
    await s.tick();
    expect(run).not.toHaveBeenCalled();
    expect(s.nextRunAt('local')).toBe(at(13, 2, 0));
    expect(s.nextRunAt('drive')).toBe(at(13, 2, 30));
  });
});
