import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mailApi } from './mailApi';

const mockFetch = (status: number, body: unknown = {}) => {
  const fn = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => ({
    ok: status < 400,
    status,
    json: async () => body,
  }));
  vi.stubGlobal('fetch', fn);
  return fn;
};

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('token', 'tok123');
});

describe('mailApi', () => {
  it('threads() builds the query string and returns the page', async () => {
    const fn = mockFetch(200, { threads: [], hasMore: true, indexedSince: '2026-01-01' });
    const result = await mailApi.threads({ accountId: 'acc1', folderId: 'f1', q: 'invoice', before: '2026-02-01', limit: 25 });
    const [url, init] = fn.mock.calls[0];
    expect(String(url)).toBe('/api/mail/threads?accountId=acc1&folderId=f1&q=invoice&before=2026-02-01&limit=25');
    expect((init as RequestInit).method).toBe('GET');
    expect((init as RequestInit).headers).toMatchObject({ Authorization: 'Bearer tok123' });
    expect(result.hasMore).toBe(true);
  });

  it('threads() omits unset optional params', async () => {
    const fn = mockFetch(200, { threads: [], hasMore: false, indexedSince: '2026-01-01' });
    await mailApi.threads({ accountId: 'acc1' });
    expect(String(fn.mock.calls[0][0])).toBe('/api/mail/threads?accountId=acc1');
  });

  it('messageActions() posts ids/action/folderId as JSON', async () => {
    const fn = mockFetch(200, { ok: true });
    await mailApi.messageActions(['m1', 'm2'], 'archive');
    const [url, init] = fn.mock.calls[0];
    expect(url).toBe('/api/mail/messages/actions');
    const req = init as RequestInit;
    expect(req.method).toBe('POST');
    expect(req.headers).toMatchObject({ 'Content-Type': 'application/json', Authorization: 'Bearer tok123' });
    expect(JSON.parse(req.body as string)).toEqual({ ids: ['m1', 'm2'], action: 'archive', folderId: undefined });
  });

  it('threadActions() posts accountId/threadKeys/action/folderId', async () => {
    const fn = mockFetch(200, { ok: true });
    await mailApi.threadActions('acc1', ['t1'], 'move', 'folder2');
    const [url, init] = fn.mock.calls[0];
    expect(url).toBe('/api/mail/threads/actions');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      accountId: 'acc1', threadKeys: ['t1'], action: 'move', folderId: 'folder2',
    });
  });

  it('send() posts the SendRequest as-is and returns the SendResult', async () => {
    const sendResult = { messageId: 'm1', threadKey: 'tk1', accountId: 'acc1', effectsSkipped: [] };
    const fn = mockFetch(200, sendResult);
    const req = {
      to: [{ addr: 'a@b.com' }],
      subject: 'Hi',
      html: '<p>hi</p>',
      attachments: [],
    };
    const result = await mailApi.send(req as never);
    const [url, init] = fn.mock.calls[0];
    expect(url).toBe('/api/mail/send');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual(req);
    expect(result).toEqual(sendResult);
  });

  it('body() returns a pending payload on 202 without throwing', async () => {
    mockFetch(202, { pending: true });
    const result = await mailApi.body('m1');
    expect(result).toEqual({ pending: true });
  });

  it('body() forwards images=1 when requested', async () => {
    const fn = mockFetch(200, { html: '<p>x</p>', text: 'x', blockedRemoteImages: 0, attachments: [] });
    await mailApi.body('m1', { images: true });
    expect(String(fn.mock.calls[0][0])).toBe('/api/mail/messages/m1/body?images=1');
  });

  it('stageUpload() posts the raw File body with ?name= and the file type as Content-Type', async () => {
    const fn = mockFetch(200, { uploadId: 'u1' });
    const file = new File(['hello'], 'plan set.pdf', { type: 'application/pdf' });
    const result = await mailApi.stageUpload(file);
    const [url, init] = fn.mock.calls[0];
    expect(String(url)).toBe('/api/mail/uploads?name=plan%20set.pdf');
    const req = init as RequestInit;
    expect(req.method).toBe('POST');
    expect(req.body).toBe(file);
    expect((req.headers as Record<string, string>)['Content-Type']).toBe('application/pdf');
    expect(result).toEqual({ uploadId: 'u1' });
  });

  it('attachmentUrl() carries the token and, when inline, inline=1', () => {
    const url = mailApi.attachmentUrl('m1', 'att1', { inline: true });
    expect(url).toContain('/api/mail/messages/m1/attachments/att1?');
    expect(url).toContain('token=tok123');
    expect(url).toContain('inline=1');
  });

  it('attachmentUrl() omits inline=1 when not requested', () => {
    const url = mailApi.attachmentUrl('m1', 'att1');
    expect(url).toContain('token=tok123');
    expect(url).not.toContain('inline');
  });

  it('oauthStartUrl() embeds the encoded token', () => {
    localStorage.setItem('token', 'a b/c');
    const url = mailApi.oauthStartUrl('google');
    expect(url).toBe('/api/mail/oauth/google/start?token=a%20b%2Fc');
  });

  it('saveAttachments() posts items and returns fileIds/saved/failed', async () => {
    const payload = { fileIds: ['f1'], saved: [{ attId: 'a1', fileId: 'f1' }], failed: [] };
    const fn = mockFetch(200, payload);
    const result = await mailApi.saveAttachments('m1', [{ attId: 'a1', name: 'x.pdf', kind: 'email-attachment' }]);
    expect(fn.mock.calls[0][0]).toBe('/api/mail/messages/m1/attachments/save');
    expect(result).toEqual(payload);
  });

  it('providers() reads the boolean configured map', async () => {
    mockFetch(200, { google: true, microsoft: false });
    const result = await mailApi.providers();
    expect(result).toEqual({ google: true, microsoft: false });
  });

  it('heartbeat() posts accountIds and resolves on a 204 with no body', async () => {
    const fn = vi.fn(async (_input?: RequestInfo | URL, _init?: RequestInit) => ({ ok: true, status: 204, json: async () => { throw new Error('no body'); } }));
    vi.stubGlobal('fetch', fn);
    await expect(mailApi.heartbeat(['acc1'])).resolves.toBeUndefined();
    expect(JSON.parse((fn.mock.calls[0][1] as RequestInit).body as string)).toEqual({ accountIds: ['acc1'] });
  });

  it('saveDraft() POSTs to create and PUTs to update', async () => {
    const fn = mockFetch(200, { draftId: 'd1' });
    const b = { accountId: 'acc1', to: [{ addr: 'a@b.com' }], subject: 's', html: '<p>h</p>' };
    await mailApi.saveDraft(b);
    expect(fn.mock.calls[0][0]).toBe('/api/mail/drafts');
    expect((fn.mock.calls[0][1] as RequestInit).method).toBe('POST');

    await mailApi.saveDraft(b, 'd1');
    expect(fn.mock.calls[1][0]).toBe('/api/mail/drafts/d1');
    expect((fn.mock.calls[1][1] as RequestInit).method).toBe('PUT');
  });

  it('deleteDraft() DELETEs with accountId in the query string', async () => {
    const fn = mockFetch(200, { ok: true });
    await mailApi.deleteDraft('acc1', 'd1');
    expect(fn.mock.calls[0][0]).toBe('/api/mail/drafts/d1?accountId=acc1');
    expect((fn.mock.calls[0][1] as RequestInit).method).toBe('DELETE');
  });

  it('links() and createLink() hit the right routes', async () => {
    const fn = mockFetch(200, []);
    await mailApi.links('project', 'p1');
    expect(fn.mock.calls[0][0]).toBe('/api/mail/links?itemType=project&itemId=p1');

    mockFetch(200, { id: 'l1' });
    const fn2 = mockFetch(200, { id: 'l1' });
    await mailApi.createLink({ threadKey: 'tk1', itemType: 'project', itemId: 'p1' });
    expect(fn2.mock.calls[0][0]).toBe('/api/mail/links');
    expect((fn2.mock.calls[0][1] as RequestInit).method).toBe('POST');
  });

  it('setupInfo() and accounts() are plain authenticated GETs', async () => {
    const fn = mockFetch(200, { publicUrl: null, google: {}, microsoft: {}, secretKey: 'env' });
    await mailApi.setupInfo();
    expect(fn.mock.calls[0][0]).toBe('/api/mail/setup-info');

    const fn2 = mockFetch(200, []);
    await mailApi.accounts();
    expect(fn2.mock.calls[0][0]).toBe('/api/mail/accounts');
  });
});
