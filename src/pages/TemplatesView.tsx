import React, { useEffect, useState } from 'react';
import { Plus, Trash2, Edit2, Layout, Hash, Ruler, Square } from 'lucide-react';
import { TakeoffTemplate, MeasurementType, CustomCost, CostType } from '../types';
import { getTemplates, saveTemplate, deleteTemplate } from '../utils/store';
import { v4 as uuidv4 } from 'uuid';
import { evaluateMathExpression, UNIT_LABELS } from '../utils/math';
import { Card } from '../components/ui';

const CustomCostRow: React.FC<{
  item: any;
  index: number;
  unitLabel: string;
  onChange: (index: number, updated: any) => void;
  onRemove: (index: number) => void;
}> = ({ item, index, unitLabel, onChange, onRemove }) => {
  return (
    <Card className="flex flex-col gap-2 p-3">
      <div className="flex gap-2 items-center">
        <select
          value={item.type || 'unit'}
          onChange={(e) => {
            const type = e.target.value as CostType;
            onChange(index, { ...item, type });
          }}
          className="text-xs border border-edge-strong rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-sunken font-medium text-ink"
        >
          <option value="flat">Flat Cost</option>
          <option value="yield">Cost by Yield</option>
          <option value="unit">Cost per {unitLabel}</option>
          <option value="amount_per_units">Amount per {unitLabel}s</option>
        </select>
        <div className="flex-1">
          <input
            type="text"
            value={item.name}
            onChange={(e) => onChange(index, { ...item, name: e.target.value })}
            placeholder="Item Name (e.g. Labor, Waste)"
            className="w-full text-xs border border-edge-strong rounded-lg px-2 py-1.5 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-raised text-ink placeholder:text-ink-faint"
          />
        </div>
        <button
          onClick={() => onRemove(index)}
          className="p-1.5 text-ink-faint hover:text-red-500 transition-colors"
        >
          <Trash2 size={14} />
        </button>
      </div>

      <div className="flex gap-3 items-center pl-1">
        {(!item.type || item.type === 'unit') && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold text-ink-faint uppercase">Cost per {unitLabel}</span>
            <div className="relative">
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-faint text-xs">$</span>
              <input
                type="text"
                value={item.costPerUnit || ''}
                onChange={(e) => onChange(index, { ...item, costPerUnit: e.target.value })}
                onBlur={() => {
                  if (item.costPerUnit?.toString().startsWith('=')) {
                    const result = evaluateMathExpression(item.costPerUnit.toString());
                    if (result !== null) onChange(index, { ...item, costPerUnit: result.toString() });
                  }
                }}
                className="w-24 pl-5 pr-2 py-1 text-xs border border-edge-strong rounded-lg focus:ring-2 focus:ring-accent-500 outline-none bg-raised text-ink placeholder:text-ink-faint"
                placeholder="0.00"
              />
            </div>
          </div>
        )}

        {item.type === 'flat' && (
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-bold text-ink-faint uppercase">Flat Cost</span>
            <div className="relative">
              <span className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-faint text-xs">$</span>
              <input
                type="text"
                value={item.cost || ''}
                onChange={(e) => onChange(index, { ...item, cost: e.target.value })}
                onBlur={() => {
                  if (item.cost?.toString().startsWith('=')) {
                    const result = evaluateMathExpression(item.cost.toString());
                    if (result !== null) onChange(index, { ...item, cost: result.toString() });
                  }
                }}
                className="w-24 pl-5 pr-2 py-1 text-xs border border-edge-strong rounded-lg focus:ring-2 focus:ring-accent-500 outline-none bg-raised text-ink placeholder:text-ink-faint"
                placeholder="0.00"
              />
            </div>
          </div>
        )}

        {item.type === 'yield' && (
          <>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-ink-faint uppercase">Cost</span>
              <div className="relative">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-faint text-xs">$</span>
                <input
                  type="text"
                  value={item.cost || ''}
                  onChange={(e) => onChange(index, { ...item, cost: e.target.value })}
                  onBlur={() => {
                    if (item.cost?.toString().startsWith('=')) {
                      const result = evaluateMathExpression(item.cost.toString());
                      if (result !== null) onChange(index, { ...item, cost: result.toString() });
                    }
                  }}
                  className="w-20 pl-5 pr-2 py-1 text-xs border border-edge-strong rounded-lg focus:ring-2 focus:ring-accent-500 outline-none bg-raised text-ink placeholder:text-ink-faint"
                  placeholder="0.00"
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-ink-faint uppercase">Yield (per {unitLabel})</span>
              <input
                type="text"
                value={item.yield || ''}
                onChange={(e) => onChange(index, { ...item, yield: e.target.value })}
                onBlur={() => {
                  if (item.yield?.toString().startsWith('=')) {
                    const result = evaluateMathExpression(item.yield.toString());
                    if (result !== null) onChange(index, { ...item, yield: result.toString() });
                  }
                }}
                className="w-20 px-2 py-1 text-xs border border-edge-strong rounded-lg focus:ring-2 focus:ring-accent-500 outline-none bg-raised text-ink"
                placeholder="1.0"
              />
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-ink-faint uppercase">Unit</span>
              <input
                type="text"
                value={item.unit || ''}
                onChange={(e) => onChange(index, { ...item, unit: e.target.value })}
                placeholder="e.g. bags"
                className="w-20 px-2 py-1 text-xs border border-edge-strong rounded-lg focus:ring-2 focus:ring-accent-500 outline-none bg-raised text-ink placeholder:text-ink-faint"
              />
            </div>
          </>
        )}

        {item.type === 'amount_per_units' && (
          <>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-ink-faint uppercase">Amount</span>
              <div className="relative">
                <span className="absolute left-2 top-1/2 -translate-y-1/2 text-ink-faint text-xs">$</span>
                <input
                  type="text"
                  value={item.amount || ''}
                  onChange={(e) => onChange(index, { ...item, amount: e.target.value })}
                  onBlur={() => {
                    if (item.amount?.toString().startsWith('=')) {
                      const result = evaluateMathExpression(item.amount.toString());
                      if (result !== null) onChange(index, { ...item, amount: result.toString() });
                    }
                  }}
                  className="w-20 pl-5 pr-2 py-1 text-xs border border-edge-strong rounded-lg focus:ring-2 focus:ring-accent-500 outline-none bg-raised text-ink placeholder:text-ink-faint"
                  placeholder="0.00"
                />
              </div>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-ink-faint uppercase">Per</span>
              <input
                type="text"
                value={item.perUnits || ''}
                onChange={(e) => onChange(index, { ...item, perUnits: e.target.value })}
                onBlur={() => {
                  if (item.perUnits?.toString().startsWith('=')) {
                    const result = evaluateMathExpression(item.perUnits.toString());
                    if (result !== null) onChange(index, { ...item, perUnits: result.toString() });
                  }
                }}
                className="w-16 px-2 py-1 text-xs border border-edge-strong rounded-lg focus:ring-2 focus:ring-accent-500 outline-none bg-raised text-ink placeholder:text-ink-faint"
                placeholder="1"
              />
              <span className="text-[10px] font-bold text-ink-faint uppercase">{unitLabel}s</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[10px] font-bold text-ink-faint uppercase">Unit</span>
              <input
                type="text"
                value={item.unit || ''}
                onChange={(e) => onChange(index, { ...item, unit: e.target.value })}
                placeholder="e.g. bags"
                className="w-20 px-2 py-1 text-xs border border-edge-strong rounded-lg focus:ring-2 focus:ring-accent-500 outline-none bg-raised text-ink placeholder:text-ink-faint"
              />
            </div>
          </>
        )}
      </div>
    </Card>
  );
};

