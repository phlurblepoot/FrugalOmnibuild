// src/pages/documents/docTypes.test.ts
import { describe, it, expect } from 'vitest';
import { kindLabel, kindTone, KIND_OPTIONS, isDeletableGeneratedKind, isDirectUploadKind } from './docTypes';

describe('kindLabel', () => {
  it('resolves canonical kinds to their display label', () => {
    expect(kindLabel('invoice')).toBe('Invoice');
    expect(kindLabel('issue-report')).toBe('Issue');
    expect(kindLabel('punch-photo')).toBe('Punch Photo');
  });

  it('falls back to the raw kind string for anything unrecognized', () => {
    expect(kindLabel('plan')).toBe('plan');
  });

  it('resolves the email-attachment kind (email attachments write it; it is not hidden)', () => {
    expect(kindLabel('email-attachment')).toBe('Email Attachment');
  });

  it('resolves the payment-attachment kind (a payment\'s check photo or PDF, migration 43)', () => {
    expect(kindLabel('payment-attachment')).toBe('Payment Attachment');
    expect(kindTone('payment-attachment')).toBe('emerald');
  });

  it('resolves a custom:<id> kind against the supplied custom types list', () => {
    expect(kindLabel('custom:warranty', [{ id: 'warranty', label: 'Warranty' }])).toBe('Warranty');
  });

  it('falls back to the raw kind string when the custom type is unknown', () => {
    expect(kindLabel('custom:missing', [{ id: 'warranty', label: 'Warranty' }])).toBe('custom:missing');
  });
});

describe('kindTone', () => {
  it('gives billing-priced kinds an emerald tone', () => {
    expect(kindTone('invoice')).toBe('emerald');
    expect(kindTone('payapp-export')).toBe('emerald');
  });

  it('gives every custom kind the same tone regardless of id', () => {
    expect(kindTone('custom:anything')).toBe('violet');
  });

  it('falls back to slate for an unrecognized kind', () => {
    expect(kindTone('plan')).toBe('slate');
  });
});

describe('KIND_OPTIONS', () => {
  it('never includes the always-hidden plan/settings-asset kinds', () => {
    const ids = KIND_OPTIONS.map(o => o.id);
    expect(ids).not.toContain('plan');
    expect(ids).not.toContain('settings-asset');
  });

  it('includes email-attachment — a live, filterable, non-hidden kind', () => {
    expect(KIND_OPTIONS.map(o => o.id)).toContain('email-attachment');
  });

  it('has a unique id per option', () => {
    const ids = KIND_OPTIONS.map(o => o.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('proposal-rework kinds', () => {
  it('knows the proposal-rework kinds and treats company-document as a direct upload', () => {
    expect(kindLabel('takeoff-print')).toBe('Takeoff Print');
    expect(kindLabel('takeoff-export')).toBe('Takeoff Export');
    expect(kindLabel('proposal-signed')).toBe('Signed Proposal');
    expect(kindLabel('company-document')).toBe('Company Document');
    expect(isDirectUploadKind('company-document')).toBe(true);
    expect(isDirectUploadKind('takeoff-print')).toBe(false);
    expect(KIND_OPTIONS.map(o => o.id)).not.toContain('printout');
  });

  // Migration 28 relabels every legacy 'printout' row, but a database that
  // hasn't run it yet would otherwise show a raw 'printout' badge — so the
  // kind keeps a label and a tone while staying unselectable.
  it('still labels the retired printout kind, but never offers it as a filter', () => {
    expect(kindLabel('printout')).toBe('Printout');
    expect(kindTone('printout')).toBe('slate');
    expect(KIND_OPTIONS.map(o => o.id)).not.toContain('printout');
    expect(isDirectUploadKind('printout')).toBe(false);
  });

  it('marks takeoff prints/exports — and nothing else — as deletable generated kinds', () => {
    expect(isDeletableGeneratedKind('takeoff-print')).toBe(true);
    expect(isDeletableGeneratedKind('takeoff-export')).toBe(true);
    expect(isDeletableGeneratedKind('proposal')).toBe(false);
    expect(isDeletableGeneratedKind('invoice')).toBe(false);
    expect(isDeletableGeneratedKind('document')).toBe(false);
  });
});
