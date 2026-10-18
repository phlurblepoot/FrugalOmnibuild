import React from 'react';
import { Pencil } from 'lucide-react';
import type { CollabEditingState } from '../hooks/useCollabEditing';

export const EditPresenceBanner: React.FC<{ state: CollabEditingState }> = ({ state }) => {
  const { othersEditing, remoteChange, reviewMerge, keepMine } = state;
  if (othersEditing.length === 0 && !remoteChange) return null;

  const names = othersEditing.map(s => `${s.name} (${s.device})`).join(', ');

  return (
    <div className="mb-3 p-3 bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-700/30 rounded-lg text-sm text-amber-700 dark:text-amber-400 space-y-2">
      {othersEditing.length > 0 && (
        <div className="flex items-center gap-2">
          <Pencil size={14} className="shrink-0" />
          <span>{names} {othersEditing.length > 1 ? 'are' : 'is'} editing this too</span>
        </div>
      )}
      {remoteChange && (
        <div className="flex items-center justify-between gap-3 flex-wrap">
          <span>
            {othersEditing.find(s => s.userId === remoteChange.byUserId)?.name ?? 'Someone'} saved changes while you were editing
          </span>
          <div className="flex items-center gap-2 flex-shrink-0">
            <button
              type="button"
              onClick={reviewMerge}
              className="text-xs font-semibold bg-amber-600 hover:bg-amber-700 text-white px-2.5 py-1 rounded-md"
            >
              Review &amp; merge
            </button>
            <button
              type="button"
              onClick={keepMine}
              title="Overwrites their change on save"
              className="text-xs font-semibold text-amber-700 dark:text-amber-400 hover:text-amber-900 dark:hover:text-amber-200 px-2.5 py-1 rounded-md border border-amber-300/60"
            >
              Keep mine
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
