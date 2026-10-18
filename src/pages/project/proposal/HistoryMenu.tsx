// src/pages/project/proposal/HistoryMenu.tsx
// Moved verbatim out of the old ProjectProposal page (deleted in Task 13) so
// every remembered-text field in the new editor — cover notes, terms,
// inclusions, exclusions — shares one dropdown.
import React, { useEffect, useState } from 'react';
import { History } from 'lucide-react';

// Small ghost icon button next to a textarea label that opens a dropdown of
// this user's last-used values for that field (proposalTextHistory.ts).
// Selecting an entry overwrites the field's current content. Disabled when
// there's no history yet.
export const HistoryMenu: React.FC<{
  history: string[];
  testId: string;
  onSelect: (value: string) => void;
}> = ({ history, testId, onSelect }) => {
  const [open, setOpen] = useState(false);

  // Outside-click/Escape close the menu. The wrapper stops its own mousedown
  // from bubbling (below), so this window listener only ever sees genuinely
  // outside clicks — including a re-click on the trigger, which toggles via
  // its own onClick instead of racing the window listener.
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div className="relative inline-block" onMouseDown={e => e.stopPropagation()}>
      <button
        type="button"
        data-testid={testId}
        aria-label="Recent entries"
        disabled={history.length === 0}
        onClick={() => setOpen(o => !o)}
        className="rounded-md p-1 text-ink-faint transition-colors hover:bg-hover hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
      >
        <History size={14} />
      </button>
      {open && (
        <div
          role="menu"
          aria-label="Recent entries"
          className="absolute right-0 top-full z-20 mt-1 w-72 max-w-[80vw] rounded-lg border border-edge bg-raised py-1 shadow-lg"
        >
          {history.map((entry, i) => {
            const firstLine = entry.split('\n')[0];
            const label = firstLine.length > 60 ? firstLine.slice(0, 60) + '…' : firstLine;
            return (
              <button
                key={i}
                role="menuitem"
                type="button"
                title={entry.length > 400 ? entry.slice(0, 400) + '…' : entry}
                onClick={() => { onSelect(entry); setOpen(false); }}
                className="block w-full truncate px-3 py-1.5 text-left text-sm text-ink hover:bg-hover"
              >
                {label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
};