export const TemplatesView: React.FC = () => {
  const [templates, setTemplates] = useState<TakeoffTemplate[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showModal, setShowModal] = useState(false);
  const [editingTemplate, setEditingTemplate] = useState<TakeoffTemplate | null>(null);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [templateToDelete, setTemplateToDelete] = useState<string | null>(null);

  // Form state
  const [name, setName] = useState('');
  const [type, setType] = useState<MeasurementType>('length');
  const [color, setColor] = useState('#3b82f6');
  const [unit, setUnit] = useState('');
  const [costPerUnit, setCostPerUnit] = useState<string>('');
  const [isAdvancedCost, setIsAdvancedCost] = useState(false);
  const [customCosts, setCustomCosts] = useState<any[]>([]);

  useEffect(() => {
    loadTemplates();
  }, []);

  const loadTemplates = async () => {
    setIsLoading(true);
    const data = await getTemplates();
    setTemplates(data);
    setIsLoading(false);
  };

  const resetForm = () => {
    setName('');
    setType('length');
    setColor('#3b82f6');
    setUnit('');
    setCostPerUnit('');
    setIsAdvancedCost(false);
    setCustomCosts([]);
    setEditingTemplate(null);
  };

  const handleCreateClick = () => {
    resetForm();
    setShowModal(true);
  };

  const handleEditClick = (template: TakeoffTemplate) => {
    setEditingTemplate(template);
    setName(template.name);
    setType(template.type);
    setColor(template.color);
    setUnit(template.unit || '');
    setCostPerUnit(template.costPerUnit?.toString() || '');
    setIsAdvancedCost(template.isAdvancedCost || false);
    setCustomCosts(template.customCosts?.map(c => ({
      ...c,
      costPerUnit: c.costPerUnit?.toString() || '0',
      cost: c.cost?.toString() || '0',
      yield: c.yield?.toString() || '1',
      amount: c.amount?.toString() || '0',
      perUnits: c.perUnits?.toString() || '1'
    })) || []);
    setShowModal(true);
  };

  const handleSave = async () => {
    if (!name) return;

    const template: TakeoffTemplate = {
      id: editingTemplate?.id || uuidv4(),
      name,
      type,
      color,
      unit: unit || undefined,
      costPerUnit: !isAdvancedCost && costPerUnit !== '' ? (evaluateMathExpression(costPerUnit) ?? 0) : undefined,
      isAdvancedCost,
      customCosts: isAdvancedCost ? customCosts.map(c => ({
        ...c,
        costPerUnit: evaluateMathExpression(c.costPerUnit?.toString() || '0') ?? 0,
        cost: evaluateMathExpression(c.cost?.toString() || '0') ?? 0,
        yield: evaluateMathExpression(c.yield?.toString() || '1') ?? 1,
        amount: evaluateMathExpression(c.amount?.toString() || '0') ?? 0,
        perUnits: evaluateMathExpression(c.perUnits?.toString() || '1') ?? 1
      })) : undefined,
      createdAt: editingTemplate?.createdAt || Date.now(),
    };

    await saveTemplate(template);
    setShowModal(false);
    loadTemplates();
  };

  const handleDelete = (id: string) => {
    setTemplateToDelete(id);
    setShowDeleteConfirm(true);
  };

  const confirmDelete = async () => {
    if (templateToDelete) {
      await deleteTemplate(templateToDelete);
      loadTemplates();
      setShowDeleteConfirm(false);
      setTemplateToDelete(null);
    }
  };

  const getTypeIcon = (type: MeasurementType) => {
    switch (type) {
      case 'length': return <Ruler size={16} />;
      case 'area': return <Square size={16} />;
      case 'count': return <Hash size={16} />;
      default: return null;
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-xl font-semibold text-ink">Takeoff Templates</h2>
          <p className="text-sm text-ink-soft">Pre-defined takeoff types for quick project setup</p>
        </div>
        <button
          onClick={handleCreateClick}
          className="flex items-center gap-2 bg-accent-600 hover:bg-accent-700 text-white px-4 py-2 rounded-lg font-medium transition-colors shadow-sm"
        >
          <Plus size={18} />
          New Template
        </button>
      </div>

      {isLoading ? (
        <div className="flex justify-center py-12">
          <div className="w-8 h-8 border-4 border-accent-600 border-t-transparent rounded-full animate-spin" />
        </div>
      ) : templates.length === 0 ? (
        <Card className="p-12 text-center">
          <Layout size={48} className="mx-auto text-ink-faint mb-4" />
          <h3 className="text-lg font-medium text-ink mb-2">No templates yet</h3>
          <p className="text-ink-soft mb-6">Create templates to reuse takeoff settings across projects.</p>
          <button
            onClick={handleCreateClick}
            className="inline-flex items-center gap-2 bg-accent-50 dark:bg-accent-900/20 text-accent-700 dark:text-accent-400 hover:bg-accent-100 dark:hover:bg-accent-900/20 px-4 py-2 rounded-lg font-medium transition-colors"
          >
            <Plus size={18} />
            Create Template
          </button>
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {templates.map(template => (
            <Card key={template.id} className="p-4 hover:border-accent-300 transition-colors group">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-3">
                  <div
                    className="w-4 h-4 rounded-full shadow-inner"
                    style={{ backgroundColor: template.color }}
                  />
                  <h3 className="font-semibold text-ink">{template.name}</h3>
                </div>
                <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                  <button
                    onClick={() => handleEditClick(template)}
                    className="p-1.5 text-ink-faint hover:text-accent-600 hover:bg-accent-50 dark:hover:bg-accent-900/20 rounded-lg transition-colors"
                  >
                    <Edit2 size={14} />
                  </button>
                  <button
                    onClick={() => handleDelete(template.id)}
                    className="p-1.5 text-ink-faint hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20 rounded-lg transition-colors"
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-y-2 text-xs">
                <div className="text-ink-soft flex items-center gap-1">
                  {getTypeIcon(template.type)}
                  <span className="capitalize">{template.type}</span>
                </div>
                <div className="text-ink font-medium text-right">
                  {template.unit || 'Default'}
                </div>
                <div className="text-ink-soft">Cost/Unit</div>
                <div className="text-ink font-medium text-right">
                  {template.isAdvancedCost && template.customCosts
                    ? `$${template.customCosts.reduce((sum, c) => sum + (c.costPerUnit || 0), 0).toFixed(2)}`
                    : template.costPerUnit ? `$${template.costPerUnit.toFixed(2)}` : '-'}
                </div>
              </div>

              {template.isAdvancedCost && template.customCosts && template.customCosts.length > 0 && (
                <div className="mt-3 pt-3 border-t border-edge">
                  <div className="text-[10px] font-bold text-ink-faint uppercase mb-1">Custom Costs</div>
                  <div className="space-y-1">
                    {template.customCosts.map(c => (
                      <div key={c.id} className="flex justify-between text-[10px]">
                        <span className="text-ink-soft truncate mr-2">{c.name}</span>
                        <span className="text-ink font-medium">${c.costPerUnit.toFixed(2)}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          ))}
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <Card className="shadow-xl w-full max-w-md overflow-hidden">
            <div className="p-6 border-b border-edge">
              <h3 className="text-lg font-semibold text-ink">Delete Template</h3>
            </div>
            <div className="p-6">
              <p className="text-ink-soft">
                Are you sure you want to delete this template? This action cannot be undone.
              </p>
            </div>
            <div className="p-6 border-t border-edge bg-sunken flex justify-end gap-3">
              <button
                onClick={() => { setShowDeleteConfirm(false); setTemplateToDelete(null); }}
                className="px-5 py-2.5 text-sm font-medium text-ink-soft hover:bg-hover rounded-xl transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={confirmDelete}
                className="px-5 py-2.5 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-xl transition-colors shadow-sm"
              >
                Delete Template
              </button>
            </div>
          </Card>
        </div>
      )}

      {showModal && (
        <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <Card className="shadow-xl w-full max-w-md overflow-hidden">
            <div className="p-6 border-b border-edge">
              <h3 className="text-lg font-semibold text-ink">
                {editingTemplate ? 'Edit Template' : 'Create Template'}
              </h3>
            </div>
            <div className="p-6 space-y-4 max-h-[70vh] overflow-y-auto">
              <div>
                <label className="block text-sm font-medium text-ink mb-1.5">Template Name</label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full border border-edge-strong rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-raised text-ink placeholder:text-ink-faint"
                  placeholder="e.g. Hardwood Flooring"
                  autoFocus
                />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-ink mb-1.5">Measurement Type</label>
                  <select
                    value={type}
                    onChange={(e) => setType(e.target.value as MeasurementType)}
                    className="w-full border border-edge-strong rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-raised text-ink"
                  >
                    <option value="length">Length</option>
                    <option value="area">Area</option>
                    <option value="count">Count</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-ink mb-1.5">Color</label>
                  <div className="flex items-center gap-2">
                    <input
                      type="color"
                      value={color}
                      onChange={(e) => setColor(e.target.value)}
                      className="h-11 w-full rounded-lg cursor-pointer border border-edge-strong p-1"
                    />
                  </div>
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
                    disabled={isAdvancedCost}
                    value={isAdvancedCost ? '' : costPerUnit}
                    onChange={(e) => setCostPerUnit(e.target.value)}
                    onBlur={() => {
                      if (costPerUnit.startsWith('=')) {
                        const result = evaluateMathExpression(costPerUnit);
                        if (result !== null) setCostPerUnit(result.toString());
                      }
                    }}
                    className="w-full border border-edge-strong rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500 disabled:bg-sunken disabled:text-ink-faint bg-raised text-ink placeholder:text-ink-faint"
                    placeholder={isAdvancedCost ? "Disabled in Advanced" : "0.00 or =95*40%"}
                  />
                </div>
              </div>

              <div className="flex items-center gap-2 py-2">
                <input
                  type="checkbox"
                  id="isAdvancedCost"
                  checked={isAdvancedCost}
                  onChange={(e) => setIsAdvancedCost(e.target.checked)}
                  className="w-4 h-4 text-accent-600 rounded border-edge-strong focus:ring-accent-500"
                />
                <label htmlFor="isAdvancedCost" className="text-sm font-medium text-ink cursor-pointer">
                  Advanced Costing (Custom Items)
                </label>
              </div>

              {isAdvancedCost && (
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
                        unitLabel={UNIT_LABELS[unit as keyof typeof UNIT_LABELS] || unit || 'unit'}
                        onChange={(index, updated) => {
                          const newCosts = [...customCosts];
                          newCosts[index] = updated;
                          setCustomCosts(newCosts);
                        }}
                        onRemove={(index) => {
                          setCustomCosts(customCosts.filter((_, i) => i !== index));
                        }}
                      />
                    ))}
                  </div>
                </div>
              )}
            </div>
            <div className="p-6 border-t border-edge bg-sunken flex justify-end gap-3">
              <button
                onClick={() => setShowModal(false)}
                className="px-5 py-2.5 text-sm font-medium text-ink-soft hover:bg-hover rounded-xl transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={!name}
                className="px-5 py-2.5 text-sm font-medium text-white bg-accent-600 hover:bg-accent-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl transition-colors shadow-sm"
              >
                {editingTemplate ? 'Save Changes' : 'Create Template'}
              </button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
};
