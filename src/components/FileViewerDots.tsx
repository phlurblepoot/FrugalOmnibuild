// src/components/FileViewerDots.tsx
import React from 'react';
import { useCollaboration } from '../context/CollaborationContext';

const MAX_DOTS = 3;

/** Small overlapping avatar dots for other live sessions currently viewing a file. */
export const FileViewerDots: React.FC<{ fileId: string }> = ({ fileId }) => {
  const { sessions, mySessionId } = useCollaboration();

  const viewers = sessions
    .filter(s => s.sessionId !== mySessionId && s.location?.fileId === fileId)
    .slice(0, MAX_DOTS);

  if (viewers.length === 0) return null;

  return (
    <div className="flex -space-x-1.5">
      {viewers.map(session => (
        <div
          key={session.sessionId}
          title={`${session.name} · ${session.device}`}
          className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full border-2 border-raised text-[10px] font-bold text-white"
          style={{ backgroundColor: session.color }}
        >
          {session.name.charAt(0).toUpperCase()}
        </div>
      ))}
    </div>
  );
};
