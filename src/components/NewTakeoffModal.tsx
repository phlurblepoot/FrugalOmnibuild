import React, { useState, useEffect } from 'react';
import { Plus } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { MeasurementTakeoff, TakeoffTemplate, Project } from '../types';
import { evaluateMathExpression, UNIT_LABELS } from '../utils/math';
import { CustomCostRow, costLineForEditing } from './CustomCostRow';

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
      (template.customCosts || []).map(costLineForEditing)
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
                  onClick={() => setCustomCosts([...customCosts, { id: uuidv4(), name: '', type: 'unit', costPerUnit: '' }])}
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
                    unitPlaceholder="e.g. days"
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
