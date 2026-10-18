import { describe, it, expect } from 'vitest';
import { Readable } from 'stream';
import { ImapMailProvider, makePmid, parsePmid } from './imap';
import { AuthExpiredError, ProviderNotFoundError } from './types';
import type { ImapAuth } from '../accountStore';

// ---------------------------------------------------------------------------
// A scripted stand-in for ImapFlow. It records every call so the tests can pin
// the IMAP operations the provider issues, not just the values it returns.
// ---------------------------------------------------------------------------
type FakeFolder = { path: string; name?: string; specialUse?: string; flags?: Set<string>; delimiter?: string };
type FakeMsg = Record<string, unknown> & { uid: number };
interface Script {
  folders?: FakeFolder[];
  messages?: Record<string, FakeMsg[]>;
  uidNext?: Record<string, number>;
  authFail?: boolean;
  appendResult?: { uid?: number; uidValidity?: bigint } | false;
  appendThrows?: boolean;
  searchResult?: number[];
  bodyStructure?: unknown;
  idleGate?: () => Promise<void>;
  /** Folders whose mailboxOpen blows up, the way an unreadable share does. */
  openFails?: string[];
  moveResult?: { uidValidity?: bigint; uidMap?: Map<number, number> } | false;
  /** Makes MOVE blow up the way a server that refuses the destination does. */
  moveThrows?: boolean;
}

/** The fake honours UID ranges ("5", "1,2,3", "9:*", "100:300") so the paged
 *  backfill and the flag re-scan are exercised against real slicing rather than
 *  a client that hands back every message whatever it was asked for. */
const inUidRange = (range: unknown, uid: number): boolean => {
  if (typeof range !== 'string') return true;                 // { since: … } and friends
  return range.split(',').some(part => {
    const [lo, hi] = part.split(':');
    if (hi === undefined) return uid === Number(lo);
    return uid >= Number(lo) && uid <= (hi === '*' ? Infinity : Number(hi));
  });
};

const DEFAULT_FOLDERS: FakeFolder[] = [
  { path: 'INBOX', name: 'INBOX', specialUse: '\\Inbox', flags: new Set() },
  { path: 'Sent Items', name: 'Sent Items', flags: new Set() },
  { path: 'Drafts', name: 'Drafts', specialUse: '\\Drafts', flags: new Set() },
  { path: 'Trash', name: 'Trash', specialUse: '\\Trash', flags: new Set() },
  { path: 'Archive', name: 'Archive', specialUse: '\\Archive', flags: new Set() },
  { path: 'Junk', name: 'Junk', specialUse: '\\Junk', flags: new Set() },
  { path: 'Broken', name: 'Broken', flags: new Set(['\\Noselect']) },
];

const RFC822 = 'From: a@b.com\r\nSubject: s\r\nContent-Type: text/html; charset=utf-8\r\n\r\n<p>Body</p>';

