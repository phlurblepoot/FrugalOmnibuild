import { describe, it, expect, vi, beforeEach } from 'vitest';
import { saveProposal, ProposalLockedError, ConflictError, getDocuments } from './store';

const mockFetch = (status: number, body: unknown) => {
  const fn = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => ({ ok: status < 400, status, json: async () => body, blob: async () => new Blob() }));
  vi.stubGlobal('fetch', fn);
  return fn;
};
beforeEach(() => { localStorage.setItem('token', 't'); });

describe('proposal API helpers', () => {
  it('maps 409 locked to ProposalLockedError and 409 version_conflict to ConflictError', async () => {
    mockFetch(409, { error: 'locked', code: 'locked' });
    await expect(saveProposal('x', { version: 1 })).rejects.toBeInstanceOf(ProposalLockedError);
    mockFetch(409, { error: 'stale', code: 'version_conflict' });
    await expect(saveProposal('x', { version: 1 })).rejects.toBeInstanceOf(ConflictError);
  });
  it('getDocuments forwards mimes', async () => {
    const fn = mockFetch(200, { rows: [], total: 0 });
    await getDocuments({ mimes: ['application/pdf', 'image/'] });
    expect(String(fn.mock.calls[0][0])).toContain('mimes=application%2Fpdf%2Cimage%2F');
  });
});
