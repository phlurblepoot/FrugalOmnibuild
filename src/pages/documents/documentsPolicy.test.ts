// src/pages/documents/documentsPolicy.test.ts
import { describe, it, expect } from 'vitest';
import { selectionPolicy } from './documentsPolicy';
import { DocumentRow } from '../../utils/store';

const row = (over: Partial<DocumentRow>): DocumentRow => ({
  id: over.id ?? 'r1',
  name: 'file.pdf',
  mime: 'application/pdf',
  size: 100,
  kind: 'document',
  createdAt: 1,
  versionNumber: 1,
  archived: false,
  projectId: null,
  projectName: null,
  customerId: null,
  customerName: null,
  source: null,
  ...over,
});

describe('selectionPolicy', () => {
  it('downloadable is always every row, regardless of kind or source', () => {
    const rows = [
      row({ id: 'a', kind: 'invoice', source: { type: 'invoice', id: 'i1', label: 'Invoice #1', href: null } }),
      row({ id: 'b', kind: 'plan-source' }),
      row({ id: 'c', kind: 'document' }),
    ];
    expect(selectionPolicy(rows).downloadable).toEqual(rows);
  });

  it('archivable excludes plan-source rows only', () => {
    const rows = [
      row({ id: 'a', kind: 'plan-source' }),
      row({ id: 'b', kind: 'invoice', source: { type: 'invoice', id: 'i1', label: 'Invoice #1', href: null } }),
      row({ id: 'c', kind: 'document' }),
    ];
    const { archivable } = selectionPolicy(rows);
    expect(archivable.map(r => r.id)).toEqual(['b', 'c']);
  });

  it('deletable excludes rows with a resolved source (attached/generated)', () => {
    const rows = [
      row({ id: 'a', kind: 'document', source: null }),
      row({ id: 'b', kind: 'document', source: { type: 'invoice', id: 'i1', label: 'Invoice #1', href: null } }),
    ];
    expect(selectionPolicy(rows).deletable.map(r => r.id)).toEqual(['a']);
  });

  it('deletable excludes system-generated kinds even without a resolved source', () => {
    // e.g. a historical row whose source referent was deleted but the kind is
    // still a system kind, never a direct-upload one.
    const rows = [
      row({ id: 'a', kind: 'issue-report', source: null }),
      row({ id: 'b', kind: 'document', source: null }),
    ];
    expect(selectionPolicy(rows).deletable.map(r => r.id)).toEqual(['b']);
  });

  it('deletable includes custom:<id> kinds (treated as direct-upload)', () => {
    const rows = [row({ id: 'a', kind: 'custom:warranty', source: null })];
    expect(selectionPolicy(rows).deletable.map(r => r.id)).toEqual(['a']);
  });

  it('deletable includes every DIRECT_UPLOAD_KINDS value when unsourced', () => {
    const rows = ['document', 'spreadsheet', 'photo', 'other'].map(kind => row({ id: kind, kind, source: null }));
    expect(selectionPolicy(rows).deletable.map(r => r.id)).toEqual(['document', 'spreadsheet', 'photo', 'other']);
  });

  it('deletable includes takeoff prints/exports despite their source (nothing owns them)', () => {
    const rows = [
      row({ id: 'print', kind: 'takeoff-print', source: { type: 'takeoff-print', id: 'po-1', label: 'Takeoff Print', href: '/project/p1/takeoff' } }),
      row({ id: 'xls', kind: 'takeoff-export', source: { type: 'takeoff-print', id: 'po-2', label: 'Takeoff Export', href: '/project/p1/takeoff' } }),
      // a sourced document that IS owned by a record stays undeletable
      row({ id: 'prop', kind: 'proposal', source: { type: 'proposal', id: 'pr1', label: 'Proposal #1', href: null } }),
    ];
    expect(selectionPolicy(rows).deletable.map(r => r.id)).toEqual(['print', 'xls']);
  });

  // Attachments saved out of an email are copies (the message keeps the
  // original), so they're deletable when their kind is one a person picked
  // on save (direct-upload kinds + the 'email-attachment' default). Mirrors
  // server/documents.ts isContainerCopy.
  it('deletable includes mailMessage-sourced rows with a direct-upload or email-attachment kind', () => {
    const mail = { type: 'mailMessage', id: 'mm-1', label: 'RE: Corridor', href: '/mail/acct-1/_/thr-9' };
    const rows = [
      row({ id: 'doc', kind: 'document', source: mail }),
      row({ id: 'photo', kind: 'photo', source: mail }),
      row({ id: 'custom', kind: 'custom:warranty', source: mail }),
      row({ id: 'att', kind: 'email-attachment', source: mail }),
      // orphaned message (href null) — still a mailMessage source, still a copy
      row({ id: 'orphan', kind: 'document', source: { ...mail, href: null } }),
    ];
    expect(selectionPolicy(rows).deletable.map(r => r.id)).toEqual(['doc', 'photo', 'custom', 'att', 'orphan']);
  });

  it('deletable excludes system kinds under a mailMessage source, and email-attachment under any other source', () => {
    const mail = { type: 'mailMessage', id: 'mm-1', label: 'RE: Corridor', href: null };
    const rows = [
      row({ id: 'rfi', kind: 'rfi', source: mail }),
      row({ id: 'inv', kind: 'invoice', source: mail }),
      row({ id: 'att-elsewhere', kind: 'email-attachment', source: { type: 'rfi', id: 'r1', label: 'RFI #1', href: null } }),
      row({ id: 'att-loose', kind: 'email-attachment', source: null }),
    ];
    expect(selectionPolicy(rows).deletable).toEqual([]);
  });

  it('retypeable is exactly the direct-upload-kind rows (custom kinds included), regardless of source', () => {
    const rows = [
      row({ id: 'doc', kind: 'document' }),
      row({ id: 'custom', kind: 'custom:warranty' }),
      row({ id: 'mail-doc', kind: 'document', source: { type: 'mailMessage', id: 'mm-1', label: 'x', href: null } }),
      row({ id: 'inv', kind: 'invoice', source: { type: 'invoice', id: 'i1', label: 'Invoice #1', href: null } }),
      row({ id: 'att', kind: 'email-attachment' }),
      row({ id: 'print', kind: 'takeoff-print', source: { type: 'takeoff-print', id: 'po-1', label: 'x', href: null } }),
    ];
    expect(selectionPolicy(rows).retypeable.map(r => r.id)).toEqual(['doc', 'custom', 'mail-doc']);
  });

  it('returns empty arrays for an empty selection', () => {
    expect(selectionPolicy([])).toEqual({ downloadable: [], archivable: [], deletable: [], retypeable: [] });
  });
});