function fakeClient(script: Script) {
  const client = {
    mailbox: null as null | { path: string; uidValidity: bigint; uidNext: number; exists: number },
    calls: [] as unknown[][],
    listeners: new Map<string, Array<(...a: unknown[]) => void>>(),
    connected: false,
    loggedOut: 0,
    idleCount: 0,
    async connect() {
      client.calls.push(['connect']);
      if (script.authFail) {
        const e = new Error('Invalid credentials for u@example.com') as Error & { authenticationFailed: boolean };
        e.authenticationFailed = true;
        throw e;
      }
      client.connected = true;
    },
    async logout() { client.loggedOut += 1; client.connected = false; client.calls.push(['logout']); },
    async list() { return (script.folders ?? DEFAULT_FOLDERS).map(f => ({ delimiter: '/', name: f.path, ...f })); },
    async mailboxOpen(path: string) {
      const msgs = script.messages?.[path] ?? [];
      client.calls.push(['mailboxOpen', path]);
      if (script.openFails?.includes(path)) throw new Error(`[NONEXISTENT] no such mailbox ${path}`);
      client.mailbox = { path, uidValidity: 7n, uidNext: script.uidNext?.[path] ?? 1, exists: msgs.length };
      return client.mailbox;
    },
    async *fetch(range: unknown, q: unknown, opts: unknown) {
      client.calls.push(['fetch', range, opts, q]);
      for (const m of script.messages?.[client.mailbox!.path] ?? []) if (inUidRange(range, m.uid)) yield m;
    },
    async fetchOne(range: unknown, _q: unknown, opts: unknown) {
      client.calls.push(['fetchOne', range, opts]);
      return { uid: Number(range), bodyStructure: script.bodyStructure ?? BS_WITH_PDF };
    },
    async download(range: unknown, part: unknown, opts: unknown) {
      client.calls.push(['download', range, part, opts]);
      // imapflow reports expectedSize as RFC822.SIZE — the WHOLE message —
      // even when a single part is being streamed, hence the mismatch here.
      return part
        ? { content: Readable.from(Buffer.from('%PDF')), meta: { contentType: 'application/pdf', filename: 'a.pdf', expectedSize: 98765 } }
        : { content: Readable.from(Buffer.from(RFC822)), meta: { contentType: 'message/rfc822', expectedSize: RFC822.length } };
    },
    async messageFlagsAdd(range: unknown, flags: string[]) { client.calls.push(['add', range, flags]); return true; },
    async messageFlagsRemove(range: unknown, flags: string[]) { client.calls.push(['remove', range, flags]); return true; },
    async messageMove(range: unknown, dest: string) {
      client.calls.push(['move', range, dest]);
      if (script.moveThrows) throw new Error('[CANNOT] move refused');
      return script.moveResult === undefined ? {} : script.moveResult;
    },
    async messageDelete(range: unknown) { client.calls.push(['delete', range]); return true; },
    async append(path: string, _raw: Buffer, flags: string[]) {
      client.calls.push(['append', path, flags]);
      if (script.appendThrows) throw new Error('APPEND rejected');
      return script.appendResult === undefined ? { uid: 99, uidValidity: 7n } : script.appendResult;
    },
    async search(query: unknown) {
      client.calls.push(['search', query]);
      if (script.searchResult) return script.searchResult;
      // A backfill's SINCE search: answer with the UIDs actually in the box.
      if (query && typeof query === 'object' && 'since' in (query as object)) {
        return (script.messages?.[client.mailbox!.path] ?? []).map(m => m.uid);
      }
      return [];
    },
    async idle() { client.idleCount += 1; client.calls.push(['idle']); await (script.idleGate?.() ?? Promise.resolve()); return true; },
    on(event: string, fn: (...a: unknown[]) => void) {
      client.listeners.set(event, [...(client.listeners.get(event) ?? []), fn]);
      return client;
    },
    emit(event: string, ...args: unknown[]) { (client.listeners.get(event) ?? []).forEach(f => f(...args)); },
  };
  return client;
}
type FakeClient = ReturnType<typeof fakeClient>;

const BS_WITH_PDF = {
  type: 'multipart/mixed',
  childNodes: [
    { part: '1', type: 'text/plain', size: 10 },
    { part: '2', type: 'application/pdf', disposition: 'attachment', dispositionParameters: { filename: 'a.pdf' }, size: 4 },
  ],
};

const auth: ImapAuth = {
  imapHost: 'h', imapPort: 993, imapSecure: true,
  smtpHost: 's', smtpPort: 587, smtpSecure: false,
  username: 'u@example.com', password: 'hunter2-secret',
};

const env = (uid: number, o: Record<string, unknown> = {}): FakeMsg => ({
  uid,
  envelope: {
    messageId: `<M${uid}@X>`, subject: 'Hello',
    from: [{ address: 'A@B.com', name: 'A' }], to: [{ address: 'me@x' }], cc: [],
    date: new Date('2026-08-10T00:00:00Z'), inReplyTo: null,
  },
  flags: new Set<string>(),
  size: 123,
  internalDate: new Date('2026-08-10T00:00:00Z'),
  headers: Buffer.from('References: <r@x>\r\n'),
  bodyStructure: { type: 'text/plain', part: '1' },
  ...o,
});

const provider = (c: FakeClient, extra: Record<string, unknown> = {}) =>
  new ImapMailProvider(auth, { fromAddress: 'me@x', clientFactory: () => c, ...extra });

