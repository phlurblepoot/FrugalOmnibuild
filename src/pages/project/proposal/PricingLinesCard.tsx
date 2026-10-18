// src/pages/project/proposal/PricingLinesCard.tsx
// The priced body of a proposal: takeoff-derived lines on top, hand-written
// lines under them, and the totals that the PDF prints. Fully controlled — the
// editor owns the ProposalLine[] and this card only ever calls onChange.
import React, { useEffect, useState } from 'react';
import { ArrowDown, ArrowUp, Plus, RotateCcw, Trash2, TriangleAlert } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import type { ProposalLine } from '../../../utils/store';
import { useConfirm } from '../../../components/ConfirmDialog';
import { Button, Card, CardBody, CardHeader, Checkbox, Input, NumberInput, Select } from '../../../components/ui';
import { formatCurrency, type TakeoffTotals } from './proposalGenerator';
import { isOverridden, lineFromTakeoff, measurementSummary, proposalTotals, toCents } from './proposalMath';
import type { ManualLineMemory } from './proposalPrefs';

const money = (cents: number) => formatCurrency(cents / 100);

// Amount fields are edited in dollars but stored in integer cents, so the
// input keeps its own text while focused and only converts on commit.
// The control is <NumberInput allowEmpty unstyled>, so the browser has already rejected
// anything that isn't a number by the time this runs — a cleared or unparsable
// field returns null and the caller restores the previous amount rather than
// silently pricing the line at $0.
const fmtAmount = (cents: number) => (cents / 100).toFixed(2);
const parseAmount = (text: string): number | null => {
  if (!text.trim()) return null;
  const n = Number(text);
  return Number.isFinite(n) ? toCents(n) : null;
};

const Group: React.FC<{ title: string; empty: string; count: number; children: React.ReactNode }> = ({ title, empty, count, children }) => (
  <div className="space-y-2">
    <h4 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">{title}</h4>
    {count === 0 && <p className="text-sm text-ink-faint">{empty}</p>}
    {children}
  </div>
);

const LineRow: React.FC<{
  line: ProposalLine;
  readOnly: boolean;
  missing: boolean;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onUpdate: (patch: Partial<ProposalLine>) => void;
  onRemove: () => void;
  onMove: (dir: -1 | 1) => void;
}> = ({ line, readOnly, missing, canMoveUp, canMoveDown, onUpdate, onRemove, onMove }) => {
  const confirm = useConfirm();
  const [amountText, setAmountText] = useState(() => fmtAmount(line.amountCents));

  // Re-sync when the amount changes from the outside (a Reset, a re-derive
  // after the takeoff moved, a reload). Typing is untouched — the effect only
  // fires when the committed cents actually differ.
  useEffect(() => { setAmountText(fmtAmount(line.amountCents)); }, [line.amountCents]);

  const overridden = isOverridden(line);
  const derived = line.derivedAmountCents;

  const commitAmount = async () => {
    if (readOnly) return;
    const next = parseAmount(amountText);
    if (next === null) { setAmountText(fmtAmount(line.amountCents)); return; }
    if (next === line.amountCents) { setAmountText(fmtAmount(next)); return; }
    // Pricing a takeoff line by hand is deliberate and slightly dangerous —
    // it silently decouples the proposal from the measured work — so it is
    // confirmed. The takeoff itself is never written to.
    // A takeoff line with no derived amount (an older row, or one whose
    // takeoff never produced a total) has nothing to diverge FROM: it is
    // edited freely, and isOverridden() likewise never calls it overridden.
    if (line.kind === 'takeoff' && derived !== null && next !== derived) {
      const ok = await confirm({
        title: 'Use a different amount?',
        message: `This proposal will show ${money(next)} instead of the takeoff amount ${money(derived)}. The takeoff itself is not changed.`,
        confirmLabel: 'Override',
      });
      if (!ok) { setAmountText(fmtAmount(line.amountCents)); return; }
    }
    onUpdate({ amountCents: next });
    setAmountText(fmtAmount(next));
  };

  return (
    <div
      data-testid={`pricing-line-${line.id}`}
      className={`rounded-lg border border-edge bg-sunken px-3 py-2 ${line.isAlternate ? 'border-l-4 border-l-amber-400' : ''}`}
    >
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="min-w-[10rem] flex-1"
          aria-label="Description"
          value={line.description}
          placeholder={line.kind === 'takeoff' ? 'Takeoff line' : 'Description'}
          disabled={readOnly}
          onChange={e => onUpdate({ description: e.target.value })}
        />
        <NumberInput allowEmpty
          className="w-32 text-right"
          aria-label="Amount"
          step="0.01"
          value={amountText}
          disabled={readOnly}
          onChange={e => setAmountText(e.target.value)}
          onBlur={() => { void commitAmount(); }}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); void commitAmount(); } }}
        />
        <label className="inline-flex items-center gap-1.5 text-xs text-ink-soft">
          <input
            type="checkbox"
            aria-label="Alternate"
            className="size-4 rounded border-edge-strong accent-accent-600"
            checked={line.isAlternate}
            disabled={readOnly}
            onChange={e => onUpdate({ isAlternate: e.target.checked })}
          />
          Alt
        </label>
        {!readOnly && (
          <div className="flex items-center">
            <Button variant="ghost" size="sm" aria-label="Move up" title="Move up" disabled={!canMoveUp} onClick={() => onMove(-1)}><ArrowUp size={14} /></Button>
            <Button variant="ghost" size="sm" aria-label="Move down" title="Move down" disabled={!canMoveDown} onClick={() => onMove(1)}><ArrowDown size={14} /></Button>
            <Button variant="ghost" size="sm" aria-label="Delete line" title="Delete line" onClick={onRemove}><Trash2 size={14} /></Button>
          </div>
        )}
      </div>
      {(line.measurementSummary || overridden || missing) && (
        <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 pl-1 text-xs">
          {line.measurementSummary && <span className="text-ink-faint">{line.measurementSummary}</span>}
          {overridden && derived !== null && (
            <span className="inline-flex items-center gap-1 text-amber-600 dark:text-amber-400">
              overridden (was {money(derived)})
              {!readOnly && (
                <Button variant="ghost" size="sm" className="h-6 min-h-0 px-1.5 py-0" onClick={() => onUpdate({ amountCents: derived })}>
                  <RotateCcw size={12} />Reset
                </Button>
              )}
            </span>
          )}
          {missing && (
            <span className="inline-flex items-center gap-1 text-red-600 dark:text-red-400">
              <TriangleAlert size={12} />
              This takeoff no longer exists
              {!readOnly && (
                <Button variant="ghost" size="sm" className="h-6 min-h-0 px-1.5 py-0" onClick={onRemove}>Remove line</Button>
              )}
            </span>
          )}
        </div>
      )}
    </div>
  );
};

