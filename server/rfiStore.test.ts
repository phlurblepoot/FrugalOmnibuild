// server/rfiStore.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import type Database from 'better-sqlite3';
import { openDb } from './db';
import { runMigrations } from './migrations';
import { migrations } from './migrationList';
import { putBuffer } from './files';
import {
  RFI_STATUSES, getRfi, listRfis, createRfi, saveRfi, setRfiStatus,
  deleteRfi, addPhoto, removePhoto, addAttachment, updateAttachment, removeAttachment, markRfiSent, setRfiResponse,
  setPendingReply, acceptPendingReply, dismissPendingReply,
  ValidationError, ConflictError, NotFoundError, NoPendingReplyError,
} from './rfiStore';

let db: Database.Database;
let dir: string;

beforeEach(() => {
  db = openDb(':memory:');
  dir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-rfi-'));
  runMigrations(db, dir, migrations);
  db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p1', 'Proj', 1);
  db.prepare('INSERT INTO projects (id, name, createdAt) VALUES (?, ?, ?)').run('p2', 'Proj2', 1);
});

describe('rfiStore', () => {
  it('numbers RFIs sequentially per project', () => {
    const a = createRfi(db, 'p1', { title: 'A' });
    const b = createRfi(db, 'p1', { title: 'B' });
    const c = createRfi(db, 'p2', { title: 'C' }); // separate project sequence
    expect(a.number).toBe(1);
    expect(b.number).toBe(2);
    expect(c.number).toBe(1);
  });

  it('never reuses a deleted RFI number', () => {
    createRfi(db, 'p1', { title: 'a' });                      // RFI-001
    const b = createRfi(db, 'p1', { title: 'b' });            // RFI-002
    deleteRfi(db, b.id);
    expect(createRfi(db, 'p1', { title: 'c' }).number).toBe(3); // not 2
  });

  it('continues numbering after all RFIs are deleted', () => {
    const a = createRfi(db, 'p1', { title: 'a' });
    const b = createRfi(db, 'p1', { title: 'b' });
    deleteRfi(db, a.id);
    deleteRfi(db, b.id);
    expect(createRfi(db, 'p1', { title: 'c' }).number).toBe(3); // not 1
  });

  it('recovers when the counter is behind existing rows (max guard)', () => {
    createRfi(db, 'p1', { title: 'a' });                       // counter → 1
    db.prepare('UPDATE projects SET rfiCounter = 0 WHERE id = ?').run('p1');
    expect(createRfi(db, 'p1', { title: 'b' }).number).toBe(2); // MAX guard wins
  });

  it('requires a title on create', () => {
    expect(() => createRfi(db, 'p1', {})).toThrow(ValidationError);
  });

  it('rejects create for unknown project', () => {
    expect(() => createRfi(db, 'nope', { title: 'x' })).toThrow(NotFoundError);
  });

  it('stores header fields on create and save', () => {
    const { id } = createRfi(db, 'p1', {
      title: 'A',
      question: 'Q1',
      specRef: 'Spec 1',
      drawingRef: 'A-101',
      attention: 'Jane',
      responseNeededBy: '2026-08-01',
    });
    const rfi = getRfi(db, id)!;
    expect(rfi.title).toBe('A');
    expect(rfi.question).toBe('Q1');
    expect(rfi.specRef).toBe('Spec 1');
    expect(rfi.drawingRef).toBe('A-101');
    expect(rfi.attention).toBe('Jane');
    expect(rfi.responseNeededBy).toBe('2026-08-01');
    expect(rfi.status).toBe('open');
    expect(rfi.version).toBe(1);

    const r = saveRfi(db, id, {
      version: 1,
      title: 'A2',
      question: 'Q2',
      specRef: 'Spec 2',
      drawingRef: 'A-102',
      attention: 'John',
      responseNeededBy: '2026-08-15',
    });
    expect(r.version).toBe(2);

    const reloaded = getRfi(db, id)!;
    expect(reloaded.title).toBe('A2');
    expect(reloaded.question).toBe('Q2');
    expect(reloaded.specRef).toBe('Spec 2');
    expect(reloaded.drawingRef).toBe('A-102');
    expect(reloaded.attention).toBe('John');
    expect(reloaded.responseNeededBy).toBe('2026-08-15');
    expect(reloaded.version).toBe(2);
  });

  it('save is version-checked', () => {
    const { id } = createRfi(db, 'p1', { title: 'A' });
    const rfi = getRfi(db, id)!;
    expect(() => saveRfi(db, id, { ...rfi, title: 'A2', version: 99 })).toThrow(ConflictError);
    expect(() => saveRfi(db, id, { title: 'A2' } as any)).toThrow(ValidationError);
    expect(() => saveRfi(db, 'nope', { title: 'X', version: 1 })).toThrow(NotFoundError);
  });

  it('validates status', () => {
    const { id } = createRfi(db, 'p1', { title: 'A' });
    expect(() => setRfiStatus(db, id, 'bogus')).toThrow(ValidationError);
    for (const status of RFI_STATUSES) {
      setRfiStatus(db, id, status);
      expect(getRfi(db, id)!.status).toBe(status);
    }
  });

  it('lists newest-first with photoCount', () => {
    const a = createRfi(db, 'p1', { title: 'A' });
    createRfi(db, 'p1', { title: 'B' });
    addPhoto(db, a.id, 'f1');
    addPhoto(db, a.id, 'f2');
    const list = listRfis(db, 'p1');
    expect(list.map(r => r.title)).toEqual(['B', 'A']);
    expect(list.find(r => r.id === a.id)!.photoCount).toBe(2);
    expect(list.find(r => r.title === 'B')!.photoCount).toBe(0);
  });

  it('delete cascades photo links', () => {
    const { id } = createRfi(db, 'p1', { title: 'A' });
    addPhoto(db, id, 'f1');
    deleteRfi(db, id);
    expect(getRfi(db, id)).toBeNull();
    expect((db.prepare('SELECT COUNT(*) c FROM rfi_photos').get() as any).c).toBe(0);
  });

  it('addPhoto is idempotent and validates', () => {
    const { id } = createRfi(db, 'p1', { title: 'A' });
    addPhoto(db, id, 'f1');
    addPhoto(db, id, 'f1'); // duplicate ignored
    expect(getRfi(db, id)!.photos).toHaveLength(1);
    expect(() => addPhoto(db, 'nope', 'f1')).toThrow(NotFoundError);
    expect(() => addPhoto(db, id, '')).toThrow(ValidationError);
  });

  it('removePhoto removes a photo link', () => {
    const { id } = createRfi(db, 'p1', { title: 'A' });
    addPhoto(db, id, 'f1');
    addPhoto(db, id, 'f2');
    removePhoto(db, id, 'f1');
    expect(getRfi(db, id)!.photos.map((p: any) => p.fileId)).toEqual(['f2']);
  });

  // PDF attachments: same contract as the invoice's, but with this RFI's photo
  // freshness rule — updatedAt moves, version does not.
  describe('attachments', () => {
    const pdfFile = (id: string) => putBuffer(db, dir, id, Buffer.from('%PDF'), 'application/pdf', { projectId: 'p1', kind: 'document', name: `${id}.pdf` });
    const stale = (id: string) => db.prepare('UPDATE rfis SET updatedAt = 1 WHERE id = ?').run(id);

    it('only an existing PDF can be attached, to an existing RFI', () => {
      const { id } = createRfi(db, 'p1', { title: 'A' });
      putBuffer(db, dir, 'img', Buffer.from('x'), 'image/jpeg', { projectId: 'p1', kind: 'rfi-photo', name: 'img.jpg' });
      expect(() => addAttachment(db, id, 'img')).toThrow(ValidationError);
      expect(() => addAttachment(db, id, 'missing')).toThrow(NotFoundError);
      expect(() => addAttachment(db, id, '')).toThrow(ValidationError);
      pdfFile('a1');
      expect(() => addAttachment(db, 'nope', 'a1')).toThrow(NotFoundError);
      expect(getRfi(db, id)!.attachments).toEqual([]);
    });

    it('adds idempotently in order, reorders, removes — stamping updatedAt but never version', () => {
      const { id } = createRfi(db, 'p1', { title: 'A' });
      pdfFile('a1'); pdfFile('a2');
      stale(id);
      addAttachment(db, id, 'a1');
      addAttachment(db, id, 'a1'); // idempotent
      addAttachment(db, id, 'a2');
      let rfi = getRfi(db, id)!;
      expect(rfi.attachments).toEqual([
        expect.objectContaining({ fileId: 'a1', sortOrder: 0, name: 'a1.pdf', mime: 'application/pdf' }),
        expect.objectContaining({ fileId: 'a2', sortOrder: 1, name: 'a2.pdf', mime: 'application/pdf' }),
      ]);
      expect(rfi.updatedAt).toBeGreaterThan(1);
      expect(rfi.version).toBe(1);

      stale(id);
      updateAttachment(db, id, 'a1', { sortOrder: 5 });
      rfi = getRfi(db, id)!;
      expect(rfi.attachments.map((a: any) => a.fileId)).toEqual(['a2', 'a1']);
      expect(rfi.updatedAt).toBeGreaterThan(1);
      expect(rfi.version).toBe(1);
      expect(() => updateAttachment(db, id, 'nope', { sortOrder: 0 })).toThrow(NotFoundError);
      expect(() => updateAttachment(db, id, 'a1', { sortOrder: 'x' as any })).toThrow(ValidationError);

      stale(id);
      removeAttachment(db, id, 'a1');
      rfi = getRfi(db, id)!;
      expect(rfi.attachments.map((a: any) => a.fileId)).toEqual(['a2']);
      expect(rfi.updatedAt).toBeGreaterThan(1);
      expect(rfi.version).toBe(1);
    });

    it('is separate from the response file', () => {
      const { id } = createRfi(db, 'p1', { title: 'A' });
      pdfFile('a1'); pdfFile('resp');
      addAttachment(db, id, 'a1');
      setRfiResponse(db, id, { fileId: 'resp' });
      const rfi = getRfi(db, id)!;
      expect(rfi.responseFileId).toBe('resp');
      expect(rfi.attachments.map((a: any) => a.fileId)).toEqual(['a1']);
    });

    it('delete cascades attachment links', () => {
      const { id } = createRfi(db, 'p1', { title: 'A' });
      pdfFile('a1');
      addAttachment(db, id, 'a1');
      deleteRfi(db, id);
      expect((db.prepare('SELECT COUNT(*) c FROM rfi_attachments').get() as any).c).toBe(0);
    });
  });

  it('markRfiSent sets status sent + sentAt', () => {
    const { id } = createRfi(db, 'p1', { title: 'A' });
    markRfiSent(db, id);
    const rfi = getRfi(db, id)!;
    expect(rfi.status).toBe('sent');
    expect(typeof rfi.sentAt).toBe('number');
  });

  // A send that changes no status writes only sentAt: version and updatedAt
  // stay put, because updatedAt is what the generated-PDF "up to date" chip
  // compares the stored file's createdAt against — bumping it here would mark
  // the just-emailed PDF stale the moment the send succeeded.
  it('markRfiSent does not demote an answered RFI, and leaves version/updatedAt alone', async () => {
    const { id } = createRfi(db, 'p1', { title: 'A' });
    setRfiResponse(db, id, { text: 'Answer' });
    const before = getRfi(db, id)! as any;
    expect(before.status).toBe('answered');
    await new Promise(r => setTimeout(r, 2));

    markRfiSent(db, id);
    const rfi = getRfi(db, id)! as any;
    expect(rfi.status).toBe('answered');
    expect(typeof rfi.sentAt).toBe('number');
    expect(rfi.version).toBe(before.version);
    expect(rfi.updatedAt).toBe(before.updatedAt);
  });

  it('markRfiSent does not demote a closed RFI, and leaves version/updatedAt alone', async () => {
    const { id } = createRfi(db, 'p1', { title: 'A' });
    setRfiStatus(db, id, 'closed');
    const before = getRfi(db, id)! as any;
    await new Promise(r => setTimeout(r, 2));

    markRfiSent(db, id);
    const rfi = getRfi(db, id)! as any;
    expect(rfi.status).toBe('closed');
    expect(typeof rfi.sentAt).toBe('number');
    expect(rfi.version).toBe(before.version);
    expect(rfi.updatedAt).toBe(before.updatedAt);
  });

  it('markRfiSent stamps updatedAt on the first send, but not on a re-send', async () => {
    const { id } = createRfi(db, 'p1', { title: 'A' });
    const created = getRfi(db, id)! as any;
    await new Promise(r => setTimeout(r, 2));

    markRfiSent(db, id); // open -> sent: a real transition
    const firstSend = getRfi(db, id)! as any;
    expect(firstSend.status).toBe('sent');
    expect(firstSend.updatedAt).toBeGreaterThan(created.updatedAt);
    await new Promise(r => setTimeout(r, 2));

    markRfiSent(db, id); // already sent: sentAt only
    const resent = getRfi(db, id)! as any;
    expect(resent.updatedAt).toBe(firstSend.updatedAt);
    expect(resent.version).toBe(firstSend.version);
    expect(resent.sentAt).toBeGreaterThan(firstSend.sentAt);
  });

  it('saveRfi and setRfiResponse bump updatedAt', async () => {
    const { id } = createRfi(db, 'p1', { title: 'A' });
    const before = (getRfi(db, id) as any).updatedAt;
    expect(typeof before).toBe('number');
    await new Promise(r => setTimeout(r, 2));
    saveRfi(db, id, { title: 'A2', version: 1 });
    const afterSave = (getRfi(db, id) as any).updatedAt;
    expect(afterSave).toBeGreaterThan(before);
    await new Promise(r => setTimeout(r, 2));
    setRfiResponse(db, id, { text: 'Answer' });
    expect((getRfi(db, id) as any).updatedAt).toBeGreaterThan(afterSave);
  });

  describe('setRfiResponse', () => {
    it('requires fileId or text', () => {
      const { id } = createRfi(db, 'p1', { title: 'A' });
      expect(() => setRfiResponse(db, id, {})).toThrow(ValidationError);
    });

    it('file response → answered + answeredAt + responseFileId', () => {
      const { id } = createRfi(db, 'p1', { title: 'A' });
      const r = setRfiResponse(db, id, { fileId: 'f1' });
      expect(r.status).toBe('answered');
      const rfi = getRfi(db, id)!;
      expect(rfi.status).toBe('answered');
      expect(typeof rfi.answeredAt).toBe('number');
      expect(rfi.responseFileId).toBe('f1');
    });

    it('text response → answered + responseText', () => {
      const { id } = createRfi(db, 'p1', { title: 'A' });
      const r = setRfiResponse(db, id, { text: 'The answer is X' });
      expect(r.status).toBe('answered');
      const rfi = getRfi(db, id)!;
      expect(rfi.status).toBe('answered');
      expect(rfi.responseText).toBe('The answer is X');
    });

    it('both can be set across calls without clobbering the other', () => {
      const { id } = createRfi(db, 'p1', { title: 'A' });
      setRfiResponse(db, id, { fileId: 'f1' });
      setRfiResponse(db, id, { text: 'Answer text' });
      const rfi = getRfi(db, id)!;
      expect(rfi.responseFileId).toBe('f1');
      expect(rfi.responseText).toBe('Answer text');
    });

    it('does not demote a closed RFI', () => {
      const { id } = createRfi(db, 'p1', { title: 'A' });
      setRfiStatus(db, id, 'closed');
      const r = setRfiResponse(db, id, { text: 'Late answer' });
      expect(r.status).toBe('closed');
      const rfi = getRfi(db, id)!;
      expect(rfi.status).toBe('closed');
      expect(rfi.responseText).toBe('Late answer');
    });

    it('unknown rfi → NotFoundError', () => {
      expect(() => setRfiResponse(db, 'nope', { text: 'x' })).toThrow(NotFoundError);
    });
  });

  describe('pending reply', () => {
    const reply = { threadKey: 'k', accountId: 'a', mailMessageId: 'm', messageIdHeader: 'x@y', from: { addr: 'gc@tidewater.example', name: 'Mike' }, date: '2026-08-29T10:00:00.000Z', text: 'Corridor 9ft', attachments: [], receivedAt: '2026-08-29T10:00:01.000Z' };
    it('only a sent RFI accepts a pending reply; status unchanged', () => {
      const { id } = createRfi(db, 'p1', { title: 't' });
      expect(setPendingReply(db, id, reply)).toBe(false); expect(getRfi(db, id).pendingReply).toBeNull();
      markRfiSent(db, id);
      expect(setPendingReply(db, id, reply)).toBe(true);
      const r = getRfi(db, id); expect(r.status).toBe('sent'); expect(r.pendingReply).toMatchObject({ text: 'Corridor 9ft', from: { addr: 'gc@tidewater.example' } }); expect(r.answeredAt).toBeNull();
    });
    it('a newer reply replaces the pending one', () => {
      const { id } = createRfi(db, 'p1', { title: 't' }); markRfiSent(db, id);
      setPendingReply(db, id, reply); setPendingReply(db, id, { ...reply, text: 'Updated', mailMessageId: 'm2' });
      expect(getRfi(db, id).pendingReply.text).toBe('Updated');
    });
    // The owner's freshness ruling: an email reply arriving or being dismissed
    // must not flip the generated-PDF "up to date" chip — that chip compares
    // updatedAt, so capture/dismiss may only bump version.
    it('capture and dismiss bump version but leave updatedAt untouched', () => {
      // Fake timers + an explicit tick between each step so a wrongly-bumped
      // updatedAt is guaranteed to differ, not just coincidentally equal
      // (real Date.now() let this assertion pass against the buggy code when
      // the calls landed in the same millisecond — see review).
      vi.useFakeTimers();
      try {
        vi.setSystemTime(new Date('2026-08-29T10:00:00.000Z'));
        const { id } = createRfi(db, 'p1', { title: 't' });
        markRfiSent(db, id);
        const before = getRfi(db, id)!;

        vi.setSystemTime(new Date('2026-08-29T10:01:00.000Z')); // +60s
        setPendingReply(db, id, reply);
        const afterCapture = getRfi(db, id)!;
        expect(afterCapture.version).toBe(before.version + 1);
        expect(afterCapture.updatedAt).toBe(before.updatedAt);

        vi.setSystemTime(new Date('2026-08-29T10:02:00.000Z')); // +60s more
        dismissPendingReply(db, id);
        const afterDismiss = getRfi(db, id)!;
        expect(afterDismiss.version).toBe(afterCapture.version + 1);
        expect(afterDismiss.updatedAt).toBe(before.updatedAt);
      } finally {
        vi.useRealTimers();
      }
    });
    it('accept sets the response, answered, source fields, clears pending; dismiss only clears', () => {
      const { id } = createRfi(db, 'p1', { title: 't' }); markRfiSent(db, id); setPendingReply(db, id, reply);
      expect(acceptPendingReply(db, id, { text: 'Corridor 9ft (edited)' })).toEqual({ status: 'answered' });
      const r = getRfi(db, id); expect(r.responseText).toBe('Corridor 9ft (edited)'); expect(r.responseSource).toBe('email'); expect(r.responseMessageIdHeader).toBe('x@y'); expect(r.pendingReply).toBeNull(); expect(r.answeredAt).toBeTruthy();
      const { id: id2 } = createRfi(db, 'p1', { title: 't2' }); markRfiSent(db, id2); setPendingReply(db, id2, reply); dismissPendingReply(db, id2);
      expect(getRfi(db, id2)).toMatchObject({ status: 'sent', pendingReply: null });
    });
    it('accepting nothing throws NoPendingReplyError (a conflict, not bad input)', () => {
      const { id } = createRfi(db, 'p1', { title: 't' }); markRfiSent(db, id);
      expect(() => acceptPendingReply(db, id, {})).toThrow(NoPendingReplyError);
      setPendingReply(db, id, reply); acceptPendingReply(db, id, {});
      expect(() => acceptPendingReply(db, id, {})).toThrow(NoPendingReplyError);   // second accept loses
      expect(() => acceptPendingReply(db, 'nope', {})).toThrow(NotFoundError);
    });
    it('accept without text/file uses the pending text', () => {
      const { id } = createRfi(db, 'p1', { title: 't' }); markRfiSent(db, id); setPendingReply(db, id, reply);
      acceptPendingReply(db, id, {}); expect(getRfi(db, id).responseText).toBe('Corridor 9ft');
    });
  });
});
