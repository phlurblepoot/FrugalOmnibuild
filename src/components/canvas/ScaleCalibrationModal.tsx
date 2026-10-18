import React from 'react';

interface ScaleCalibrationModalProps {
  open: boolean;
  scaleInput: string;
  onScaleInputChange: (value: string) => void;
  scaleUnit: string;
  onScaleUnitChange: (value: string) => void;
  onApply: () => void;
  onClose: () => void;
}

export const ScaleCalibrationModal: React.FC<ScaleCalibrationModalProps> = ({
  open,
  scaleInput,
  onScaleInputChange,
  scaleUnit,
  onScaleUnitChange,
  onApply,
  onClose,
}) => {
  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4">
      <div className="bg-raised rounded-xl shadow-xl w-full max-w-sm overflow-hidden">
        <div className="p-4 border-b border-edge bg-sunken">
          <h3 className="font-semibold text-ink">Set Scale</h3>
        </div>
        <div className="p-6">
          <p className="text-sm text-ink-soft mb-4">
            Enter the real-world distance for the line you just drew.
            {(scaleUnit === 'ft' || scaleUnit === 'in') && (
              <span className="block mt-1 text-xs text-ink-soft">
                You can use fractions and feet/inches (e.g., 3' 4 1/2", 3.5, 4 1/2")
              </span>
            )}
          </p>
          <div className="flex gap-3">
            <div className="flex-1">
              <label className="block text-xs font-medium text-ink-soft mb-1">Distance</label>
              <input
                data-testid="scale-input"
                type="text"
                value={scaleInput}
                onChange={(e) => onScaleInputChange(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') onApply();
                }}
                className="w-full border border-edge-strong rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-raised text-ink"
                autoFocus
              />
            </div>
            <div className="w-24">
              <label className="block text-xs font-medium text-ink-soft mb-1">Unit</label>
              <select
                value={scaleUnit}
                onChange={(e) => onScaleUnitChange(e.target.value)}
                className="w-full border border-edge-strong rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-raised text-ink"
              >
                <option value="ft">ft</option>
                <option value="in">in</option>
                <option value="m">m</option>
                <option value="cm">cm</option>
                <option value="mm">mm</option>
              </select>
            </div>
          </div>
        </div>
        <div className="p-4 border-t border-edge bg-sunken flex justify-end gap-2">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-ink-soft hover:bg-hover active:scale-95 rounded-lg transition-all"
          >
            Cancel
          </button>
          <button
            data-testid="scale-apply"
            onClick={onApply}
            className="px-4 py-2 text-sm font-medium text-white bg-accent-600 hover:bg-accent-700 active:scale-95 rounded-lg transition-all"
          >
            Set Scale
          </button>
        </div>
      </div>
    </div>
  );
};
