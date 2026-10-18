// src/hooks/useGeneratedDocument.ts — "does this entity already have a
// generated document, and is it current?" for action bars (invoice/CO/issue/
// proposal PDFs, etc). Thin fetch+state wrappers around
// getDocumentBySource/getDocumentsBySource, kept live via useLiveQuery: file
// events don't carry a sourceId, so any 'file' event triggers a (cheap,
// debounced) refetch rather than trying to filter it out.
import { useCallback, useEffect, useRef, useState } from 'react';
import { getDocumentBySource, getDocumentsBySource, GeneratedDoc } from '../utils/store';
import { useLiveQuery } from './useLiveQuery';

// null when there's no file yet (nothing to be "up to date"); true when
// there's no updatedAt to compare against (nothing has changed since — the
// file is trivially current).
// A document edited in the Document Editor counts as current until the record
// changes after the edit: the edit (a signature, a note) is deliberate, so Send
// mails the edited copy. A restored older version never counts as current: its
// bytes are older than the record, whatever the restore's own date says.
export const isUpToDate = (file: GeneratedDoc | null, updatedAt: number | null | undefined): boolean | null => {
  if (!file) return null;
  if (file.versionOrigin === 'restore') return false;
  if (updatedAt == null) return true;
  return file.createdAt >= updatedAt;
};

export interface GeneratedDocState {
  file: GeneratedDoc | null;
  upToDate: boolean | null;
  loading: boolean;
  refresh: () => Promise<void>;
}

export function useGeneratedDocument(q: {
  sourceType: string;
  sourceId: string | undefined;
  kind: string;
  updatedAt?: number | null;
  enabled?: boolean;
}): GeneratedDocState {
  const { sourceType, sourceId, kind, updatedAt, enabled = true } = q;
  const [file, setFile] = useState<GeneratedDoc | null>(null);
  const [loading, setLoading] = useState(false);

  // Bumped on every fetch so an out-of-order response can't clobber a newer
  // one — mirrors FilePickerModal.tsx's requestIdRef guard.
  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const refresh = useCallback(async () => {
    if (!enabled || !sourceId) { setFile(null); setLoading(false); return; }
    const myId = ++requestIdRef.current;
    setLoading(true);
    try {
      const doc = await getDocumentBySource({ sourceType, sourceId, kind });
      if (!mountedRef.current || myId !== requestIdRef.current) return;
      setFile(doc);
    } catch {
      if (mountedRef.current && myId === requestIdRef.current) setFile(null);
    } finally {
      if (mountedRef.current && myId === requestIdRef.current) setLoading(false);
    }
  }, [enabled, sourceType, sourceId, kind]);

  useEffect(() => { void refresh(); }, [refresh]);
  useLiveQuery(refresh, { types: ['file'] });

  return { file, upToDate: isUpToDate(file, updatedAt), loading, refresh };
}

export function useGeneratedDocuments(q: {
  sourceType: string;
  sourceIds: string[];
  kind: string;
  updatedAtById?: Record<string, number | null | undefined>;
  enabled?: boolean;
}): { byId: Record<string, { file: GeneratedDoc | null; upToDate: boolean | null }>; loading: boolean; refresh: () => Promise<void> } {
  const { sourceType, sourceIds, kind, updatedAtById = {}, enabled = true } = q;
  const [docs, setDocs] = useState<Record<string, GeneratedDoc | null>>({});
  const [loading, setLoading] = useState(false);

  const requestIdRef = useRef(0);
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  const idsKey = sourceIds.join(',');
  const refresh = useCallback(async () => {
    if (!enabled || !sourceIds.length) { setDocs({}); setLoading(false); return; }
    const myId = ++requestIdRef.current;
    setLoading(true);
    try {
      const map = await getDocumentsBySource({ sourceType, sourceIds, kind });
      if (!mountedRef.current || myId !== requestIdRef.current) return;
      setDocs(map);
    } catch {
      if (mountedRef.current && myId === requestIdRef.current) setDocs({});
    } finally {
      if (mountedRef.current && myId === requestIdRef.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled, sourceType, idsKey, kind]);

  useEffect(() => { void refresh(); }, [refresh]);
  useLiveQuery(refresh, { types: ['file'] });

  const byId: Record<string, { file: GeneratedDoc | null; upToDate: boolean | null }> = {};
  for (const id of sourceIds) {
    const file = docs[id] ?? null;
    byId[id] = { file, upToDate: isUpToDate(file, updatedAtById[id]) };
  }

  return { byId, loading, refresh };
}
