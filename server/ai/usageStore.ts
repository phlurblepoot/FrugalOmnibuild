// What Claude sheet reading has used, for Settings › AI Sheet Reading.
//
// Every call's own token use comes back with its result (the Agent SDK's
// modelUsage, including its price at API list rates), so the app knows exactly
// what its scans used. A subscription's limits are another matter: Anthropic
// reports them with each call as "% of the 5-hour window and of the week used,
// and when each resets", for the whole account (claude.ai, Claude Code and this
// app together). The plan does not say how much of that % this app used, so
// Settings shows the account's % next to what scans used inside the same
// windows. Kept in data/claude-usage.json.
import fs from 'fs';
import path from 'path';

export type UsageKind = 'read' | 'match' | 'transcribe' | 'test';

export interface CallUsage {
  kind: UsageKind;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** Price at API list rates (what an API key pays). */
  costUsd: number;
}

export interface LimitWindow {
  /** Share of the window used, 0..1, for the whole account. */
  utilization: number | null;
  /** When the window resets (ms since epoch). */
  resetsAt: number | null;
  status?: string;
}

export interface PlanLimits {
  /** When Anthropic last reported them (ms since epoch). */
  at: number;
  status?: string;
  fiveHour?: LimitWindow;
  sevenDay?: LimitWindow;
}

export interface UsageTotals {
  pages: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  costUsd: number;
}

export interface UsageSummary {
  today: UsageTotals;
  last7Days: UsageTotals;
  thisMonth: UsageTotals;
  allTime: UsageTotals;
  /** The plan's limits as last reported, or null (API key, or no call yet). */
  plan: PlanLimits | null;
  /** What scans used inside the plan's current windows. */
  inFiveHourWindow: UsageTotals | null;
  inSevenDayWindow: UsageTotals | null;
}

interface CallRecord extends UsageTotals { at: number; }

interface StoredFile {
  /** Per local day (YYYY-MM-DD). */
  days?: Record<string, UsageTotals>;
  /** Each call of the last 8 days, for the plan's 5-hour and 7-day windows. */
  recent?: CallRecord[];
  plan?: PlanLimits | null;
}

const FIVE_HOURS = 5 * 3600_000;
const SEVEN_DAYS = 7 * 86400_000;
const KEEP_RECENT = 8 * 86400_000;
const KEEP_DAYS = 800;

const zero = (): UsageTotals => ({ pages: 0, calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 });
const add = (into: UsageTotals, u: UsageTotals): UsageTotals => {
  for (const k of Object.keys(into) as Array<keyof UsageTotals>) into[k] += u[k] ?? 0;
  return into;
};
const dayKey = (t: number) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const num = (v: unknown): number => (typeof v === 'number' && isFinite(v) ? v : 0);

/** A window from the SDK's rate_limit_event (`unifiedWindows.five_hour` etc.):
 *  utilization 0..1 and resetsAt in seconds. */
function windowFrom(raw: unknown): LimitWindow | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const w = raw as { utilization?: unknown; resetsAt?: unknown; status?: unknown };
  const utilization = typeof w.utilization === 'number' && isFinite(w.utilization) ? Math.max(0, Math.min(1, w.utilization)) : null;
  const resetsAt = typeof w.resetsAt === 'number' && isFinite(w.resetsAt) ? w.resetsAt * 1000 : null;
  if (utilization === null && resetsAt === null) return undefined;
  return { utilization, resetsAt, ...(typeof w.status === 'string' ? { status: w.status } : {}) };
}

/** The plan's limits from a rate_limit_event's `rate_limit_info`, or null. */
export function planLimitsFrom(info: unknown, at = Date.now()): PlanLimits | null {
  if (!info || typeof info !== 'object') return null;
  const i = info as { status?: unknown; rateLimitType?: unknown; utilization?: unknown; resetsAt?: unknown; unifiedWindows?: Record<string, unknown> };
  const windows = i.unifiedWindows && typeof i.unifiedWindows === 'object' ? i.unifiedWindows : {};
  let fiveHour = windowFrom(windows.five_hour);
  let sevenDay = windowFrom(windows.seven_day);
  // Older CLIs report only the window nearest its limit.
  if (!fiveHour && i.rateLimitType === 'five_hour') fiveHour = windowFrom(i);
  if (!sevenDay && i.rateLimitType === 'seven_day') sevenDay = windowFrom(i);
  if (!fiveHour && !sevenDay) return null;
  return { at, ...(typeof i.status === 'string' ? { status: i.status } : {}), ...(fiveHour ? { fiveHour } : {}), ...(sevenDay ? { sevenDay } : {}) };
}

