// src/pages/documents/openTarget.test.ts
import { describe, it, expect } from 'vitest';
import { kindFromMime, openTargetFor } from './openTarget';

describe('kindFromMime', () => {
  it('classifies uploads', () => {
    expect(kindFromMime('application/pdf')).toBe('document');
    expect(kindFromMime('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('document');
    expect(kindFromMime('application/vnd.openxmlformats-officedocument.presentationml.presentation')).toBe('document');
    expect(kindFromMime('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('spreadsheet');
    expect(kindFromMime('application/vnd.ms-excel')).toBe('spreadsheet');
    expect(kindFromMime('image/png')).toBe('photo');
    expect(kindFromMime('text/plain')).toBe('other');
  });
});

describe('openTargetFor', () => {
  it('opens every office format in the document editor, images raw, anything else as a download', () => {
    expect(openTargetFor({ mime: 'application/pdf', id: 'a' })).toEqual({ type: 'edit', url: '/tools/edit?fileId=a' });
    expect(openTargetFor({ mime: 'application/vnd.ms-excel', id: 'b' })).toEqual({ type: 'edit', url: '/tools/edit?fileId=b' });
    expect(openTargetFor({ mime: 'application/octet-stream', name: 'Scope.docx', id: 'c d' })).toEqual({ type: 'edit', url: '/tools/edit?fileId=c%20d' });
    expect(openTargetFor({ mime: 'image/jpeg', id: 'e' })).toEqual({ type: 'image', url: '/api/images/e/raw' });
    expect(openTargetFor({ mime: 'application/zip', id: 'f' })).toEqual({ type: 'download', url: null });
  });
});