export const PricingLinesCard: React.FC<{
  lines: ProposalLine[];
  onChange: (lines: ProposalLine[]) => void;
  readOnly: boolean;
  takeoffTotals: TakeoffTotals[];
  missingTakeoffIds: string[];
  showGrandTotal: boolean;
  onShowGrandTotalChange: (v: boolean) => void;
  lineLibrary: ManualLineMemory[];
}> = ({ lines, onChange, readOnly, takeoffTotals, missingTakeoffIds, showGrandTotal, onShowGrandTotalChange, lineLibrary }) => {
  const totals = proposalTotals(lines);
  const takeoffLines = lines.filter(l => l.kind === 'takeoff');
  const manualLines = lines.filter(l => l.kind === 'manual');

  // Array order IS the print order (the editor strips ids and sortOrder on
  // save and the server re-assigns from position), but sortOrder is kept
  // consistent with it anywhere the ORDER changes so nothing downstream can
  // read a stale number.
  const reorder = (next: ProposalLine[]) => onChange(next.map((l, i) => ({ ...l, sortOrder: i })));

  const update = (id: string, patch: Partial<ProposalLine>) => onChange(lines.map(l => (l.id === id ? { ...l, ...patch } : l)));
  const remove = (id: string) => reorder(lines.filter(l => l.id !== id));

  // Reordering stays inside a kind group — takeoff lines print above manual
  // ones — so a move swaps with the nearest neighbour of the same kind.
  const move = (id: string, dir: -1 | 1) => {
    const idx = lines.findIndex(l => l.id === id);
    if (idx < 0) return;
    const kind = lines[idx].kind;
    let j = idx + dir;
    while (j >= 0 && j < lines.length && lines[j].kind !== kind) j += dir;
    if (j < 0 || j >= lines.length) return;
    const next = [...lines];
    [next[idx], next[j]] = [next[j], next[idx]];
    reorder(next);
  };

  const availableTakeoffs = takeoffTotals.filter(t => !takeoffLines.some(l => l.takeoffId === t.id));

  // Picking takeoffs is a checklist, not a dropdown: a proposal usually wants
  // several of them, and a <select> forced one round-trip per takeoff (open,
  // pick, the list re-renders one shorter, open again).
  const [addingTakeoffs, setAddingTakeoffs] = useState(false);
  const [pickedTakeoffIds, setPickedTakeoffIds] = useState<Set<string>>(new Set());
  const closeTakeoffPicker = () => { setAddingTakeoffs(false); setPickedTakeoffIds(new Set()); };
  const togglePicked = (id: string) => setPickedTakeoffIds(prev => {
    const next = new Set(prev);
    if (!next.delete(id)) next.add(id);
    return next;
  });
  // ONE onChange with every new line appended — N separate addTakeoff() calls
  // would each read the same stale `lines` prop (the parent has not re-rendered
  // in between), so all but the last would be lost.
  const addPickedTakeoffs = () => {
    const chosen = availableTakeoffs.filter(t => pickedTakeoffIds.has(t.id));
    if (!chosen.length) return;
    reorder([
      ...lines,
      ...chosen.map((t, i) => ({ id: uuidv4(), sortOrder: lines.length + i, ...lineFromTakeoff(t) } as ProposalLine)),
    ]);
    closeTakeoffPicker();
  };
  const addManual = (mem?: ManualLineMemory) =>
    reorder([...lines, {
      id: uuidv4(), sortOrder: lines.length, kind: 'manual', takeoffId: null,
      description: mem?.description ?? '', amountCents: mem?.amountCents ?? 0,
      derivedAmountCents: null, measurementSummary: null, isAlternate: false,
    }]);

  const rowsFor = (group: ProposalLine[]) => group.map((l, i) => (
    <LineRow
      key={l.id}
      line={l}
      readOnly={readOnly}
      missing={!!l.takeoffId && missingTakeoffIds.includes(l.takeoffId)}
      canMoveUp={i > 0}
      canMoveDown={i < group.length - 1}
      onUpdate={patch => update(l.id, patch)}
      onRemove={() => remove(l.id)}
      onMove={dir => move(l.id, dir)}
    />
  ));

  return (
    <Card data-testid="pricing-lines">
      <CardHeader
        title="Pricing"
        actions={
          <Checkbox
            label="Show grand total"
            checked={showGrandTotal}
            disabled={readOnly}
            onChange={e => onShowGrandTotalChange(e.target.checked)}
          />
        }
      />
      <CardBody className="space-y-5">
        <Group title="Takeoff lines" empty="No takeoff lines. Add one from the project's takeoffs." count={takeoffLines.length}>
          {rowsFor(takeoffLines)}
          {!readOnly && availableTakeoffs.length > 0 && (
            addingTakeoffs ? (
              <div data-testid="add-takeoffs-panel" className="space-y-2 rounded-lg border border-edge bg-sunken p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h5 className="text-xs font-semibold uppercase tracking-wide text-ink-faint">Add takeoffs</h5>
                  <div className="flex items-center gap-3 text-xs">
                    <button type="button" className="font-medium text-accent-600 hover:underline"
                            onClick={() => setPickedTakeoffIds(new Set(availableTakeoffs.map(t => t.id)))}>
                      Select all
                    </button>
                    <button type="button" className="font-medium text-accent-600 hover:underline"
                            onClick={() => setPickedTakeoffIds(new Set())}>
                      Clear
                    </button>
                  </div>
                </div>
                <div className="max-h-60 space-y-0.5 overflow-y-auto">
                  {availableTakeoffs.map(t => (
                    <div key={t.id} className="flex items-center gap-2 rounded-md px-1 py-1 hover:bg-hover">
                      <span aria-hidden className="size-3 shrink-0 rounded-full border border-edge" style={{ backgroundColor: t.color }} />
                      <Checkbox
                        className="min-w-0 flex-1"
                        label={t.name}
                        checked={pickedTakeoffIds.has(t.id)}
                        onChange={() => togglePicked(t.id)}
                      />
                      <span className="shrink-0 text-xs text-ink-faint">{measurementSummary(t)}</span>
                    </div>
                  ))}
                </div>
                <div className="flex flex-wrap justify-end gap-2 border-t border-edge pt-2">
                  <Button variant="secondary" size="sm" onClick={closeTakeoffPicker}>Cancel</Button>
                  <Button size="sm" disabled={pickedTakeoffIds.size === 0} onClick={addPickedTakeoffs}>
                    Add {pickedTakeoffIds.size} takeoff{pickedTakeoffIds.size === 1 ? '' : 's'}
                  </Button>
                </div>
              </div>
            ) : (
              // aria-label stays "Add takeoff" (singular) — it is what the
              // pre-checklist <select> exposed, and existing callers/tests
              // reach the control by that name.
              <Button variant="secondary" size="sm" aria-label="Add takeoff" onClick={() => setAddingTakeoffs(true)}>
                <Plus size={14} />Add takeoffs
              </Button>
            )
          )}
        </Group>

        <Group title="Manual lines" empty="No manual lines." count={manualLines.length}>
          {rowsFor(manualLines)}
          {!readOnly && (
            <div className="flex flex-wrap items-center gap-2">
              <Button variant="secondary" onClick={() => addManual()}><Plus size={14} />Add manual line</Button>
              {lineLibrary.length > 0 && (
                <Select
                  className="max-w-xs"
                  aria-label="From library"
                  value=""
                  onChange={e => {
                    const m = lineLibrary[Number(e.target.value)];
                    if (m) addManual(m);
                  }}
                >
                  <option value="">From library…</option>
                  {lineLibrary.map((m, i) => <option key={i} value={i}>{m.description} — {money(m.amountCents)}</option>)}
                </Select>
              )}
            </div>
          )}
        </Group>

        <div className="flex flex-wrap justify-end gap-6 border-t border-edge pt-3 text-sm">
          {totals.alternateCents > 0 && <span className="text-ink-faint">Alternates: {money(totals.alternateCents)}</span>}
          <span className="font-semibold text-ink" data-testid="pricing-total">Total: {money(totals.totalCents)}</span>
        </div>
      </CardBody>
    </Card>
  );
};
