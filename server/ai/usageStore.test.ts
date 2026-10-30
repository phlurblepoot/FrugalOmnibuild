import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createUsageStore, planLimitsFrom, usageFromModelUsage, type CallUsage } from './usageStore';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-usage-')); });

const call = (over: Partial<CallUsage> = {}): CallUsage => ({
  kind: 'read', model: 'claude-opus-5-5', inputTokens: 15000, outputTokens: 400, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.07, ...over,
});
const at = (iso: string) => new Date(iso).getTime();

describe('usageFromModelUsage', () => {
  it('sums every model that ran, cost included', () => {
    expect(usageFromModelUsage('read', 'claude-opus-5-5', {
      'claude-opus-5-5': { inputTokens: 100, outputTokens: 10, cacheReadInputTokens: 5, cacheCreationInputTokens: 2, costUSD: 0.01 },
      'claude-fable-5-1': { inputTokens: 50, outputTokens: 5, costUSD: 0.02 },
    })).toEqual({ kind: 'read', model: 'claude-opus-5-5', inputTokens: 150, outputTokens: 15, cacheReadTokens: 5, cacheWriteTokens: 2, costUsd: 0.03 });
    expect(usageFromModelUsage('test', 'm', undefined).inputTokens).toBe(0);
  });
});

describe('planLimitsFrom', () => {
  it('reads both windows from a rate_limit_event (seconds → ms, 0..1)', () => {
    expect(planLimitsFrom({
      status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1000,
      unifiedWindows: { five_hour: { utilization: 0.34, resetsAt: 1000, status: 'allowed' }, seven_day: { utilization: 0.12, resetsAt: 9000 } },
    }, 5)).toEqual({ at: 5, status: 'allowed', fiveHour: { utilization: 0.34, resetsAt: 1_000_000, status: 'allowed' }, sevenDay: { utilization: 0.12, resetsAt: 9_000_000 } });
  });
  it('falls back to the one window an older CLI reports', () => {
    expect(planLimitsFrom({ status: 'allowed_warning', rateLimitType: 'seven_day', utilization: 0.9, resetsAt: 50 }, 1))
      .toEqual({ at: 1, status: 'allowed_warning', sevenDay: { utilization: 0.9, resetsAt: 50_000, status: 'allowed_warning' } });
  });
  it('is null when there is nothing to show', () => {
    expect(planLimitsFrom(undefined)).toBeNull();
    expect(planLimitsFrom({ status: 'allowed' })).toBeNull();
  });
});

describe('createUsageStore', () => {
  it('totals page scans by day, week, month and all time; only reads count as pages', () => {
    const s = createUsageStore(dir);
    s.record(call(), at('2026-09-30T12:00:00'));
    s.record(call(), at('2026-10-25T12:00:00'));
    s.record(call({ kind: 'match', inputTokens: 1000, outputTokens: 50, costUsd: 0.005 }), at('2026-10-30T09:00:00'));
    s.record(call(), at('2026-10-30T10:00:00'));
    const u = s.summary(at('2026-10-30T18:00:00'));
    expect(u.today).toMatchObject({ pages: 1, calls: 2, inputTokens: 16000, outputTokens: 450 });
    expect(u.today.costUsd).toBeCloseTo(0.075);
    expect(u.last7Days.pages).toBe(2);
    expect(u.thisMonth.pages).toBe(2);
    expect(u.allTime).toMatchObject({ pages: 3, calls: 4 });
  });

  it("shows the plan's windows with what scans used inside each", () => {
    const s = createUsageStore(dir);
    const now = at('2026-10-30T18:00:00');
    s.record(call(), now - 6 * 3600_000); // before the 5-hour window, inside the week
    s.record(call(), now - 3600_000);
    s.record(call(), now - 600_000);
    s.recordPlan({ at: now - 600_000, status: 'allowed',
      fiveHour: { utilization: 0.34, resetsAt: now + 2 * 3600_000 }, sevenDay: { utilization: 0.12, resetsAt: now + 3 * 86400_000 } });
    const u = s.summary(now);
    expect(u.plan?.fiveHour?.utilization).toBe(0.34);
    expect(u.inFiveHourWindow?.pages).toBe(2);
    expect(u.inSevenDayWindow?.pages).toBe(3);
  });

  it('drops a window that has since reset, rather than show a stale %', () => {
    const s = createUsageStore(dir);
    const now = at('2026-10-30T18:00:00');
    s.recordPlan({ at: now - 6 * 3600_000, fiveHour: { utilization: 0.9, resetsAt: now - 3600_000 }, sevenDay: { utilization: 0.4, resetsAt: now + 86400_000 } });
    const u = s.summary(now);
    expect(u.plan?.fiveHour).toBeUndefined();
    expect(u.inFiveHourWindow).toBeNull();
    expect(u.plan?.sevenDay?.utilization).toBe(0.4);
  });

  it('starts empty, survives a bad file, and keeps its data across instances', () => {
    expect(createUsageStore(dir).summary()).toMatchObject({ allTime: { pages: 0 }, plan: null, inFiveHourWindow: null });
    fs.writeFileSync(path.join(dir, 'claude-usage.json'), '{not json');
    const s = createUsageStore(dir);
    s.record(call());
    expect(createUsageStore(dir).summary().allTime.pages).toBe(1);
  });
});
