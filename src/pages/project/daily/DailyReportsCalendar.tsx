// src/pages/project/daily/DailyReportsCalendar.tsx
// Month calendar for a project's daily reports, styled after the Time
// Keeping page's calendar (bg-raised card, accent-filled day cells, explicit
// text colors) so it reads correctly in both light and dark mode. On a crew's
// tab (one report per date): days with a report fill with the accent color and
// open that report; empty days start a new report dated to that cell. On the
// read-only All crews tab (no onCreate): a day lists every crew's report —
// crew name and man count — each opening its own, and empty days do nothing.
// Weeks start Sunday, matching the Time Keeping page. All date math stays in
// local time — `toISOString` would drift a day near midnight in
// negative-offset timezones.
import React, { useState } from 'react';
import { ChevronLeft, ChevronRight, Image as ImageIcon } from 'lucide-react';
import { DailyReportListItem } from '../../../utils/store';
import { manCountTotal } from './dailyReportForm';

const toDateStr = (d: Date): string => d.toLocaleDateString('en-CA'); // YYYY-MM-DD, local time

/**
 * Builds the day cells for a Sunday-start month calendar. `month` is
 * 0-based (0 = January). The result always covers whole weeks (length is a
 * multiple of 7), including muted leading/trailing days from adjacent months.
 */
export const monthGrid = (year: number, month: number): { dateStr: string; inMonth: boolean }[] => {
  const first = new Date(year, month, 1);
  // getDay(): 0=Sun..6=Sat — already the Sunday-start offset.
  const leadingCount = first.getDay();

  const lastOfMonth = new Date(year, month + 1, 0);
  const trailingCount = 6 - lastOfMonth.getDay();
  const totalDays = leadingCount + lastOfMonth.getDate() + trailingCount;

  const cells: { dateStr: string; inMonth: boolean }[] = [];
  for (let i = 0; i < totalDays; i++) {
    const d = new Date(year, month, 1 - leadingCount + i);
    cells.push({ dateStr: toDateStr(d), inMonth: d.getMonth() === month });
  }
  return cells;
};