/** Sums an Agent SDK result's `modelUsage` (one entry per model that ran). */
export function usageFromModelUsage(kind: UsageKind, model: string, modelUsage: unknown): CallUsage {
  const u: CallUsage = { kind, model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 };
  for (const m of Object.values(modelUsage && typeof modelUsage === 'object' ? modelUsage : {}) as any[]) {
    u.inputTokens += num(m?.inputTokens);
    u.outputTokens += num(m?.outputTokens);
    u.cacheReadTokens += num(m?.cacheReadInputTokens);
    u.cacheWriteTokens += num(m?.cacheCreationInputTokens);
    u.costUsd += num(m?.costUSD);
  }
  return u;
}

export interface UsageStore {
  record(call: CallUsage, at?: number): void;
  recordPlan(plan: PlanLimits): void;
  summary(now?: number): UsageSummary;
}

export function createUsageStore(dataDir: string): UsageStore {
  const file = path.join(dataDir, 'claude-usage.json');
  const read = (): StoredFile => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')) as StoredFile; } catch { return {}; }
  };
  const write = (data: StoredFile): void => {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(data));
    } catch (e) {
      console.warn('[ai] could not save usage', e);
    }
  };

  return {
    record(call, at = Date.now()) {
      const data = read();
      const totals: UsageTotals = {
        pages: call.kind === 'read' ? 1 : 0, calls: 1,
        inputTokens: call.inputTokens, outputTokens: call.outputTokens,
        cacheReadTokens: call.cacheReadTokens, cacheWriteTokens: call.cacheWriteTokens,
        costUsd: call.costUsd,
      };
      const days = data.days ?? {};
      days[dayKey(at)] = add(days[dayKey(at)] ?? zero(), totals);
      const keys = Object.keys(days).sort();
      for (const k of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete days[k];
      const recent = (data.recent ?? []).filter(r => at - r.at < KEEP_RECENT);
      recent.push({ at, ...totals });
      write({ ...data, days, recent });
    },

    recordPlan(plan) {
      write({ ...read(), plan });
    },

    summary(now = Date.now()) {
      const data = read();
      const days = data.days ?? {};
      const today = dayKey(now);
      const month = today.slice(0, 7);
      const weekAgo = dayKey(now - 6 * 86400_000);
      const sum = (pick: (k: string) => boolean) =>
        Object.entries(days).filter(([k]) => pick(k)).reduce((t, [, v]) => add(t, v), zero());
      const recent = data.recent ?? [];
      const plan = data.plan ?? null;
      const inWindow = (w: LimitWindow | undefined, length: number): UsageTotals | null => {
        if (!w?.resetsAt) return null;
        const start = w.resetsAt - length;
        return recent.filter(r => r.at >= start && r.at <= w.resetsAt!).reduce((t, r) => add(t, r), zero());
      };
      // A window that has since reset says nothing about the current one.
      const live = (w: LimitWindow | undefined) => (w?.resetsAt && w.resetsAt > now ? w : undefined);
      const current: PlanLimits | null = plan
        ? { ...plan, fiveHour: live(plan.fiveHour), sevenDay: live(plan.sevenDay) }
        : null;
      return {
        today: sum(k => k === today),
        last7Days: sum(k => k >= weekAgo && k <= today),
        thisMonth: sum(k => k.startsWith(month)),
        allTime: sum(() => true),
        plan: current,
        inFiveHourWindow: inWindow(current?.fiveHour, FIVE_HOURS),
        inSevenDayWindow: inWindow(current?.sevenDay, SEVEN_DAYS),
      };
    },
  };
}
