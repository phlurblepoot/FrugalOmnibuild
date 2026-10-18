// src/hooks/useGeneratedDocument.test.tsx
// isUpToDate is pure; the hooks are thin fetch+state wrappers around
// getDocumentBySource/getDocumentsBySource, refetching on any 'file'
// useLiveQuery event (file events don't carry sourceId).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import type { GeneratedDoc } from '../utils/store';

const getDocumentBySource = vi.fn(async (_q: unknown): Promise<GeneratedDoc | null> => null);
const getDocumentsBySource = vi.fn(async (_q: unknown): Promise<Record<string, GeneratedDoc | null>> => ({}));

vi.mock('../utils/store', async () => {
  const actual = await vi.importActual<typeof import('../utils/store')>('../utils/store');
  return { ...actual, getDocumentBySource, getDocumentsBySource };
});
vi.mock('./useLiveQuery', () => ({ useLiveQuery: vi.fn() }));

const { isUpToDate, useGeneratedDocument, useGeneratedDocuments } = await import('./useGeneratedDocument');

const doc = (o: Partial<GeneratedDoc> = {}): GeneratedDoc => ({
  id: 'f1', name: 'x.pdf', mime: 'application/pdf', size: 10, createdAt: 100, versionNumber: 1, ...o,
});

describe('isUpToDate', () => {
  it('is null when there is no file', () => {
    expect(isUpToDate(null, 5)).toBeNull();
  });
  it('is true when the file is newer than updatedAt', () => {
    expect(isUpToDate(doc({ createdAt: 10 }), 5)).toBe(true);
  });
  it('is false when the file is older than updatedAt', () => {
    expect(isUpToDate(doc({ createdAt: 4 }), 5)).toBe(false);
  });
  it('is true when there is no updatedAt to compare against', () => {
    expect(isUpToDate(doc({ createdAt: 4 }), undefined)).toBe(true);
  });
  it('counts an edit in the Document Editor as current until the record changes after it', () => {
    expect(isUpToDate(doc({ createdAt: 10, versionOrigin: 'editor' }), 5)).toBe(true);
    expect(isUpToDate(doc({ createdAt: 4, versionOrigin: 'editor' }), 5)).toBe(false);
  });
  it('never counts a restored older version as current', () => {
    expect(isUpToDate(doc({ createdAt: 10, versionOrigin: 'restore' }), 5)).toBe(false);
    expect(isUpToDate(doc({ createdAt: 10, versionOrigin: 'restore' }), undefined)).toBe(false);
  });
});

describe('useGeneratedDocument', () => {
  beforeEach(() => {
    getDocumentBySource.mockReset();
    getDocumentsBySource.mockReset();
  });

  it('fetches on mount and exposes file/upToDate', async () => {
    getDocumentBySource.mockResolvedValue(doc({ createdAt: 10 }));
    const { result } = renderHook(() => useGeneratedDocument({ sourceType: 'invoice', sourceId: 'inv-1', kind: 'invoice', updatedAt: 5 }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.file).toEqual(doc({ createdAt: 10 }));
    expect(result.current.upToDate).toBe(true);
    expect(getDocumentBySource).toHaveBeenCalledWith({ sourceType: 'invoice', sourceId: 'inv-1', kind: 'invoice' });
  });

  it('never fetches when enabled: false', async () => {
    const { result } = renderHook(() => useGeneratedDocument({ sourceType: 'invoice', sourceId: 'inv-1', kind: 'invoice', enabled: false }));
    await new Promise(r => setTimeout(r, 0));
    expect(getDocumentBySource).not.toHaveBeenCalled();
    expect(result.current.loading).toBe(false);
    expect(result.current.file).toBeNull();
  });

  it('never fetches when sourceId is undefined', async () => {
    const { result } = renderHook(() => useGeneratedDocument({ sourceType: 'invoice', sourceId: undefined, kind: 'invoice' }));
    await new Promise(r => setTimeout(r, 0));
    expect(getDocumentBySource).not.toHaveBeenCalled();
    expect(result.current.file).toBeNull();
  });

  it('refresh() re-fetches', async () => {
    getDocumentBySource.mockResolvedValue(doc());
    const { result } = renderHook(() => useGeneratedDocument({ sourceType: 'invoice', sourceId: 'inv-1', kind: 'invoice' }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    getDocumentBySource.mockClear();
    await result.current.refresh();
    expect(getDocumentBySource).toHaveBeenCalledTimes(1);
  });
});

describe('useGeneratedDocuments', () => {
  beforeEach(() => {
    getDocumentBySource.mockReset();
    getDocumentsBySource.mockReset();
  });

  it('maps ids to file/upToDate', async () => {
    getDocumentsBySource.mockResolvedValue({ a: doc({ id: 'a', createdAt: 10 }), b: null });
    const { result } = renderHook(() => useGeneratedDocuments({
      sourceType: 'invoice', sourceIds: ['a', 'b'], kind: 'invoice', updatedAtById: { a: 5, b: 5 },
    }));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.byId.a.file?.id).toBe('a');
    expect(result.current.byId.a.upToDate).toBe(true);
    expect(result.current.byId.b.file).toBeNull();
    expect(result.current.byId.b.upToDate).toBeNull();
  });

  it('never fetches when enabled: false', async () => {
    renderHook(() => useGeneratedDocuments({ sourceType: 'invoice', sourceIds: ['a'], kind: 'invoice', enabled: false }));
    await new Promise(r => setTimeout(r, 0));
    expect(getDocumentsBySource).not.toHaveBeenCalled();
  });
});