const WEEKDAY_LABELS = ['S', 'M', 'T', 'W', 'T', 'F', 'S']; // Sunday-start, like Time Keeping
const MONTH_LABEL = (year: number, month: number) =>
  new Date(year, month, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

export interface DailyReportsCalendarProps {
  reports: DailyReportListItem[];
  onOpen: (id: string) => void;
  /** Starts a report on an empty day. Without it the calendar is the
   *  read-only All crews view (several reports per day, one per crew). */
  onCreate?: (dateStr: string) => void;
}

export const DailyReportsCalendar: React.FC<DailyReportsCalendarProps> = ({ reports, onOpen, onCreate }) => {
  const today = new Date();
  const todayStr = toDateStr(today);
  const [year, setYear] = useState(today.getFullYear());
  const [month, setMonth] = useState(today.getMonth());

  // Every report of each date, in the order given (the server lists one
  // date's reports in crew tab order). A crew's tab has at most one per date.
  const byDate = new Map<string, DailyReportListItem[]>();
  for (const r of reports) {
    const list = byDate.get(r.reportDate);
    if (list) list.push(r); else byDate.set(r.reportDate, [r]);
  }

  const goPrev = () => { const d = new Date(year, month - 1, 1); setYear(d.getFullYear()); setMonth(d.getMonth()); };
  const goNext = () => { const d = new Date(year, month + 1, 1); setYear(d.getFullYear()); setMonth(d.getMonth()); };
  const goToday = () => { setYear(today.getFullYear()); setMonth(today.getMonth()); };

  const cells = monthGrid(year, month);

  return (
    <div data-testid="daily-calendar" className="rounded-2xl border border-edge bg-raised p-4">
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-ink">{MONTH_LABEL(year, month)}</h2>
        <div className="flex items-center gap-1">
          <button type="button" onClick={goToday} className="rounded-md px-2 py-1 text-xs font-medium text-ink-soft transition-colors hover:bg-hover hover:text-ink">
            Today
          </button>
          <button type="button" onClick={goPrev} aria-label="Previous month" className="rounded-lg p-1.5 text-ink-soft transition-colors hover:bg-hover hover:text-ink">
            <ChevronLeft size={16} />
          </button>
          <button type="button" onClick={goNext} aria-label="Next month" className="rounded-lg p-1.5 text-ink-soft transition-colors hover:bg-hover hover:text-ink">
            <ChevronRight size={16} />
          </button>
        </div>
      </div>

      <div className="mb-1 grid grid-cols-7 gap-1">
        {WEEKDAY_LABELS.map((w, i) => (
          <div key={i} className="py-1 text-center text-[10px] font-bold uppercase tracking-wider text-ink-faint">{w}</div>
        ))}
      </div>

      <div className="grid grid-cols-7 gap-1">
        {cells.map(({ dateStr, inMonth }) => {
          if (!onCreate) return <AllCrewsDay key={dateStr} dateStr={dateStr} inMonth={inMonth} isToday={dateStr === todayStr} reports={byDate.get(dateStr) ?? []} onOpen={onOpen} />;
          const report = byDate.get(dateStr)?.[0];
          const isToday = dateStr === todayStr;
          const day = Number(dateStr.slice(-2));
          const crew = report ? manCountTotal(report.manCounts) : 0;

          return (
            <button
              key={dateStr}
              type="button"
              data-testid={`daily-calendar-day-${dateStr}`}
              data-report={report ? 'true' : undefined}
              aria-label={report ? `Open daily report for ${dateStr}` : `Create daily report for ${dateStr}`}
              onClick={() => report ? onOpen(report.id) : onCreate(dateStr)}
              className={`flex min-h-14 flex-col items-center justify-center gap-0.5 rounded-lg border p-1 text-[11px] font-medium transition-all sm:min-h-20 ${
                report
                  ? 'bg-accent-500 text-white'
                  : inMonth
                  ? 'bg-raised text-ink'
                  : 'bg-sunken/50 text-ink opacity-50'
              } ${
                isToday
                  ? report ? 'border-white/70' : 'border-accent-400 dark:border-accent-500'
                  : 'border-transparent'
              } hover:border-accent-300 dark:hover:border-accent-700`}
            >
              <span className="text-sm leading-none">{day}</span>
              {report && (
                <span className="hidden flex-col items-center gap-0.5 text-[9px] leading-tight text-white/90 sm:flex">
                  {report.photoCount > 0 && (
                    <span className="inline-flex items-center gap-1"><ImageIcon size={10} />{report.photoCount}</span>
                  )}
                  {crew > 0 && <span>{crew} men</span>}
                </span>
              )}
            </button>
          );
        })}
      </div>
    </div>
  );
};

// One day of the All crews calendar: the day number, then a chip per crew's
// report — crew name, and on wider screens its man count — that opens it. A
// div, not a button: each chip is its own button. Nothing to start here, so
// an empty day is inert.
const AllCrewsDay: React.FC<{
  dateStr: string; inMonth: boolean; isToday: boolean;
  reports: DailyReportListItem[]; onOpen: (id: string) => void;
}> = ({ dateStr, inMonth, isToday, reports, onOpen }) => (
  <div
    data-testid={`daily-calendar-day-${dateStr}`}
    data-report={reports.length ? 'true' : undefined}
    className={`flex min-h-14 min-w-0 flex-col gap-0.5 rounded-lg border p-1 text-[11px] font-medium sm:min-h-20 ${
      inMonth ? 'bg-raised text-ink' : 'bg-sunken/50 text-ink opacity-50'
    } ${isToday ? 'border-accent-400 dark:border-accent-500' : 'border-transparent'}`}
  >
    <span className="text-center text-sm leading-none">{Number(dateStr.slice(-2))}</span>
    {reports.map(r => {
      const crew = manCountTotal(r.manCounts);
      const name = r.crewName || 'Crew';
      return (
        <button
          key={r.id}
          type="button"
          data-testid={`daily-calendar-entry-${r.id}`}
          aria-label={`Open ${name}'s daily report for ${dateStr}`}
          title={crew > 0 ? `${name} · ${crew} men` : name}
          onClick={() => onOpen(r.id)}
          className="w-full min-w-0 truncate rounded bg-accent-500 px-1 py-0.5 text-left text-[9px] leading-tight text-white transition-colors hover:bg-accent-600"
        >
          {name}
          {crew > 0 && <span className="hidden sm:inline"> · {crew} men</span>}
        </button>
      );
    })}
  </div>
);
