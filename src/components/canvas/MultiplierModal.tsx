import React, { useState } from 'react';
import { MAX_MULTIPLIER, MIN_MULTIPLIER, parseMultiplierInput } from '../../utils/multiplier';
import { NumberInput } from '../ui';

interface MultiplierModalProps {
  measurementName: string;
  /** The measurement's current multiplier (1 when it has none). */
  multiplier: number;
  onSave: (multiplier: number) => void;
  onClose: () => void;
}

// Sets how many times one length or area measurement counts — e.g. 4 when one
// floor plan stands in for four identical floors. 1 counts it once (no
// multiplier). Only whole numbers from 1 to 999 save.
export const MultiplierModal: React.FC<MultiplierModalProps> = ({ measurementName, multiplier, onSave, onClose }) => {
  const [input, setInput] = useState(String(multiplier));
  const parsed = parseMultiplierInput(input);

  const save = () => {
    if (parsed !== null) onSave(parsed);
  };

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[60] p-4">
      <div data-testid="multiplier-modal" className="bg-raised rounded-2xl shadow-xl w-full max-w-sm overflow-hidden">
        <div className="p-6 border-b border-edge">
          <h3 className="text-lg font-semibold text-ink">Multiplier</h3>
          <p className="text-sm text-ink-soft mt-1 break-words">
            Count <span className="font-medium text-ink">{measurementName}</span> more than once — e.g. 4 when this
            plan is the same for four floors. Its quantity and price are multiplied everywhere; 1 counts it once.
          </p>
        </div>
        <div className="p-6">
          <label htmlFor="multiplier-input" className="block text-xs font-medium text-ink-soft mb-1">Counts ×</label>
          <NumberInput unstyled
            id="multiplier-input"
            data-testid="multiplier-input"
            inputMode="numeric"
            min={MIN_MULTIPLIER}
            max={MAX_MULTIPLIER}
            step={1}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') save();
              if (e.key === 'Escape') onClose();
            }}
            className="w-full border border-edge-strong rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-accent-500 bg-raised text-ink"
            autoFocus
          />
          {parsed === null && (
            <p className="text-xs text-red-600 dark:text-red-400 mt-1.5">
              Enter a whole number from {MIN_MULTIPLIER} to {MAX_MULTIPLIER}.
            </p>
          )}
        </div>
        <div className="p-6 border-t border-edge bg-sunken flex justify-end gap-3">
          <button onClick={onClose} className="px-5 py-2.5 text-sm font-medium text-ink-soft hover:bg-hover rounded-xl transition-colors">Cancel</button>
          <button
            data-testid="btn-save-multiplier"
            onClick={save}
            disabled={parsed === null}
            className="px-5 py-2.5 text-sm font-medium text-white bg-accent-600 hover:bg-accent-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl transition-colors shadow-sm"
          >
            Save
          </button>
        </div>
      </div>
    </div>
  );
};