const outgoing = {
  from: { addr: 'me@x' }, to: [{ addr: 'y@z' }], cc: [], bcc: [{ addr: 'b@z' }],
  subject: 's', html: '<p>h</p>', text: 'h', attachments: [], messageIdHeader: 'mid@x',
};

// ---------------------------------------------------------------------------

describe('parsePmid / makePmid', () => {
  it('round-trips folder paths that contain spaces', () => {
    const id = makePmid('Sent Items', 7, 99);
    expect(parsePmid(id)).toEqual({ folder: 'Sent Items', uidValidity: 7, uid: 99 });
  });
  it('round-trips a plain folder', () => {
    expect(parsePmid(makePmid('INBOX', 7, 5))).toEqual({ folder: 'INBOX', uidValidity: 7, uid: 5 });
  });
});

describe('ImapMailProvider', () => {
  it('lists selectable folders with roles (special-use and name fallback)', async () => {
    const c = fakeClient({});
    const f = await provider(c).listFolders();
    expect(f.find(x => x.providerId === 'INBOX')!.role).toBe('inbox');
    expect(f.find(x => x.providerId === 'Sent Items')!.role).toBe('sent');   // name fallback, no specialUse
    expect(f.find(x => x.providerId === 'Trash')!.role).toBe('trash');
    expect(f.find(x => x.providerId === 'Junk')!.role).toBe('spam');
    expect(f.some(x => x.providerId === 'Broken')).toBe(false);              // \Noselect dropped
    expect(c.loggedOut).toBe(1);
  });

  it('backfill maps envelopes (references from headers, flags, attachments) and skips trash/spam', async () => {
    const c = fakeClient({
      messages: {
        INBOX: [env(5, {
          flags: new Set(['\\Seen', '\\Flagged']),
          bodyStructure: BS_WITH_PDF,
        })],
        Trash: [env(6)],
        Junk: [env(7)],
      },
    });
    const r = await provider(c).backfill({ since: new Date('2026-01-01') });
    expect(r.done).toBe(true);
    expect(r.messages).toHaveLength(1);
    const m = r.messages[0];
    expect(parsePmid(m.providerMessageId)).toEqual({ folder: 'INBOX', uidValidity: 7, uid: 5 });
    expect(m).toMatchObject({
      messageIdHeader: 'm5@x', references: ['r@x'], isRead: true, isStarred: true, isDraft: false,
      subject: 'Hello', from: { addr: 'a@b.com', name: 'A' }, folderProviderIds: ['INBOX'],
      sizeBytes: 123, date: '2026-08-10T00:00:00.000Z',
    });
    expect(m.attachments).toEqual([{ attId: '2', name: 'a.pdf', mime: 'application/pdf', size: 4 }]);
    // SINCE-limited server-side search, not a full folder walk
    expect(c.calls.some(x => x[0] === 'search' && (x[1] as { since?: Date }).since instanceof Date)).toBe(true);
  });

  // A first sync of a big mailbox used to build ONE array of every message and
  // hand it over in a single transaction. It is paged now, 500 at a time.
  it('backfill pages a large folder and reports done only on the last call', async () => {
    const many = Array.from({ length: 1200 }, (_, i) => env(i + 1));
    const c = fakeClient({ messages: { INBOX: many } });
    const p = provider(c);
    const uids: number[] = [];
    let cursor: string | undefined;
    let calls = 0;
    let done = false;
    while (!done) {
      const r = await p.backfill({ since: new Date('2026-01-01'), cursor });
      calls += 1;
      uids.push(...r.messages.map(m => parsePmid(m.providerMessageId).uid));
      cursor = r.cursor;
      done = r.done;
      expect(r.messages.length).toBeLessThanOrEqual(500);
      if (!done) expect(r.cursor).toBeTruthy();
      expect(calls).toBeLessThan(10);                       // never a runaway loop
    }
    expect(calls).toBe(3);
    expect(uids).toEqual(many.map(m => m.uid));             // every message, exactly once
  });

  it('backfill resumes mid-folder from a cursor and survives a corrupt one', async () => {
    const c = fakeClient({ messages: { INBOX: [env(1), env(2), env(3)] } });
    const p = provider(c);
    const resumed = await p.backfill({ since: new Date('2026-01-01'), cursor: JSON.stringify({ folderIndex: 0, lastUid: 2 }) });
    expect(resumed.messages.map(m => parsePmid(m.providerMessageId).uid)).toEqual([3]);
    const garbage = await p.backfill({ since: new Date('2026-01-01'), cursor: 'not json' });
    expect(garbage.messages.map(m => parsePmid(m.providerMessageId).uid)).toEqual([1, 2, 3]);
  });

  // Gmail over IMAP puts a copy of every message in All Mail. Indexing that too
  // would give each message a second row under a different UID.
  it('skips the Gmail All Mail folder when syncing but still lists it', async () => {
    const folders = [...DEFAULT_FOLDERS, { path: '[Gmail]/All Mail', name: 'All Mail', specialUse: '\\All', flags: new Set<string>() }];
    const messages = { INBOX: [env(5)], '[Gmail]/All Mail': [env(5)] };
    const c = fakeClient({ folders, messages });
    const p = provider(c);

    expect((await p.listFolders()).some(f => f.providerId === '[Gmail]/All Mail')).toBe(true);

    const b = await p.backfill({ since: new Date('2026-01-01') });
    expect(b.messages.map(m => parsePmid(m.providerMessageId).folder)).toEqual(['INBOX']);

    const inc = await p.incremental({});
    expect(Object.keys((inc.state as { folders: Record<string, unknown> }).folders)).not.toContain('[Gmail]/All Mail');

    const found = await p.search('Hello', { limit: 10 });
    expect(found.every(m => parsePmid(m.providerMessageId).folder !== '[Gmail]/All Mail')).toBe(true);
    expect(c.calls).not.toContainEqual(['mailboxOpen', '[Gmail]/All Mail']);
  });

  it('incremental fetches UIDs above lastUid per folder and advances state', async () => {
    const c = fakeClient({ messages: { INBOX: [env(9)] }, uidNext: { 'Sent Items': 4 } });
    const r = await provider(c).incremental({ folders: { INBOX: { uidValidity: 7, lastUid: 8 } } });
    expect(r.upserts.map(u => parsePmid(u.providerMessageId).uid)).toEqual([9]);   // deduped: the flag re-scan must not double-emit
    const st = r.state as { folders: Record<string, { uidValidity: number; lastUid: number }> };
    // the new message's flag code is seeded so the next poll does not re-emit it
    expect(st.folders.INBOX).toEqual({ uidValidity: 7, lastUid: 9, flags: { 9: '' } });
    // an unseen folder is adopted at its current head, not backfilled
    expect(st.folders['Sent Items']).toEqual({ uidValidity: 7, lastUid: 3 });
    expect(c.calls.some(x => x[0] === 'fetch' && x[1] === '9:*')).toBe(true);
  });

  it('incremental re-scans recent UIDs so flag changes made elsewhere are picked up', async () => {
    const c = fakeClient({ messages: { INBOX: [env(9)] } });
    await provider(c).incremental({ folders: { INBOX: { uidValidity: 7, lastUid: 300 } } });
    // ...and reads only the flags for that window, never whole envelopes
    expect(c.calls).toContainEqual(['fetch', '100:300', { uid: true }, { uid: true, flags: true }]);
  });

  it('incremental restarts a folder when UIDVALIDITY changed, without emitting stale ids', async () => {
    const c = fakeClient({ messages: { INBOX: [env(9)] }, uidNext: { INBOX: 12 } });
    const r = await provider(c).incremental({ folders: { INBOX: { uidValidity: 3, lastUid: 40 } } });
    expect(r.upserts.filter(u => parsePmid(u.providerMessageId).folder === 'INBOX')).toHaveLength(0);
    const st = r.state as { folders: Record<string, { uidValidity: number; lastUid: number }> };
    expect(st.folders.INBOX).toEqual({ uidValidity: 7, lastUid: 11 });
  });

  // The re-scan window used to re-emit every envelope in it on every poll, and
  // the engine treats each upsert as a change. Now it compares flag codes.
  it('a second incremental with nothing changed emits no upserts', async () => {
    const msg = env(9);
    const c = fakeClient({ messages: { INBOX: [msg] } });
    const p = provider(c);
    const first = await p.incremental({ folders: { INBOX: { uidValidity: 7, lastUid: 8 } } });
    expect(first.upserts).toHaveLength(1);
    const second = await p.incremental(first.state);
    expect(second.upserts).toEqual([]);
  });

  it('incremental emits exactly the UID whose flags changed', async () => {
    const msg = env(9);
    const c = fakeClient({ messages: { INBOX: [msg] } });
    const p = provider(c);
    const first = await p.incremental({ folders: { INBOX: { uidValidity: 7, lastUid: 8 } } });
    const second = await p.incremental(first.state);
    msg.flags = new Set(['\\Seen']);                       // read in another client
    const third = await p.incremental(second.state);
    expect(third.upserts.map(u => parsePmid(u.providerMessageId).uid)).toEqual([9]);
    expect(third.upserts[0].isRead).toBe(true);           // the full envelope, not just flags
    const fourth = await p.incremental(third.state);
    expect(fourth.upserts).toEqual([]);                   // and it settles again
  });

  it('incremental tolerates an empty/absent prior state', async () => {
    const c = fakeClient({});
    const r = await provider(c).incremental({});
    expect(r.upserts).toEqual([]);
    expect(Object.keys((r.state as { folders: Record<string, unknown> }).folders).length).toBeGreaterThan(0);
  });

  it('one unreadable folder does not abort the rest of the sync', async () => {
    const c = fakeClient({ openFails: ['Drafts'], messages: { INBOX: [env(5)], Archive: [env(6)] } });
    const r = await provider(c).backfill({ since: new Date('2026-01-01') });
    expect(r.messages.map(m => parsePmid(m.providerMessageId).uid).sort()).toEqual([5, 6]);
  });

  it('incremental keeps a folder cursor it could not read this time', async () => {
    const c = fakeClient({ openFails: ['INBOX'], messages: { INBOX: [env(9)] } });
    const r = await provider(c).incremental({ folders: { INBOX: { uidValidity: 7, lastUid: 8 } } });
    expect(r.upserts).toEqual([]);
    expect((r.state as { folders: Record<string, unknown> }).folders.INBOX).toEqual({ uidValidity: 7, lastUid: 8 });
  });

  it('getBody parses the downloaded RFC822 and reports attachments from BODYSTRUCTURE', async () => {
    const c = fakeClient({});
    const b = await provider(c).getBody(makePmid('INBOX', 7, 5));
    expect(b.html).toContain('<p>Body</p>');
    expect(b.attachments).toEqual([{ attId: '2', name: 'a.pdf', mime: 'application/pdf', size: 4 }]);
    expect(c.calls).toContainEqual(['download', '5', undefined, { uid: true }]);
    expect(c.loggedOut).toBe(1);
  });

  it('getAttachment downloads the BODYSTRUCTURE part and closes the client when the stream ends', async () => {
    const c = fakeClient({});
    const a = await provider(c).getAttachment(makePmid('INBOX', 7, 5), '2');
    expect(a.mime).toBe('application/pdf');
    expect(a.name).toBe('a.pdf');
    // expectedSize is the whole message; reporting it would set a Content-Length
    // far larger than the part and stall the download.
    expect(a.size).toBeUndefined();
    expect(c.calls).toContainEqual(['download', '5', '2', { uid: true }]);
    const chunks: Buffer[] = [];
    for await (const ch of a.stream) chunks.push(ch as Buffer);
    expect(Buffer.concat(chunks).toString()).toBe('%PDF');
    await new Promise(r => setImmediate(r));
    expect(c.loggedOut).toBe(1);
  });

  it('setFlags translates read/starred into IMAP flag ops', async () => {
    const c = fakeClient({});
    await provider(c).setFlags([makePmid('INBOX', 7, 5), makePmid('INBOX', 7, 6)], { read: true, starred: false });
    expect(c.calls).toContainEqual(['add', '5,6', ['\\Seen']]);
    expect(c.calls).toContainEqual(['remove', '5,6', ['\\Flagged']]);
    await provider(c).setFlags([makePmid('INBOX', 7, 5)], { read: false, starred: true });
    expect(c.calls).toContainEqual(['remove', '5', ['\\Seen']]);
    expect(c.calls).toContainEqual(['add', '5', ['\\Flagged']]);
  });

  it('move/trash/archive move the UIDs to the right mailbox', async () => {
    const c = fakeClient({});
    await provider(c).trash([makePmid('INBOX', 7, 5)]);
    expect(c.calls).toContainEqual(['move', '5', 'Trash']);
    await provider(c).archive([makePmid('INBOX', 7, 5)]);
    expect(c.calls).toContainEqual(['move', '5', 'Archive']);
    await provider(c).move([makePmid('INBOX', 7, 5)], 'Later');
    expect(c.calls).toContainEqual(['move', '5', 'Later']);
  });

  // A MOVE re-numbers the message: the caller must learn the new id or it keeps
  // a row pointing at nothing and re-indexes the moved copy as a duplicate.
  it('move reports the new providerMessageId from the MOVE uidMap', async () => {
    const c = fakeClient({ moveResult: { uidValidity: 9n, uidMap: new Map([[5, 77], [6, 78]]) } });
    const r = await provider(c).move([makePmid('INBOX', 7, 5), makePmid('INBOX', 7, 6)], 'Later');
    expect(r).toEqual([
      { from: 'INBOX 7 5', to: 'Later 9 77' },
      { from: 'INBOX 7 6', to: 'Later 9 78' },
    ]);
  });

  it('move reports null when the server sends no UIDPLUS mapping', async () => {
    const c = fakeClient({ moveResult: {} });
    expect(await provider(c).trash([makePmid('INBOX', 7, 5)])).toEqual([{ from: 'INBOX 7 5', to: null }]);
  });

  // "moved but unnamed" and "not moved at all" must not look alike: the caller
  // deletes/re-files a row for the first and has to put it back for the second.
  it('move flags a refused MOVE as failed rather than as an unnamed success', async () => {
    const c = fakeClient({ moveThrows: true });
    expect(await provider(c).trash([makePmid('INBOX', 7, 5)]))
      .toEqual([{ from: 'INBOX 7 5', to: null, failed: true }]);
  });

  it('move reports a null mapping for an id that never named a server message', async () => {
    const c = fakeClient({});
    expect(await provider(c).trash(['sent:unappended:mid@x'])).toEqual([{ from: 'sent:unappended:mid@x', to: null }]);
  });

  it('groups ops per source folder', async () => {
    const c = fakeClient({});
    await provider(c).setFlags([makePmid('INBOX', 7, 5), makePmid('Sent Items', 7, 8)], { read: true });
    expect(c.calls).toContainEqual(['mailboxOpen', 'INBOX']);
    expect(c.calls).toContainEqual(['mailboxOpen', 'Sent Items']);
    expect(c.calls).toContainEqual(['add', '5', ['\\Seen']]);
    expect(c.calls).toContainEqual(['add', '8', ['\\Seen']]);
  });

  it('send goes out over SMTP and appends a \\Seen copy to Sent', async () => {
    const c = fakeClient({});
    const sent: Array<Record<string, unknown>> = [];
    const p = provider(c, { transportFactory: () => ({ sendMail: async (o: Record<string, unknown>) => { sent.push(o); return {}; } }) });
    const r = await p.send(outgoing);
    expect(sent).toHaveLength(1);
    expect(sent[0].envelope).toEqual({ from: 'me@x', to: ['y@z', 'b@z'] });   // bcc rides the envelope only
    expect(String(sent[0].raw)).toContain('Message-ID: <mid@x>');
    expect(c.calls).toContainEqual(['append', 'Sent Items', ['\\Seen']]);
    expect(parsePmid(r.providerMessageId)).toEqual({ folder: 'Sent Items', uidValidity: 7, uid: 99 });
  });

  // Servers without UIDPLUS answer APPEND without a UID; the copy is still
  // there, so look it up by Message-ID rather than losing track of it.
  it('send finds the appended copy by Message-ID when APPEND reports no uid', async () => {
    const c = fakeClient({ appendResult: false, searchResult: [42] });
    const p = provider(c, { transportFactory: () => ({ sendMail: async () => ({}) }) });
    const r = await p.send(outgoing);
    expect(c.calls).toContainEqual(['search', { header: { 'message-id': 'mid@x' } }]);
    expect(parsePmid(r.providerMessageId)).toEqual({ folder: 'Sent Items', uidValidity: 7, uid: 42 });
  });

  it('saveDraft finds the appended draft by Message-ID when APPEND reports no uid', async () => {
    const c = fakeClient({ appendResult: false, searchResult: [43] });
    const r = await provider(c).saveDraft(outgoing);
    expect(parsePmid(r.providerMessageId)).toEqual({ folder: 'Drafts', uidValidity: 7, uid: 43 });
  });

  it('saveDraft fails loudly when the appended draft cannot be located', async () => {
    const c = fakeClient({ appendResult: false, searchResult: [] });
    await expect(provider(c).saveDraft(outgoing)).rejects.toThrow(/draft/i);
    expect(c.loggedOut).toBe(1);
  });

  it('send still succeeds when the Sent append fails', async () => {
    const c = fakeClient({ appendThrows: true });
    const p = provider(c, { transportFactory: () => ({ sendMail: async () => ({}) }) });
    const r = await p.send(outgoing);
    expect(r.providerMessageId).toContain('mid@x');
  });

  it('send maps an SMTP auth rejection to AuthExpiredError without echoing the password', async () => {
    const c = fakeClient({});
    const p = provider(c, {
      transportFactory: () => ({ sendMail: async () => { throw Object.assign(new Error('Invalid login'), { code: 'EAUTH', responseCode: 535 }); } }),
    });
    const err = await p.send(outgoing).catch((e: Error) => e);
    expect(err).toBeInstanceOf(AuthExpiredError);
    expect((err as Error).message).toMatch(/SMTP/);
    expect((err as Error).message).not.toContain(auth.password);
  });

  // 530 is nearly always "must issue STARTTLS first" — a server-settings fault.
  // Calling it an auth expiry would tell the user to retype a working password.
  it('send does not treat a 530 STARTTLS refusal as an auth failure', async () => {
    const c = fakeClient({});
    const p = provider(c, {
      transportFactory: () => ({ sendMail: async () => { throw Object.assign(new Error('530 5.7.0 Must issue a STARTTLS command first'), { code: 'ESOCKET', responseCode: 530 }); } }),
    });
    const err = await p.send(outgoing).catch((e: Error) => e);
    expect(err).not.toBeInstanceOf(AuthExpiredError);
    expect((err as Error).message).toMatch(/STARTTLS/);
  });

  it('saveDraft appends to Drafts and replaces the previous draft', async () => {
    const c = fakeClient({});
    const r = await provider(c).saveDraft(outgoing, makePmid('Drafts', 7, 12));
    expect(c.calls).toContainEqual(['delete', '12']);
    expect(c.calls).toContainEqual(['append', 'Drafts', ['\\Draft', '\\Seen']]);
    expect(parsePmid(r.providerMessageId).folder).toBe('Drafts');
  });

  it('deleteDraft deletes by uid in its own folder', async () => {
    const c = fakeClient({});
    await provider(c).deleteDraft(makePmid('Drafts', 7, 12));
    expect(c.calls).toContainEqual(['mailboxOpen', 'Drafts']);
    expect(c.calls).toContainEqual(['delete', '12']);
  });

  it('search runs an OR query per folder and caps the result', async () => {
    const c = fakeClient({ searchResult: [5], messages: { INBOX: [env(5)], 'Sent Items': [env(5)] } });
    const out = await provider(c).search('roof', { limit: 1 });
    expect(out).toHaveLength(1);
    const q = c.calls.find(x => x[0] === 'search')![1] as { or: Array<Record<string, string>> };
    expect(q.or).toEqual([{ subject: 'roof' }, { from: 'roof' }, { body: 'roof' }]);
  });

  it('authentication failure becomes AuthExpiredError and never leaks credentials', async () => {
    const c = fakeClient({ authFail: true });
    const p = provider(c);
    const err = await p.listFolders().catch((e: Error) => e);
    expect(err).toBeInstanceOf(AuthExpiredError);
    expect((err as Error).message).toMatch(/IMAP/);
    expect((err as Error).message).not.toContain(auth.username);
    expect((err as Error).message).not.toContain(auth.password);
  });

  it('logs out even when the operation throws', async () => {
    const c = fakeClient({});
    c.list = async () => { throw new Error('boom'); };
    await expect(provider(c).listFolders()).rejects.toThrow('boom');
    expect(c.loggedOut).toBe(1);
  });

  it('getBody on a missing message reports ProviderNotFoundError', async () => {
    const c = fakeClient({});
    c.download = (async () => ({ content: null, meta: {} })) as unknown as FakeClient['download'];
    await expect(provider(c).getBody(makePmid('INBOX', 7, 5))).rejects.toBeInstanceOf(ProviderNotFoundError);
    expect(c.loggedOut).toBe(1);
  });

  // Reconnecting on rejected credentials just fails forever on a timer.
  it('startPush gives up on an auth failure and reports it once', async () => {
    const c = fakeClient({ authFail: true });
    const p = provider(c, { pushRearmMs: 0, pushBackoffMs: 0 });
    const errs: Error[] = [];
    await p.startPush(() => {}, e => errs.push(e));
    await new Promise(r => setTimeout(r, 20));
    const attempts = c.calls.filter(x => x[0] === 'connect').length;
    expect(attempts).toBe(1);
    expect(errs).toHaveLength(1);
    expect(errs[0]).toBeInstanceOf(AuthExpiredError);
    await new Promise(r => setTimeout(r, 20));
    expect(c.calls.filter(x => x[0] === 'connect').length).toBe(1);   // no reconnect loop
    await p.startPush(() => {}, e => errs.push(e));                   // and it stays down
    await new Promise(r => setTimeout(r, 10));
    expect(c.calls.filter(x => x[0] === 'connect').length).toBe(1);
  });

  it('startPush idles on INBOX, calls back on exists, and stops cleanly', async () => {
    let release = () => {};
    const gate = () => new Promise<void>(r => { release = r; });
    const c = fakeClient({ idleGate: gate });
    const p = provider(c, { pushRearmMs: 0, pushBackoffMs: 0 });
    let changes = 0;
    await p.startPush(() => { changes += 1; });
    await new Promise(r => setImmediate(r));
    expect(c.calls).toContainEqual(['mailboxOpen', 'INBOX']);
    c.emit('exists', { path: 'INBOX', count: 2, prevCount: 1 });
    expect(changes).toBe(1);
    await p.stopPush();
    release();
    await new Promise(r => setTimeout(r, 5));
    const idlesAtStop = c.idleCount;
    await new Promise(r => setTimeout(r, 10));
    expect(c.idleCount).toBe(idlesAtStop);   // loop really stopped
    expect(c.loggedOut).toBeGreaterThan(0);
  });

  // stopPush cannot wait for a loop parked inside idle(): the socket only lets
  // go when it closes. So the OLD loop wakes up after the new one is already
  // running, and without an epoch it would keep idling (and firing onChange)
  // alongside it forever.
  it('a stop → start cycle leaves exactly one live IDLE loop', async () => {
    const releases: Array<() => void> = [];
    const c = fakeClient({ idleGate: () => new Promise<void>(r => releases.push(r)) });
    const p = provider(c, { pushRearmMs: 0, pushBackoffMs: 0 });
    const settle = () => new Promise(r => setTimeout(r, 10));

    let changes = 0;
    await p.startPush(() => { changes += 1; });
    await settle();
    await p.stopPush();
    await p.startPush(() => { changes += 1; });
    await settle();
    expect(releases).toHaveLength(2);                    // the stopped loop is still parked

    releases.splice(0).forEach(r => r());                // both idles settle at once
    await settle();
    // Only the loop started last re-arms; the first sees a newer epoch and exits.
    expect(releases).toHaveLength(1);

    changes = 0;
    c.emit('exists', { path: 'INBOX' });
    expect(changes).toBe(1);                             // and only one loop reports the change
    await p.stopPush();
    releases.splice(0).forEach(r => r());
    await settle();
  });
});
