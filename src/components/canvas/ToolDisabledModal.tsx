import React from 'react';
import { Settings } from 'lucide-react';

interface ToolDisabledModalProps {
  message: string | null;
  onClose: () => void;
}

export const ToolDisabledModal: React.FC<ToolDisabledModalProps> = ({ message, onClose }) => {
  if (!message) return null;

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-[60]">
      <div className="bg-raised rounded-2xl shadow-xl w-full max-w-sm overflow-hidden">
        <div className="p-6 border-b border-edge flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-amber-100 flex items-center justify-center text-amber-600">
            <Settings size={20} />
          </div>
          <h3 className="text-lg font-semibold text-ink">Tool Restricted</h3>
        </div>
        <div className="p-6">
          <p className="text-sm text-ink-soft">
            {message}
          </p>
        </div>
        <div className="p-6 border-t border-edge bg-sunken flex justify-end">
          <button
            onClick={onClose}
            className="px-5 py-2.5 text-sm font-medium text-white bg-accent-600 hover:bg-accent-700 rounded-xl transition-colors shadow-sm"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
};
