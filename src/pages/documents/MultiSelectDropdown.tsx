// src/pages/documents/MultiSelectDropdown.tsx
// Generic checkbox-dropdown filter: a trigger button showing a count summary
// ("2 selected") plus a popover of checkboxes. Modeled on the outside-click
// idiom in ProjectStageControl.tsx; new (the Projects board's customer filter
// is a single-select <Select>, not reusable here).
import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';

export interface MultiSelectOption {
  id: string;
  label: string;
}

export const MultiSelectDropdown: React.FC<{
  label: string;
  options: MultiSelectOption[];
  selected: string[];
  onChange: (ids: string[]) => void;
  testId?: string;
  emptyLabel?: string;
  className?: string;
}> = ({ label, options, selected, onChange, testId, emptyLabel, className = '' }) => {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const toggle = (id: string) => {
    onChange(selected.includes(id) ? selected.filter(s => s !== id) : [...selected, id]);
  };

  const summary = selected.length === 0
    ? (emptyLabel ?? `All ${label.toLowerCase()}`)
    : selected.length === 1
      ? (options.find(o => o.id === selected[0])?.label ?? '1 selected')
      : `${selected.length} selected`;

  return (
    <div ref={ref} className={`relative inline-block ${className}`}>
      <button
        type="button"
        data-testid={testId}
        onClick={() => setOpen(o => !o)}
        aria-expanded={open}
        className="flex h-9 items-center gap-1.5 rounded-lg border border-edge bg-raised px-3 text-sm text-ink transition-colors hover:bg-hover"
      >
        <span className="text-ink-faint">{label}:</span>
        <span className="max-w-[9rem] truncate font-medium">{summary}</span>
        <ChevronDown size={14} className="shrink-0 text-ink-faint" />
      </button>
      {open && (
        <div className="absolute left-0 top-full z-50 mt-1 max-h-64 w-56 overflow-y-auto rounded-lg border border-edge bg-raised py-1 shadow-lg">
          {options.length === 0 ? (
            <p className="px-3 py-2 text-xs text-ink-faint">No options</p>
          ) : (
            <>
              {selected.length > 0 && (
                <button
                  type="button"
                  onClick={() => onChange([])}
                  className="w-full px-3 py-1.5 text-left text-xs font-medium text-accent-600 hover:bg-hover dark:text-accent-400"
                >
                  Clear
                </button>
              )}
              {options.map(o => (
                <label key={o.id} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-sm text-ink hover:bg-hover">
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 rounded border-edge-strong accent-accent-600"
                    checked={selected.includes(o.id)}
                    onChange={() => toggle(o.id)}
                  />
                  <span className="truncate">{o.label}</span>
                </label>
              ))}
            </>
          )}
        </div>
      )}
    </div>
  );
};
