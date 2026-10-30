// src/pages/settings/ClaudeUsagePanel.tsx — the Usage part of Settings › AI Sheet Reading.
//
// Two things side by side. The Claude plan's limits (5-hour and weekly), as
// Anthropic reports them with each call: these cover the whole account
// (claude.ai, Claude Code and this app), and Anthropic does not say how much
// of them each app used. Next to each, what this app's scans used in that same
// window. Below, the scans' own totals by period: pages, tokens, and their
// value at API prices (what an API key would pay).
import React, { useCallback, useEffect, useState } from 'react';
import { RefreshCw } from 'lucide-react';
import { Button } from '../../components/ui';
import { claudeApi, type ClaudeSource, type ClaudeUsage, type LimitWindow, type UsageTotals } from '../../utils/aiSheets';

const fmtTokens = (n: number) =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 10_000 ? `${Math.round(n / 1000)}k` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
const fmtUsd = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`);
const tokensOf = (t: UsageTotals) => t.inputTokens + t.outputTokens + t.cacheReadTokens + t.cacheWriteTokens;
const pagesText = (n: number) => `${n} page${n === 1 ? '' : 's'}`;

function fmtReset(ms: number, now: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const sameDay = d.toDateString() === new Date(now).toDateString();
  return sameDay ? time : `${d.toLocaleDateString([], { weekday: 'short' })} ${time}`;
}

const Limit: React.FC<{ label: string; window?: LimitWindow; scans: UsageTotals | null; now: number; testId: string }> = ({ label, window: w, scans, now, testId }) => {
  if (!w || w.utilization === null) return null;
  const pct = Math.round(w.utilization * 100);
  const tone = pct >= 90 ? 'bg-red-500' : pct >= 70 ? 'bg-amber-500' : 'bg-accent-500';
  return (
    <div className="space-y-1.5" data-testid={testId}>
      <div className="flex items-baseline justify-between gap-3 text-sm">
        <span className="font-medium text-ink">{label}</span>
        <span className="text-ink-soft tabular-nums">
          {pct}% used{w.resetsAt ? ` · resets ${fmtReset(w.resetsAt, now)}` : ''}
        </span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-sunken">
        <div role="progressbar" aria-label={label} aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}
          className={`h-full rounded-full ${tone}`} style={{ width: `${Math.min(100, pct)}%` }} />
      </div>
      {scans && (
        <p className="text-xs text-ink-soft">
          Page scans in this window: {pagesText(scans.pages)} · {fmtTokens(tokensOf(scans))} tokens
        </p>
      )}
    </div>
  );
};

export const ClaudeUsagePanel: React.FC<{ source: ClaudeSource | null; refreshKey?: number }> = ({ source, refreshKey }) => {
  const [usage, setUsage] = useState<ClaudeUsage | null>(null);
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try { setUsage(await claudeApi.usage()); setFailed(false); } catch { setFailed(true); } finally { setLoading(false); }
  }, []);
  useEffect(() => { load(); }, [load, refreshKey]);

  if (failed) return <p className="text-sm text-ink-soft">Usage could not be loaded.</p>;
  if (!usage) return null;
  const now = Date.now();
  const plan = usage.plan;
  const hasPlan = [plan?.fiveHour, plan?.sevenDay].some(w => w && w.utilization !== null);
  const apiKey = source === 'apiKey';
  const rows: Array<[string, UsageTotals]> = [
    ['Today', usage.today], ['Last 7 days', usage.last7Days], ['This month', usage.thisMonth], ['All time', usage.allTime],
  ];

  return (
    <div className="space-y-4" data-testid="claude-usage">
      <div className="flex items-center justify-between gap-3">
        <p className="text-sm font-semibold text-ink">Usage</p>
        <Button size="sm" variant="ghost" disabled={loading} onClick={load} aria-label="Refresh usage">
          <RefreshCw size={14} className={loading ? 'animate-spin' : ''} /> Refresh
        </Button>
      </div>

      {apiKey ? (
        <p className="text-xs text-ink-soft">With an API key there are no plan limits: each page is billed to your platform.claude.com account, roughly as shown below.</p>
      ) : hasPlan ? (
        <div className="space-y-3">
          <Limit label="5-hour limit" window={plan!.fiveHour} scans={usage.inFiveHourWindow} now={now} testId="claude-limit-5h" />
          <Limit label="Weekly limit" window={plan!.sevenDay} scans={usage.inSevenDayWindow} now={now} testId="claude-limit-7d" />
          <p className="text-xs text-ink-faint">
            Your Claude plan’s limits cover everything on your account (claude.ai, Claude Code and this app), as Anthropic reported them with the last page scan at {new Date(plan!.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}. Anthropic does not say how much of that each app used; the page-scan lines show this app’s part.
          </p>
        </div>
      ) : (
        <p className="text-xs text-ink-soft">Your plan’s 5-hour and weekly limits show here after the next page scan or Test connection: Anthropic reports them with each call.</p>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm" data-testid="claude-usage-table">
          <thead>
            <tr className="text-left text-xs text-ink-soft">
              <th className="py-1.5 pr-3 font-medium">Page scans</th>
              <th className="py-1.5 pr-3 font-medium text-right">Pages</th>
              <th className="py-1.5 pr-3 font-medium text-right">Tokens</th>
              <th className="py-1.5 font-medium text-right">{apiKey ? 'Cost' : 'At API prices'}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(([label, t]) => (
              <tr key={label} className="border-t border-edge">
                <td className="py-1.5 pr-3 text-ink">{label}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums text-ink">{t.pages}</td>
                <td className="py-1.5 pr-3 text-right tabular-nums text-ink">{fmtTokens(tokensOf(t))}</td>
                <td className="py-1.5 text-right tabular-nums text-ink">{fmtUsd(t.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!apiKey && (
        <p className="text-xs text-ink-faint">“At API prices” is what the same page scans would cost with an API key; a subscription is not billed per page.</p>
      )}
    </div>
  );
};
