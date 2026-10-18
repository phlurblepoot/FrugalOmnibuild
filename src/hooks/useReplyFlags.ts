// src/hooks/useReplyFlags.ts — "did the linked email thread get a reply
// nobody has acted on yet?" for list rows and DocumentActionsBar (mail phase
// 2 spec Goal 4). A thin fetch+state wrapper around mailApi.replyFlags, kept
// live on `mailThread` events (debounced) the same way useGeneratedDocuments
// stays live on 'file' events — see hooks/useGeneratedDocument.ts.
//
// Batches to ONE request per call for up to 100 ids (the server's cap);
// larger lists are split into <=100-id chunks and merged. The ids array is
// reduced to a stable join-key so a caller re-creating the same ids as a new
// array reference each render (a `.map()` over list state, say) does not
// retrigger a fetch — mirroring useGeneratedDocuments' `idsKey` guard.
import { useCallback, useEffect, useRef, useState } from 'react';
import { mailApi } from '../utils/mailApi';
import { useLiveQuery } from './useLiveQuery';

const CHUNK_SIZE = 100;

const chunk = <T,>(arr: T[], size: number): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
};

export function useReplyFlags(itemType: string | undefined, ids: string[]): Set<string> {
  const [flagged, setFlagged] = useState<Set<string>>(new Set());

  // Bumped on every fetch so an out-of-order response can't clobber a newer
  // one — mirrors useGeneratedDocument(s)' requestIdRef guard.
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const idsKey = ids.join(',');

  const refresh = useCallback(async () => {
    if (!itemType || !ids.length) { setFlagged(new Set()); return; }
    const myId = ++requestIdRef.current;
    try {
      const results = await Promise.all(
        chunk(ids, CHUNK_SIZE).map(part => mailApi.replyFlags(itemType, part)),
      );
      if (!mountedRef.current || myId !== requestIdRef.current) return;
      setFlagged(new Set(results.flatMap(r => r.flagged)));
    } catch {
      if (mountedRef.current && myId === requestIdRef.current) setFlagged(new Set());
    }
    // idsKey stands in for `ids` — see the comment above.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [itemType, idsKey]);

  // useLiveQuery's own mount effect already fires `refresh` once (it reads
  // the latest closure via its internal ref, updated every render — see
  // useLiveQuery.ts), so this effect skips that first invocation and only
  // fires for itemType/idsKey changes AFTER mount. Without the skip, both
  // effects would fetch on mount — a real doubled-request quirk shared by
  // useGeneratedDocument(s), not worth repeating here.
  const mountedOnceRef = useRef(false);
  useEffect(() => {
    if (!mountedOnceRef.current) { mountedOnceRef.current = true; return; }
    void refresh();
  }, [refresh]);
  useLiveQuery(refresh, { types: ['mailThread'] }, { debounceMs: 1000 });

  return flagged;
}
