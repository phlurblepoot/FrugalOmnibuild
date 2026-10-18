import React, { useState, useEffect } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { MeasurementTakeoff, TakeoffTemplate, Project } from '../types';
import { evaluateMathExpression, UNIT_LABELS } from '../utils/math';

// ── Private sub-component ────────────────────────────────────────────────────

const CustomCostRow: React.FC<{
  item: any;
  index: number;
  unitLabel: string;
  onChange: (index: number, updated: any) => void;
  onRemove: (index: number) => void;
}> = ({ item, index, unitLabel, onChange, onRemove }) => {
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
      <div className="flex gap-2 items-center">
        <select
          value={item.type}
          onChange={(e) => onChange(index, { ...item, type: e.target.value as any })}
          className="text-xs border border-edge-strong rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-sunken text-ink"
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
          className="flex-1 text-xs border border-edge-strong rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-raised text-ink"
        />
        <button
          onClick={() => onRemove(index)}
          className="p-1.5 text-ink-faint hover:text-red-500 transition-colors"
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div className="flex gap-2 items-center pl-2 border-l-2 border-accent-100 dark:border-accent-800">
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
                className="w-24 text-xs border border-edge-strong rounded-lg pl-5 pr-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-raised text-ink"
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
                className="w-20 text-xs border border-edge-strong rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-raised text-ink"
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
                className="w-20 text-xs border border-edge-strong rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-raised text-ink"
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
                  className="w-24 text-xs border border-edge-strong rounded-lg pl-5 pr-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-raised text-ink"
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
                className="w-24 text-xs border border-edge-strong rounded-lg pl-5 pr-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-raised text-ink"
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
                  className="w-20 text-xs border border-edge-strong rounded-lg pl-5 pr-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-raised text-ink"
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
                className="w-16 text-xs border border-edge-strong rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-raised text-ink"
              />
              <span className="text-[10px] text-ink-soft">{unitLabel}s</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-ink-faint uppercase">Unit:</span>
              <input
                type="text"
                value={item.unit || ''}
                onChange={(e) => onChange(index, { ...item, unit: e.target.value })}
                placeholder="e.g. days"
                className="w-20 text-xs border border-edge-strong rounded-lg px-2 py-1 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-raised text-ink"
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
};

// ── Main component ───────────────────────────────────────────────────────────

interface NewTakeoffModalProps {
  open: boolean;
  onClose: () => void;
  project: Project;
  templates: TakeoffTemplate[];
  onCreateTakeoff: (takeoff: MeasurementTakeoff) => Promise<void>;
}

