import React from 'react';
import { MeasurementTakeoff } from '../../types';
import { CopiedSegments, canPasteInto, segmentCountLabel } from '../../utils/segmentClipboard';

// Asks where pasted segments go: a new measurement in the active takeoff, or
// a new takeoff (the New Takeoff modal opens next).
export const PasteSegmentsModal: React.FC<{
  clip: CopiedSegments;
  activeTakeoff?: MeasurementTakeoff;
  onPasteIntoActive: (takeoff: MeasurementTakeoff) => void;
  onPasteIntoNew: () => void;
  onCancel: () => void;
}> = ({ clip, activeTakeoff, onPasteIntoActive, onPasteIntoNew, onCancel }) => {
  const activeFits = !!activeTakeoff && canPasteInto(clip, activeTakeoff);
  const activeHint = !activeTakeoff
    ? 'No takeoff is active. Pick one in the sidebar first.'
    : !activeFits
      ? `"${activeTakeoff.name}" is a ${activeTakeoff.type} takeoff and can't hold ${clip.type} segments.`
      : `Adds a new measurement to "${activeTakeoff.name}".`;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[60] p-4" onMouseDown={onCancel}>
      <div
        data-testid="paste-segments-modal"
        className="bg-raised rounded-2xl shadow-xl w-full max-w-sm overflow-hidden"
        onMouseDown={e => e.stopPropagation()}
      >
        <div className="p-6 border-b border-edge">
          <h3 className="text-lg font-semibold text-ink">Paste {segmentCountLabel(clip)}</h3>
          <p className="text-sm text-ink-soft mt-1">Where should the pasted {clip.type === 'count' ? 'marker' : 'segments'} go?</p>
        </div>
        <div className="p-6 space-y-3">
          <button
            data-testid="paste-into-active"
            autoFocus={activeFits}
            disabled={!activeFits}
            onClick={() => activeTakeoff && onPasteIntoActive(activeTakeoff)}
            className="w-full text-left rounded-xl border border-edge px-4 py-3 hover:bg-hover disabled:opacity-50 disabled:hover:bg-transparent disabled:cursor-not-allowed transition-colors"
          >
            <span className="flex items-center gap-2 text-sm font-semibold text-ink">
              {activeTakeoff && <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: activeTakeoff.color }} />}
              Current takeoff{activeTakeoff ? `: ${activeTakeoff.name}` : ''}
            </span>
            <span className="block text-xs text-ink-soft mt-0.5">{activeHint}</span>
          </button>
          <button
            data-testid="paste-into-new"
            autoFocus={!activeFits}
            onClick={onPasteIntoNew}
            className="w-full text-left rounded-xl border border-edge px-4 py-3 hover:bg-hover transition-colors"
          >
            <span className="block text-sm font-semibold text-ink">New takeoff…</span>
            <span className="block text-xs text-ink-soft mt-0.5">Create a takeoff, then add the pasted segments to it as a measurement.</span>
          </button>
        </div>
        <div className="px-6 py-4 border-t border-edge bg-sunken flex justify-end">
          <button
            onClick={onCancel}
            className="px-5 py-2.5 text-sm font-medium text-ink-soft hover:bg-hover rounded-xl transition-colors"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
};
