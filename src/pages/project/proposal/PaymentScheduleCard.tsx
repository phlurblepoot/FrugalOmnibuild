// src/pages/project/proposal/PaymentScheduleCard.tsx
// Optional draw schedule ("50% on start, 50% on completion"). A null schedule
// means the proposal prints no schedule at all — an empty array means "yes,
// there is one, it just has no rows yet" — so the include checkbox toggles
// between null and [].
import React, { useEffect, useState } from 'react';
import { Plus, Trash2, TriangleAlert } from 'lucide-react';
import type { PaymentScheduleRow } from '../../../utils/store';
import { Button, Card, CardBody, CardHeader, Checkbox, Input, NumberInput, Select } from '../../../components/ui';
import { formatCurrency } from './proposalGenerator';
import { scheduleAmountCents, toCents } from './proposalMath';

const money = (cents: number) => formatCurrency(cents / 100);

// Percent and dollar values are both edited as free text so a half-typed
// "12." doesn't get snapped back to 12 mid-keystroke; the parsed value flows
// up on every change and the text re-syncs only when the value changes from
// somewhere else (a mode switch, a row removal, a reload).
const NumberField: React.FC<{
  value: number | null;
  fmt: (v: number) => string;
  parse: (text: string) => number | null;
  ariaLabel: string;
  disabled: boolean;
  onValueChange: (v: number | null) => void;
}> = ({ value, fmt, parse, ariaLabel, disabled, onValueChange }) => {
  const [text, setText] = useState(() => (value === null ? '' : fmt(value)));
  // Re-sync only when the value changed from OUTSIDE this field. An emptied
  // box reads as 0 upstream (a row must keep its % / $ mode while you retype),
  // so an empty text and a 0 value are treated as the same thing here —
  // otherwise clearing the field would immediately snap a "0" back into it.
  useEffect(() => {
    setText(prev => ((parse(prev) ?? 0) === (value ?? 0) ? prev : value === null ? '' : fmt(value)));
  }, [value]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <NumberInput allowEmpty
      className="w-24 text-right"
      step="0.01"
      aria-label={ariaLabel}
      value={text}
      disabled={disabled}
      onChange={e => { setText(e.target.value); onValueChange(parse(e.target.value)); }}
    />
  );
};

// These are <NumberInput allowEmpty unstyled>, so the browser has already filtered out
// anything unparsable; an empty box is the only realistic "no value" case.
const parseNumber = (text: string): number | null => {
  if (!text.trim()) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
};

export const PaymentScheduleCard: React.FC<{
  schedule: PaymentScheduleRow[] | null;
  totalCents: number;
  readOnly: boolean;
  onChange: (schedule: PaymentScheduleRow[] | null) => void;
}> = ({ schedule, totalCents, readOnly, onChange }) => {
  const rows = schedule ?? [];
  const included = schedule !== null;

  const update = (i: number, patch: Partial<PaymentScheduleRow>) =>
    onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  const remove = (i: number) => onChange(rows.filter((_, idx) => idx !== i));
  // New rows are percentages — the common case, and a fresh 0% row leaves the
  // running total where it was instead of tripping the "≠ 100%" warning the
  // moment it appears. The first row starts at the whole job.
  const add = () => onChange([...rows, { description: '', percent: rows.length === 0 ? 100 : 0, amountCents: null }]);

  const scheduled = rows.reduce((s, r) => s + scheduleAmountCents(r, totalCents), 0);
  const percentRows = rows.filter(r => r.percent != null);
  const percentSum = percentRows.reduce((s, r) => s + (r.percent ?? 0), 0);
  const percentOff = percentRows.length > 0 && Math.abs(percentSum - 100) > 0.001;

  return (
    <Card data-testid="payment-schedule">
      <CardHeader
        title="Payment schedule"
        actions={
          <Checkbox
            label="Include payment schedule"
            checked={included}
            disabled={readOnly}
            onChange={e => onChange(e.target.checked ? [] : null)}
          />
        }
      />
      {included && (
        <CardBody className="space-y-3">
          {rows.length === 0 && <p className="text-sm text-ink-faint">No rows yet. Add the draws this proposal bills against.</p>}
          {rows.map((row, i) => {
            const mode = row.percent != null ? 'percent' : 'amount';
            return (
              <div key={i} className="flex flex-wrap items-center gap-2">
                <Input
                  className="min-w-[10rem] flex-1"
                  aria-label="Milestone"
                  placeholder="Deposit on signing"
                  value={row.description}
                  disabled={readOnly}
                  onChange={e => update(i, { description: e.target.value })}
                />
                <Select
                  className="w-20"
                  aria-label="Amount type"
                  value={mode}
                  disabled={readOnly}
                  onChange={e => update(i, e.target.value === 'percent'
                    ? { percent: row.amountCents != null && totalCents > 0 ? Math.round(row.amountCents / totalCents * 1000) / 10 : 0, amountCents: null }
                    : { percent: null, amountCents: row.percent != null ? Math.round(totalCents * row.percent / 100) : 0 })}
                >
                  <option value="percent">%</option>
                  <option value="amount">$</option>
                </Select>
                {mode === 'percent' ? (
                  <NumberField
                    ariaLabel="Percent"
                    value={row.percent}
                    fmt={v => String(v)}
                    parse={parseNumber}
                    disabled={readOnly}
                    onValueChange={v => update(i, { percent: v ?? 0, amountCents: null })}
                  />
                ) : (
                  <NumberField
                    ariaLabel="Amount"
                    value={row.amountCents}
                    fmt={v => String(v / 100)}
                    parse={text => { const n = parseNumber(text); return n === null ? null : toCents(n); }}
                    disabled={readOnly}
                    onValueChange={v => update(i, { percent: null, amountCents: v ?? 0 })}
                  />
                )}
                <span className="w-28 text-right text-sm tabular-nums text-ink-soft">{money(scheduleAmountCents(row, totalCents))}</span>
                {!readOnly && (
                  <Button variant="ghost" size="sm" aria-label="Remove row" title="Remove row" onClick={() => remove(i)}><Trash2 size={14} /></Button>
                )}
              </div>
            );
          })}

          {!readOnly && <Button variant="secondary" onClick={add}><Plus size={14} />Add row</Button>}

          <div className="space-y-1 border-t border-edge pt-3 text-sm">
            <div className="flex justify-end gap-6">
              <span className="text-ink-faint">Scheduled: <span data-testid="schedule-total" className="text-ink">{money(scheduled)}</span></span>
              <span className="text-ink-faint">Proposal total: {money(totalCents)}</span>
            </div>
            {percentOff && (
              <p className="flex items-center justify-end gap-1 text-xs text-amber-600 dark:text-amber-400">
                <TriangleAlert size={12} />
                Percentages add up to {Math.round(percentSum * 10) / 10}%, not 100%.
              </p>
            )}
          </div>
        </CardBody>
      )}
    </Card>
  );
};
