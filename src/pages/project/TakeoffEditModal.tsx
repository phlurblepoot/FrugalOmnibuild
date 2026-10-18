// src/pages/project/TakeoffEditModal.tsx
//
// Edit-takeoff modal extracted verbatim from ProjectView (Phase 5g Task 2).
// Behavior-preserving controlled component: ProjectView still owns all edit*
// state, the save handler, and the close action; this component only renders the
// modal JSX and wires inputs to the props it's given. NOT deduped with the
// CanvasView edit-takeoff modal — Phase 5e showed the two diverged.
import React from 'react';
import { Plus } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { MeasurementTakeoff } from '../../types';
import { UNIT_LABELS } from '../../utils/math';
import { CustomCostRow } from '../../components/CustomCostRow';
import { NumberInput } from '../../components/ui';

interface TakeoffEditModalProps {
  editingTakeoff: MeasurementTakeoff;
  editTakeoffName: string;
  setEditTakeoffName: React.Dispatch<React.SetStateAction<string>>;
  editTakeoffColor: string;
  setEditTakeoffColor: React.Dispatch<React.SetStateAction<string>>;
  editTakeoffUnit: string;
  setEditTakeoffUnit: React.Dispatch<React.SetStateAction<string>>;
  editTakeoffCostPerUnit: number | '';
  setEditTakeoffCostPerUnit: React.Dispatch<React.SetStateAction<number | ''>>;
  isEditTakeoffAdvanced: boolean;
  setIsEditTakeoffAdvanced: React.Dispatch<React.SetStateAction<boolean>>;
  editTakeoffCustomCosts: any[];
  setEditTakeoffCustomCosts: React.Dispatch<React.SetStateAction<any[]>>;
  editTakeoffPricePackage: string;
  setEditTakeoffPricePackage: React.Dispatch<React.SetStateAction<string>>;
  pricePackageOptions: (string | undefined)[];
  onSave: () => void;
  onClose: () => void;
}

