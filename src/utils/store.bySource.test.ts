import { describe, it, expect, vi, beforeEach } from 'vitest';
import { getDocumentBySource, getDocumentsBySource, saveBinaryFile } from './store';

const mockFetch = (status: number, body: unknown) => {
  const fn = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => ({ ok: status < 400, status, json: async () => body, blob: async () => new Blob() }));
  vi.stubGlobal('fetch', fn);
  return fn;
};
beforeEach(() => { localStorage.setItem('token', 't'); });

const DOC = { id: 'f1', name: 'invoice.pdf', mime: 'application/pdf', size: 123, createdAt: 100, versionNumber: 2 };

describe('by-source document helpers', () => {
  it('getDocumentBySource returns the doc on 200', async () => {
    const fn = mockFetch(200, DOC);
    const doc = await getDocumentBySource({ sourceType: 'invoice', sourceId: 'inv-1', kind: 'invoice' });
    expect(doc).toEqual(DOC);
    const url = String(fn.mock.calls[0][0]);
    expect(url).toContain('/api/documents/by-source');
    expect(url).toContain('sourceType=invoice');
    expect(url).toContain('sourceId=inv-1');
    expect(url).toContain('kind=invoice');
  });

  it('getDocumentBySource returns null on 404', async () => {
    mockFetch(404, { error: 'No document for this source' });
    const doc = await getDocumentBySource({ sourceType: 'invoice', sourceId: 'nope', kind: 'invoice' });
    expect(doc).toBeNull();
  });

  it('getDocumentsBySource passes sourceIds as a comma-joined param', async () => {
    const fn = mockFetch(200, { a: DOC, b: null });
    const map = await getDocumentsBySource({ sourceType: 'invoice', sourceIds: ['a', 'b'], kind: 'invoice' });
    expect(map).toEqual({ a: DOC, b: null });
    const url = String(fn.mock.calls[0][0]);
    expect(url).toContain('sourceIds=a%2Cb');
  });

  it('saveBinaryFile never asks to overwrite: a regenerate always versions', async () => {
    const fn = mockFetch(200, { fileId: 'f1', versioned: true });
    await saveBinaryFile('f1', new Blob(['x']), { sourceType: 'invoice', sourceId: 'inv-1', kind: 'invoice' });
    const url = String(fn.mock.calls[0][0]);
    expect(url).toContain('sourceId=inv-1');
    expect(url).not.toContain('mode=');
  });
});
