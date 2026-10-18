import React from 'react';
import { useCollaboration } from '../context/CollaborationContext';

export const FollowPill: React.FC = () => {
  const { sessions, followedSessionId, setFollowedSessionId } = useCollaboration();

  if (!followedSessionId) return null;
  const followed = sessions.find(s => s.sessionId === followedSessionId);
  if (!followed) return null;

  return (
    <div className="fixed left-1/2 top-[calc(3.5rem+env(safe-area-inset-top)+0.5rem)] z-50 -translate-x-1/2 md:top-4">
      <div className="flex items-center gap-2 rounded-full border border-edge bg-raised px-3 py-1.5 text-sm text-ink shadow-lg">
        <span className="text-ink-soft">
          Following {followed.name} ({followed.device})
        </span>
        <button
          onClick={() => setFollowedSessionId(null)}
          className="rounded-full px-2 py-0.5 text-xs font-semibold text-ink-soft hover:bg-hover hover:text-ink"
        >
          Stop
        </button>
      </div>
    </div>
  );
};
