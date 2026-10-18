import React from 'react';
import { Pencil } from 'lucide-react';
import { useCollaboration } from '../context/CollaborationContext';
import type { EntityType } from '../hooks/useLiveQuery';

export const EditingChip: React.FC<{ type: EntityType; id: string }> = ({ type, id }) => {
  const { sessions, mySessionId } = useCollaboration();
  const editor = sessions.find(s =>
    s.sessionId !== mySessionId && s.editing?.type === type && s.editing.id === id);
  if (!editor) return null;

  return (
    <span className="inline-flex items-center gap-1 text-[11px] font-medium text-amber-700 dark:text-amber-400">
      <Pencil size={11} className="shrink-0" />
      {editor.name}
    </span>
  );
};
