import React from 'react';
import { HelpCircle } from 'lucide-react';

interface KeyboardShortcutsModalProps {
  open: boolean;
  onClose: () => void;
}

export const KeyboardShortcutsModal: React.FC<KeyboardShortcutsModalProps> = ({ open, onClose }) => {
  if (!open) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-[70] p-4" onClick={onClose}>
      <div className="bg-raised rounded-2xl shadow-xl w-full max-w-md overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="p-6 border-b border-edge flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-full bg-accent-100 flex items-center justify-center text-accent-600">
              <HelpCircle size={20} />
            </div>
            <h3 className="text-lg font-semibold text-ink">Keyboard Shortcuts</h3>
          </div>
          <button onClick={onClose} className="p-2 text-ink-faint hover:text-ink-soft hover:bg-hover rounded-lg transition-colors">
            <svg xmlns="http://www.w3.org/2000/svg" width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div className="overflow-y-auto max-h-[60vh]">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-sunken border-b border-edge">
                <th className="px-6 py-3 text-left text-xs font-semibold text-ink-soft uppercase tracking-wider">Key</th>
                <th className="px-6 py-3 text-left text-xs font-semibold text-ink-soft uppercase tracking-wider">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-edge">
              {[
                ['?', 'Show this help'],
                ['Escape', 'Cancel / close modal / deselect'],
                ['Ctrl+Z', 'Undo'],
                ['Ctrl+Shift+Z / Ctrl+Y', 'Redo'],
                ['Delete', 'Delete selected measurement'],
                ['Backspace (while drawing)', 'Remove last point'],
                ['P', 'Resume/extend selected measurement (or segment)'],
                ['Ctrl+C', 'Copy measurement'],
                ['Ctrl+V', 'Paste measurement'],
                ['← / →', 'Previous / next page'],
                ['Enter', 'Finish current measurement'],
                ['A (while drawing)', 'Toggle arc mode'],
              ].map(([key, action]) => (
                <tr key={key} className="hover:bg-hover transition-colors">
                  <td className="px-6 py-3 font-mono text-xs text-accent-700 bg-accent-50/50 whitespace-nowrap">{key}</td>
                  <td className="px-6 py-3 text-ink">{action}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="p-4 border-t border-edge bg-sunken text-center">
          <p className="text-xs text-ink-faint">Press <span className="font-mono">Escape</span> or click outside to close</p>
        </div>
      </div>
    </div>
  );
};
