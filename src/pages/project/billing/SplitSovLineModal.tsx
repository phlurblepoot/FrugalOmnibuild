// src/pages/project/billing/SplitSovLineModal.tsx
//
// Split one SOV item line into percentage-valued children under the original
// as a header (spec 2026-09-11 §Split). Percent math mirrors the server:
// basis points, last part takes the rounding remainder.
import React, { useEffect, useMemo, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { AiaSovLine, splitSovLine } from '../../../utils/store';
import { formatMoney } from '../../../utils/money';
import { useToast } from '../../../components/Toast';
import { Button, Input, Modal, NumberInput } from '../../../components/ui';

interface Part { description: string; percent: string }

const bpOf = (percent: string): number => {
  const n = Number(percent);
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
};

export function allocateCents(originalCents: number, percents: number[]): number[] {
  let allocated = 0;
  return percents.map((p, i) => {
    const last = i === percents.length - 1;
    const cents = last ? originalCents - allocated : Math.round(originalCents * Math.round(p * 100) / 10000);
    allocated += cents;
    return cents;
  });
}

const evenSplit = (n: number): string[] => {
  const each = Math.floor(10000 / n); // basis points
  const parts = Array.from({ length: n }, () => each);
  parts[n - 1] = 10000 - each * (n - 1);
  return parts.map(bp => (bp / 100).toFixed(2));
};

export const SplitSovLineModal: React.FC<{ line: AiaSovLine | null; onClose: () => void; onSplit: () => void; payAppCount?: number }> = ({ line, onClose, onSplit, payAppCount = 0 }) => {
  const { toast } = useToast();
  const [parts, setParts] = useState<Part[]>([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (line) setParts([{ description: 'Part 1', percent: '50' }, { description: 'Part 2', percent: '50' }]);
  }, [line?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const totalBp = parts.reduce((a, p) => a + bpOf(p.percent), 0);
  const remainingBp = 10000 - totalBp;
  const cents = useMemo(() => line ? allocateCents(line.scheduledValueCents, parts.map(p => Number(p.percent) || 0)) : [], [line, parts]);
  const valid = !!line && parts.length >= 2 && remainingBp === 0
    && parts.every(p => p.description.trim() !== '' && bpOf(p.percent) > 0);

  const setPart = (i: number, patch: Partial<Part>) => setParts(ps => ps.map((p, j) => j === i ? { ...p, ...patch } : p));

  const submit = async () => {
    if (!line || !valid) return;
    setBusy(true);
    try {
      await splitSovLine(line.id, line.version, parts.map(p => ({ description: p.description.trim(), percent: Number(p.percent) })));
      toast(`Split into ${parts.length} lines`, { type: 'success' });
      onSplit();
      onClose();
    } catch (e) {
      toast(e instanceof Error && e.name === 'SovLockedError' ? 'Schedule of values is finalized'
        : e instanceof Error && e.name === 'ConflictError' ? 'Line changed elsewhere — reload'
        : 'Failed to split line', { type: 'error' });
    } finally { setBusy(false); }
  };

  return (
    <Modal open={!!line} onClose={onClose} title="Split line" width="md"
      footer={<>
        <Button variant="secondary" onClick={onClose}>Cancel</Button>
        <Button data-testid="split-submit" onClick={submit} disabled={!valid || busy}>{busy ? 'Splitting…' : 'Split'}</Button>
      </>}>
      {line && (
        <div className="space-y-3">
          <div className="flex items-baseline justify-between">
            <div className="font-medium text-ink">{line.description}</div>
            <div className="tabular-nums text-ink-soft">{formatMoney(line.scheduledValueCents)}</div>
          </div>
          <p className="text-xs text-ink-faint">The original becomes a header; each part below becomes an item line under it.</p>
          {payAppCount > 0 && (
            <p className="text-xs text-amber-600">This project has {payAppCount} pay application{payAppCount === 1 ? '' : 's'}. The new lines start with no billed progress; the original line's progress is not carried over.</p>
          )}
          <div className="space-y-2">
            {parts.map((p, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input data-testid="split-part-description" value={p.description} onChange={e => setPart(i, { description: e.target.value })} className="flex-1" aria-label={`Part ${i + 1} description`} />
                <NumberInput allowEmpty data-testid="split-part-percent" step="0.01" min="0" value={p.percent} onChange={e => setPart(i, { percent: e.target.value })} className="w-24 text-right" aria-label={`Part ${i + 1} percent`} />
                <span className="w-6 text-ink-faint">%</span>
                <span className="w-28 text-right tabular-nums text-ink-soft">{formatMoney(cents[i] ?? 0)}</span>
                <button onClick={() => setParts(ps => ps.filter((_, j) => j !== i))} disabled={parts.length <= 2} title="Remove part"
                  className="rounded-md p-1 text-ink-faint hover:bg-hover hover:text-red-600 disabled:opacity-40"><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between">
            <div className="flex gap-2">
              <Button size="sm" variant="secondary" data-testid="split-add-part" onClick={() => setParts(ps => [...ps, { description: `Part ${ps.length + 1}`, percent: '0' }])}><Plus size={14} />Add part</Button>
              <Button size="sm" variant="ghost" data-testid="split-even" onClick={() => setParts(ps => evenSplit(ps.length).map((pct, i) => ({ ...ps[i], percent: pct })))}>Even split</Button>
            </div>
            <div data-testid="split-remaining" className={`text-sm tabular-nums ${remainingBp === 0 ? 'text-green-600' : 'text-red-600'}`}>
              Remaining: {(remainingBp / 100).toFixed(2)}%
            </div>
          </div>
        </div>
      )}
    </Modal>
  );
};
