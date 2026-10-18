import React from 'react';
import { QuantityValue, SelectionSummary } from '../../utils/segmentValue';

// One labelled value: "SEGMENT / 420.00 sq ft · $1,470". The selected
// segment's value wears the canvas selection amber, like its label there. A
// multiplied value carries its math ("420.00 sq ft × 4 = 1680.00 sq ft"), so
// it may wrap on a phone-width bar rather than run off it.
function Stat({ label, value, highlight, testId }: {
  label: string;
  value: QuantityValue;
  highlight?: boolean;
  testId?: string;
}) {
  return (
    <div data-testid={testId} className="flex flex-col items-start leading-tight">
      <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">{label}</span>
      <span className={`text-sm font-semibold sm:whitespace-nowrap ${highlight ? 'px-1.5 rounded-md bg-amber-400 text-amber-950' : 'text-ink'}`}>
        {value.quantity}
        {value.dollars && (
          <span className={highlight ? undefined : 'text-emerald-600 dark:text-emerald-400'}> · {value.dollars}</span>
        )}
      </span>
      {value.length && <span className="text-[10px] text-ink-soft whitespace-nowrap">Length: {value.length}</span>}
    </div>
  );
}

// Fixed readout for the canvas selection, in HTML so it reads the same at any
// zoom. It stacks just above PdfCanvas's zoom toolbar (bottom-20 on phones,
// bottom-6 from md) and only takes pointer events on its own footprint.
// Several multi-selected measurements show a count, as the sidebar does.
export function SelectionInfoBar({ summary, multiCount }: {
  summary: SelectionSummary | null;
  multiCount: number;
}) {
  const placement = 'absolute left-1/2 -translate-x-1/2 bottom-[8.5rem] md:bottom-20 z-30 w-max max-w-[calc(100%-2rem)]';

  if (multiCount > 0) {
    return (
      <div
        data-testid="selection-info-bar"
        className={`${placement} rounded-full border border-amber-200 dark:border-amber-700/30 bg-amber-50 dark:bg-amber-900/40 px-4 py-2 text-sm font-semibold text-amber-800 dark:text-amber-300 shadow-lg`}
      >
        {multiCount} selected
      </div>
    );
  }
  if (!summary) return null;

  const isCount = summary.countOnPage !== undefined;
  return (
    <div
      data-testid="selection-info-bar"
      className={`${placement} glass-panel border border-edge rounded-xl shadow-lg px-3 py-2 flex flex-wrap items-center gap-x-5 gap-y-1.5`}
    >
      <div className="flex flex-col min-w-0 max-w-[16rem] leading-tight">
        <span className="text-sm font-semibold text-ink truncate">{summary.measurementName}</span>
        <span className="flex items-center gap-1.5 text-xs text-ink-soft min-w-0">
          <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: summary.color }} />
          <span className="truncate">{summary.takeoffName ?? 'Ungrouped'}</span>
        </span>
      </div>
      {summary.segment && (
        <Stat label={summary.segment.label} value={summary.segment.value} highlight testId="selection-info-segment" />
      )}
      <Stat label={isCount ? 'Marker' : 'Measurement total'} value={summary.total} testId="selection-info-total" />
      {isCount && (
        <div className="flex flex-col items-start leading-tight">
          <span className="text-[10px] font-semibold uppercase tracking-wide text-ink-faint">On this page</span>
          <span className="text-sm font-semibold text-ink whitespace-nowrap">{summary.countOnPage} each</span>
        </div>
      )}
    </div>
  );
}
