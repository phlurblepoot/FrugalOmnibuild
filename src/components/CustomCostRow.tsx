import React from 'react';
import { Trash2 } from 'lucide-react';
import { evaluateMathExpression } from '../utils/math';

export const CustomCostRow: React.FC<{
  item: any;
  index: number;
  unitLabel: string;
  onChange: (index: number, updated: any) => void;
  onRemove: (index: number) => void;
  unitPlaceholder?: string;
}> = ({ item, index, unitLabel, onChange, onRemove, unitPlaceholder = 'e.g. bags' }) => {
  const handleMathBlur = (field: string, value: string) => {
    if (value.startsWith('=')) {
      const result = evaluateMathExpression(value);
      if (result !== null) {
        onChange(index, { ...item, [field]: result.toString() });
      }
    }
  };

  return (
    <div className="flex flex-col gap-2 p-3 bg-raised rounded-lg border border-edge shadow-sm">
      <div className="flex flex-wrap gap-2 items-center">
        <select
          value={item.type}
          onChange={(e) => onChange(index, { ...item, type: e.target.value as any })}
          className="text-xs border border-edge-strong rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-sunken"
        >
          <option value="flat">Flat Cost</option>
          <option value="yield">Material Yield</option>
          <option value="unit">Cost per {unitLabel}</option>
          <option value="amount_per_units">Rate per {unitLabel}s</option>
        </select>
        <input
          type="text"
          value={item.name}
          onChange={(e) => onChange(index, { ...item, name: e.target.value })}
          placeholder="Line Name"
          className="flex-1 text-xs border border-edge-strong rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent-500"
        />
        <button
          onClick={() => onRemove(index)}
          className="p-1.5 text-ink-faint hover:text-red-500 transition-colors"
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div className="flex flex-wrap gap-2 items-center pl-2 border-l-2 border-accent-100">
        {item.type === 'flat' && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold text-ink-faint uppercase">Cost:</span>
            <div className="relative">
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-faint text-[10px]">$</span>
              <input
                type="text"
                value={item.cost || '0'}
                onChange={(e) => onChange(index, { ...item, cost: e.target.value })}
                onBlur={(e) => handleMathBlur('cost', e.target.value)}
                className="w-24 text-xs border border-edge-strong rounded-lg pl-5 pr-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500"
              />
            </div>
          </div>
        )}

        {item.type === 'yield' && (
          <>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-ink-faint uppercase">Yield:</span>
              <input
                type="text"
                value={item.yield || '0'}
                onChange={(e) => onChange(index, { ...item, yield: e.target.value })}
                onBlur={(e) => handleMathBlur('yield', e.target.value)}
                className="w-20 text-xs border border-edge-strong rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500"
              />
              <span className="text-[10px] text-ink-soft">{unitLabel} per unit</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-ink-faint uppercase">Unit:</span>
              <input
                type="text"
                value={item.unit || ''}
                onChange={(e) => onChange(index, { ...item, unit: e.target.value })}
                placeholder="e.g. bags"
                className="w-20 text-xs border border-edge-strong rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-ink-faint uppercase">Cost:</span>
              <div className="relative">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-faint text-[10px]">$</span>
                <input
                  type="text"
                  value={item.cost || '0'}
                  onChange={(e) => onChange(index, { ...item, cost: e.target.value })}
                  onBlur={(e) => handleMathBlur('cost', e.target.value)}
                  className="w-24 text-xs border border-edge-strong rounded-lg pl-5 pr-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500"
                />
              </div>
            </div>
          </>
        )}

        {item.type === 'unit' && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold text-ink-faint uppercase">Cost per {unitLabel}:</span>
            <div className="relative">
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-faint text-[10px]">$</span>
              <input
                type="text"
                value={item.costPerUnit || '0'}
                onChange={(e) => onChange(index, { ...item, costPerUnit: e.target.value })}
                onBlur={(e) => handleMathBlur('costPerUnit', e.target.value)}
                className="w-24 text-xs border border-edge-strong rounded-lg pl-5 pr-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500"
              />
            </div>
          </div>
        )}

        {item.type === 'amount_per_units' && (
          <>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-ink-faint uppercase">Amount:</span>
              <div className="relative">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-faint text-[10px]">$</span>
                <input
                  type="text"
                  value={item.amount || '0'}
                  onChange={(e) => onChange(index, { ...item, amount: e.target.value })}
                  onBlur={(e) => handleMathBlur('amount', e.target.value)}
                  className="w-20 text-xs border border-edge-strong rounded-lg pl-5 pr-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500"
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-ink-faint uppercase">Per:</span>
              <input
                type="text"
                value={item.perUnits || '0'}
                onChange={(e) => onChange(index, { ...item, perUnits: e.target.value })}
                onBlur={(e) => handleMathBlur('perUnits', e.target.value)}
                className="w-16 text-xs border border-edge-strong rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500"
              />
              <span className="text-[10px] text-ink-soft">{unitLabel}s</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-ink-faint uppercase">Unit:</span>
              <input
                type="text"
                value={item.unit || ''}
                onChange={(e) => onChange(index, { ...item, unit: e.target.value })}
                placeholder={unitPlaceholder}
                className="w-20 text-xs border border-edge-strong rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500"
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
};