export function TakeoffEditModal({
  editingTakeoff,
  editTakeoffName,
  setEditTakeoffName,
  editTakeoffColor,
  setEditTakeoffColor,
  editTakeoffUnit,
  setEditTakeoffUnit,
  editTakeoffCostPerUnit,
  setEditTakeoffCostPerUnit,
  isEditTakeoffAdvanced,
  setIsEditTakeoffAdvanced,
  editTakeoffCustomCosts,
  setEditTakeoffCustomCosts,
  editTakeoffPricePackage,
  setEditTakeoffPricePackage,
  pricePackageOptions,
  onSave,
  onClose,
}: TakeoffEditModalProps) {
  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50">
      <div className="bg-raised rounded-2xl shadow-xl w-full max-w-md overflow-hidden flex flex-col max-h-[90vh]">
        <div className="p-6 border-b border-edge">
          <h3 className="text-lg font-semibold text-ink">Edit Measurement Takeoff</h3>
        </div>
        <div className="p-6 space-y-4 max-h-[85vh] overflow-y-auto">
          <div>
            <label className="block text-sm font-medium text-ink mb-1.5">Takeoff Name</label>
            <input
              data-testid="edit-takeoff-name"
              type="text"
              value={editTakeoffName}
              onChange={(e) => setEditTakeoffName(e.target.value)}
              className="w-full border border-edge-strong rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500"
              placeholder="e.g. Hardwood Flooring"
              autoFocus
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-ink mb-1.5">
              Price Package <span className="text-ink-faint font-normal">(optional)</span>
            </label>
            <input
              type="text"
              list="price-package-options-edit"
              value={editTakeoffPricePackage}
              onChange={(e) => setEditTakeoffPricePackage(e.target.value)}
              className="w-full border border-edge-strong rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500"
              placeholder="e.g. Flooring Package"
            />
            <datalist id="price-package-options-edit">
              {Array.from(new Set(pricePackageOptions.filter(Boolean))).map(pkg => (
                <option key={pkg} value={pkg} />
              ))}
            </datalist>
            <p className="mt-1 text-xs text-ink-faint">Takeoffs with the same package name are grouped together.</p>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-ink mb-1.5">Measurement Type</label>
              <input
                type="text"
                value={editingTakeoff.type}
                disabled
                className="w-full border border-edge rounded-xl px-4 py-2.5 bg-sunken text-ink-soft capitalize"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-ink mb-1.5">Color</label>
              <div className="flex items-center gap-2">
                <input
                  type="color"
                  value={editTakeoffColor}
                  onChange={(e) => setEditTakeoffColor(e.target.value)}
                  className="h-11 w-full rounded-lg cursor-pointer border border-edge-strong p-1"
                />
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium text-ink mb-1.5">Unit</label>
              <select
                value={editTakeoffUnit}
                onChange={(e) => setEditTakeoffUnit(e.target.value)}
                className="w-full border border-edge-strong rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-raised text-ink"
              >
                <option value="">Default (Scale Unit)</option>
                {editingTakeoff.type === 'length' && (
                  <>
                    <option value="in">Inches (in)</option>
                    <option value="ft">Feet (ft)</option>
                    <option value="yd">Yards (yd)</option>
                    <option value="cm">Centimeters (cm)</option>
                    <option value="m">Meters (m)</option>
                  </>
                )}
                {editingTakeoff.type === 'area' && (
                  <>
                    <option value="sqin">Square Inches (sq in)</option>
                    <option value="sqft">Square Feet (sq ft)</option>
                    <option value="sqyd">Square Yards (sq yd)</option>
                    <option value="sqcm">Square Centimeters (sq cm)</option>
                    <option value="sqm">Square Meters (sq m)</option>
                  </>
                )}
                {editingTakeoff.type === 'count' && (
                  <option value="each">Each</option>
                )}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-ink mb-1.5">Cost Per Unit ($)</label>
              <NumberInput allowEmpty unstyled
                min="0"
                step="0.01"
                disabled={isEditTakeoffAdvanced}
                value={isEditTakeoffAdvanced ? '' : editTakeoffCostPerUnit}
                onChange={(e) => setEditTakeoffCostPerUnit(e.target.value === '' ? '' : Number(e.target.value))}
                className="w-full border border-edge-strong rounded-xl px-4 py-2.5 focus:outline-none focus:ring-2 focus:ring-accent-500 disabled:bg-sunken disabled:text-ink-faint"
                placeholder={isEditTakeoffAdvanced ? "Disabled in Advanced" : "0.00"}
              />
            </div>
          </div>

          <div className="flex items-center gap-2 py-2">
            <input
              data-testid="toggle-advanced-cost"
              type="checkbox"
              id="isEditTakeoffAdvanced"
              checked={isEditTakeoffAdvanced}
              onChange={(e) => setIsEditTakeoffAdvanced(e.target.checked)}
              className="w-4 h-4 text-accent-600 rounded border-edge-strong focus:ring-accent-500"
            />
            <label htmlFor="isEditTakeoffAdvanced" className="text-sm font-medium text-ink cursor-pointer">
              Advanced Costing (Custom Items)
            </label>
          </div>

          {isEditTakeoffAdvanced && (
            <div className="space-y-3 p-4 bg-sunken rounded-xl border border-edge">
              <div className="flex justify-between items-center mb-2">
                <h4 className="text-xs font-bold text-ink-soft uppercase tracking-wider">Custom Cost Items</h4>
                <button
                  onClick={() => setEditTakeoffCustomCosts([...editTakeoffCustomCosts, { id: uuidv4(), name: '', type: 'unit', costPerUnit: 0 }])}
                  className="text-accent-600 hover:text-accent-700 p-1 rounded-full hover:bg-accent-50 transition-colors"
                  title="Add Cost Item"
                >
                  <Plus size={16} />
                </button>
              </div>

              {editTakeoffCustomCosts.length === 0 ? (
                <p className="text-xs text-ink-faint italic text-center py-2">No custom items added. Click + to add.</p>
              ) : (
                <div className="space-y-3">
                  {editTakeoffCustomCosts.map((item, index) => (
                    <CustomCostRow
                      key={item.id}
                      item={item}
                      index={index}
                      unitLabel={UNIT_LABELS[editTakeoffUnit] || editTakeoffUnit || (editingTakeoff?.type === 'area' ? 'sq ft' : editingTakeoff?.type === 'length' ? 'ft' : 'ea')}
                      onChange={(idx, updated) => {
                        const newCosts = [...editTakeoffCustomCosts];
                        newCosts[idx] = updated;
                        setEditTakeoffCustomCosts(newCosts);
                      }}
                      onRemove={(idx) => {
                        setEditTakeoffCustomCosts(editTakeoffCustomCosts.filter((_, i) => i !== idx));
                      }}
                    />
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        <div className="p-6 border-t border-edge bg-sunken flex justify-end gap-3">
          <button
            onClick={onClose}
            className="px-5 py-2.5 text-sm font-medium text-ink-soft hover:bg-hover rounded-xl transition-colors"
          >
            Cancel
          </button>
          <button
            data-testid="btn-save-takeoff"
            onClick={onSave}
            disabled={!editTakeoffName}
            className="px-5 py-2.5 text-sm font-medium text-white bg-accent-600 hover:bg-accent-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl transition-colors shadow-sm"
          >
            Save Changes
          </button>
        </div>
      </div>
    </div>
  );
}