export const NewTakeoffModal: React.FC<NewTakeoffModalProps> = ({
  open,
  onClose,
  project,
  templates,
  onCreateTakeoff,
}) => {
  const [name, setName] = useState('');
  const [color, setColor] = useState('#3b82f6');
  const [type, setType] = useState<'length' | 'area' | 'count'>('length');
  const [unit, setUnit] = useState('');
  const [costPerUnit, setCostPerUnit] = useState('');
  const [isAdvanced, setIsAdvanced] = useState(false);
  const [customCosts, setCustomCosts] = useState<any[]>([]);
  const [pricePackage, setPricePackage] = useState('');
  const [selectedTemplateId, setSelectedTemplateId] = useState('');
  const [showPkgSuggestions, setShowPkgSuggestions] = useState(false);

  useEffect(() => {
    if (!open) {
      setName('');
      setColor('#3b82f6');
      setType('length');
      setUnit('');
      setCostPerUnit('');
      setIsAdvanced(false);
      setCustomCosts([]);
      setPricePackage('');
      setSelectedTemplateId('');
      setShowPkgSuggestions(false);
    }
  }, [open]);

  const handleTemplateChange = (templateId: string) => {
    setSelectedTemplateId(templateId);
    const template = templates.find(t => t.id === templateId);
    if (!template) return;
    setName(template.name);
    if (template.type !== 'scale') {
      setType(template.type as 'length' | 'area' | 'count');
    }
    setColor(template.color);
    setUnit(template.unit || '');
    setCostPerUnit(template.costPerUnit?.toString() || '');
    setIsAdvanced(template.isAdvancedCost || false);
    setCustomCosts(
      (template.customCosts || []).map(c => ({
        ...c,
        cost: c.cost?.toString() || '0',
        yield: (c as any).yield?.toString() || '0',
        costPerUnit: c.costPerUnit?.toString() || '0',
        amount: (c as any).amount?.toString() || '0',
        perUnits: (c as any).perUnits?.toString() || '0',
      }))
    );
  };

  const handleSubmit = async () => {
    if (!name.trim()) return;

    const newTakeoff: MeasurementTakeoff = {
      id: uuidv4(),
      name: name.trim(),
      color,
      type,
      unit: unit || undefined,
      costPerUnit:
        !isAdvanced && costPerUnit !== ''
          ? (evaluateMathExpression(costPerUnit) ?? 0)
          : undefined,
      isAdvancedCost: isAdvanced || undefined,
      customCosts: isAdvanced
        ? customCosts.map(c => ({
            ...c,
            cost:        evaluateMathExpression(c.cost?.toString()        || '') ?? 0,
            yield:       evaluateMathExpression(c.yield?.toString()       || '') ?? 0,
            costPerUnit: evaluateMathExpression(c.costPerUnit?.toString() || '') ?? 0,
            amount:      evaluateMathExpression(c.amount?.toString()      || '') ?? 0,
            perUnits:    evaluateMathExpression(c.perUnits?.toString()    || '') ?? 0,
          }))
        : undefined,
      pricePackage: pricePackage.trim() || undefined,
    };

    await onCreateTakeoff(newTakeoff);
  };

  if (!open) return null;

  const unitLabel = UNIT_LABELS[unit as keyof typeof UNIT_LABELS] || unit || (type === 'area' ? 'sq ft' : type === 'length' ? 'ft' : 'ea');
  const existingPackages = Array.from(new Set(project.takeoffs.map(t => t.pricePackage).filter((p): p is string => !!p)));
  const filteredPackages = existingPackages.filter(p => !pricePackage || p.toLowerCase().includes(pricePackage.toLowerCase()));

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-raised rounded-2xl shadow-xl w-full max-w-md overflow-hidden">
        <div className="p-6 border-b border-edge">
          <h3 className="text-lg font-semibold text-ink">Create Measurement Takeoff</h3>
        </div>

        <div className="p-6 space-y-4 max-h-[60vh] overflow-y-auto">
          {templates.length > 0 && (
            <div>
              <label className="block text-sm font-medium text-ink mb-1.5">Use Template (Optional)</label>
              <select
                value={selectedTemplateId}
                onChange={(e) => handleTemplateChange(e.target.value)}
                className="w-full border border-edge-strong rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-raised text-ink"
              >
                <option value="">Select a template...</option>
                {templates.map(t => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </select>
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-ink mb-1.5">Takeoff Name</label>
            <input
              data-testid="takeoff-name-input"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full border border-edge-strong rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-raised text-ink"
              placeholder="e.g. Hardwood Flooring"
              autoFocus
            />
          </div>

          <div className="relative">
            <label className="block text-sm font-medium text-ink mb-1.5">
              Price Package <span className="text-ink-faint font-normal">(optional)</span>
            </label>
            <input
              type="text"
              value={pricePackage}
              onChange={(e) => { setPricePackage(e.target.value); setShowPkgSuggestions(true); }}
              onFocus={() => setShowPkgSuggestions(true)}
              onBlur={() => setTimeout(() => setShowPkgSuggestions(false), 150)}
              className="w-full border border-edge-strong rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-raised text-ink"
              placeholder="e.g. Phase 1, Exterior, Base Bid"
              autoComplete="off"
            />
            {showPkgSuggestions && filteredPackages.length > 0 && (
              <ul className="absolute z-10 left-0 right-0 mt-1 bg-raised border border-edge-strong rounded-xl shadow-lg overflow-hidden">
                {filteredPackages.map(pkg => (
                  <li
                    key={pkg}
                    onMouseDown={() => { setPricePackage(pkg); setShowPkgSuggestions(false); }}
                    className="px-4 py-2.5 text-sm text-ink hover:bg-accent-50 dark:hover:bg-accent-900/20 cursor-pointer"
                  >
                    {pkg}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-ink mb-1.5">Measurement Type</label>
              <select
                value={type}
                onChange={(e) => {
                  setType(e.target.value as 'length' | 'area' | 'count');
                  setUnit('');
                }}
                className="w-full border border-edge-strong rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-raised text-ink"
              >
                <option value="length">Length</option>
                <option value="area">Area</option>
                <option value="count">Count</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-ink mb-1.5">Color</label>
              <input
                type="color"
                value={color}
                onChange={(e) => setColor(e.target.value)}
                className="h-11 w-full rounded-lg cursor-pointer border border-edge-strong p-1"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-ink mb-1.5">Unit</label>
              <select
                value={unit}
                onChange={(e) => setUnit(e.target.value)}
                className="w-full border border-edge-strong rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-raised text-ink"
              >
                <option value="">Default (Scale Unit)</option>
                {type === 'length' && (
                  <>
                    <option value="in">Inches (in)</option>
                    <option value="ft">Feet (ft)</option>
                    <option value="yd">Yards (yd)</option>
                    <option value="cm">Centimeters (cm)</option>
                    <option value="m">Meters (m)</option>
                  </>
                )}
                {type === 'area' && (
                  <>
                    <option value="sqin">Square Inches (sq in)</option>
                    <option value="sqft">Square Feet (sq ft)</option>
                    <option value="sqyd">Square Yards (sq yd)</option>
                    <option value="sqcm">Square Centimeters (sq cm)</option>
                    <option value="sqm">Square Meters (sq m)</option>
                  </>
                )}
                {type === 'count' && (
                  <option value="each">Each</option>
                )}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-ink mb-1.5">Cost Per Unit ($)</label>
              <input
                type="text"
                disabled={isAdvanced}
                value={isAdvanced ? '' : costPerUnit}
                onChange={(e) => setCostPerUnit(e.target.value)}
                onBlur={() => {
                  if (costPerUnit.startsWith('=')) {
                    const result = evaluateMathExpression(costPerUnit);
                    if (result !== null) setCostPerUnit(result.toString());
                  }
                }}
                className="w-full border border-edge-strong rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-raised text-ink disabled:bg-sunken disabled:text-ink-faint"
                placeholder={isAdvanced ? 'Disabled in Advanced' : '0.00 or =95*40%'}
              />
            </div>
          </div>

          <div className="flex items-center gap-2 py-2">
            <input
              type="checkbox"
              id="newTakeoffAdvanced"
              checked={isAdvanced}
              onChange={(e) => setIsAdvanced(e.target.checked)}
              className="w-4 h-4 text-accent-600 rounded border-edge-strong focus:ring-accent-500"
            />
            <label htmlFor="newTakeoffAdvanced" className="text-sm font-medium text-ink cursor-pointer">
              Advanced Costing (Custom Items)
            </label>
          </div>

          {isAdvanced && (
            <div className="mt-4 pt-4 border-t border-edge">
              <div className="flex items-center justify-between mb-3">
                <h4 className="text-xs font-bold text-ink-faint uppercase tracking-wider">Advanced Costing</h4>
                <button
                  onClick={() => setCustomCosts([...customCosts, { id: uuidv4(), name: '', type: 'unit', costPerUnit: '0' }])}
                  className="text-[10px] flex items-center gap-1 text-accent-600 hover:text-accent-700 font-bold uppercase tracking-tight"
                >
                  <Plus size={12} />
                  Add Cost Item
                </button>
              </div>
              <div className="space-y-3">
                {customCosts.map((cost, idx) => (
                  <CustomCostRow
                    key={cost.id}
                    item={cost}
                    index={idx}
                    unitLabel={unitLabel}
                    onChange={(index, updated) => {
                      const updated2 = [...customCosts];
                      updated2[index] = updated;
                      setCustomCosts(updated2);
                    }}
                    onRemove={(index) => setCustomCosts(customCosts.filter((_, i) => i !== index))}
                  />
                ))}
              </div>
            </div>
          )}
        </div>

        <div className="p-6 border-t border-edge bg-sunken/50 flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-5 py-2.5 text-sm font-medium text-ink-soft hover:bg-hover active:scale-95 rounded-xl transition-all"
          >
            Cancel
          </button>
          <button
            data-testid="btn-create-takeoff"
            onClick={handleSubmit}
            disabled={!name.trim()}
            className="px-5 py-2.5 text-sm font-medium text-white bg-accent-600 hover:bg-accent-700 disabled:opacity-50 disabled:cursor-not-allowed active:scale-95 rounded-xl transition-all shadow-sm"
          >
            Create Takeoff
          </button>
        </div>
      </div>
    </div>
  );
};
