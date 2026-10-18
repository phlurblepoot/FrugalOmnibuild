import { useEffect, useRef, useState } from 'react';
import { useCollaboration, type SessionView } from '../context/CollaborationContext';
import { CLIENT_SESSION_ID } from '../utils/clientSession';
import type { EntityType, EntityChangedEvent } from './useLiveQuery';

export interface CollabEditingState {
  othersEditing: SessionView[];               // sessions (not mine) editing this entity
  remoteChange: EntityChangedEvent | null;    // set when a foreign change arrived while dirty
  keepMineVersion: number | null;             // adopt into the save payload after "Keep mine"
  reviewMerge: () => void;                    // calls onFresh (parent refetch → key-remount) and clears state
  keepMine: () => void;                       // records the remote version, clears the banner
}

export function useCollabEditing(args: {
  type: EntityType;
  id: string;
  isDirty: () => boolean;
  onFresh: () => void;    // parent's refetch — editors are remounted via key={id:version}
  enabled?: boolean;      // default true; false skips declaring/subscribing (e.g. non-admin viewers)
}): CollabEditingState {
  // useCollaboration() throws outside a CollaborationProvider. The call
  // itself (a single useContext under the hood) always runs unconditionally
  // here, so hook order stays stable across renders — only the subsequent
  // plain-JS throw is caught, degrading to a no-op the same way the
  // socket-null branches below already do. This lets editors render inside
  // tests that mount without the provider (e.g. AiaPayAppEditor.test.tsx)
  // instead of crashing.
  let collabCtx: ReturnType<typeof useCollaboration> | null;
  try { collabCtx = useCollaboration(); } catch { collabCtx = null; }
  const socket = collabCtx?.socket ?? null;
  const sessions = collabCtx?.sessions ?? [];
  const mySessionId = collabCtx?.mySessionId ?? null;
  const [remoteChange, setRemoteChange] = useState<EntityChangedEvent | null>(null);
  const [keepMineVersion, setKeepMineVersion] = useState<number | null>(null);
  const argsRef = useRef(args);
  argsRef.current = args;

  useEffect(() => {
    if (!socket || args.enabled === false) return;
    const declare = () => socket.emit('set-editing', { type: args.type, id: args.id });
    declare();
    socket.on('connect', declare); // reconnect wipes server session state
    // Pristine-path onFresh is trailing-debounced (same 300ms shape as
    // useLiveQuery's debounce) — undebounced, a sustained burst of foreign
    // events (e.g. someone else drawing on the canvas) would call a
    // consumer's refetch once per event. The dirty path (remoteChange) stays
    // immediate — it just flips a banner, no refetch.
    let freshTimer: ReturnType<typeof setTimeout> | null = null;
    const onEvent = (ev: EntityChangedEvent) => {
      if (ev.bySessionId === CLIENT_SESSION_ID) return;
      if (ev.type !== argsRef.current.type || ev.id !== argsRef.current.id) return;
      if (!argsRef.current.isDirty()) {
        if (freshTimer) clearTimeout(freshTimer);
        freshTimer = setTimeout(() => { freshTimer = null; argsRef.current.onFresh(); }, 300);
      } else {
        setRemoteChange(ev);
      }
    };
    socket.on('entity-changed', onEvent);
    return () => {
      if (freshTimer) clearTimeout(freshTimer);
      socket.off('connect', declare);
      socket.off('entity-changed', onEvent);
      socket.emit('set-editing', null);
    };
  }, [socket, args.type, args.id, args.enabled]);

  const othersEditing = sessions.filter(s =>
    s.sessionId !== mySessionId && s.editing?.type === args.type && s.editing.id === args.id);

  return {
    othersEditing,
    remoteChange,
    keepMineVersion,
    reviewMerge: () => { setRemoteChange(null); argsRef.current.onFresh(); },
    keepMine: () => { setKeepMineVersion(remoteChange?.version ?? null); setRemoteChange(null); },
  };
}
