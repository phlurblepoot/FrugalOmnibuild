import { describe, it, expect } from 'vitest';
import { extensionOf, officeFormatOf } from './officeFormats';

describe('officeFormatOf', () => {
  it('opens PDF, Word, Excel and PowerPoint for editing', () => {
    expect(officeFormatOf({ mime: 'application/pdf', name: 'Plans.pdf' })).toMatchObject({ ext: 'pdf', documentType: 'pdf', editable: true });
    expect(officeFormatOf({ name: 'Scope.DOCX' })).toMatchObject({ ext: 'docx', documentType: 'word', editable: true });
    expect(officeFormatOf({ mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })).toMatchObject({ ext: 'xlsx', documentType: 'cell', editable: true });
    expect(officeFormatOf({ name: 'deck.pptx' })).toMatchObject({ ext: 'pptx', documentType: 'slide', editable: true });
  });

  it('opens legacy and interchange formats read-only', () => {
    for (const name of ['a.doc', 'a.xls', 'a.ppt', 'a.odt', 'a.ods', 'a.odp', 'a.rtf', 'a.csv', 'a.txt']) {
      expect(officeFormatOf({ name })?.editable, name).toBe(false);
    }
  });

  it('trusts a known extension over the mime type, and the mime type when there is no extension', () => {
    // Windows browsers label .csv uploads as Excel.
    expect(officeFormatOf({ mime: 'application/vnd.ms-excel', name: 'export.csv' })?.ext).toBe('csv');
    expect(officeFormatOf({ mime: 'application/octet-stream', name: 'Letter.docx' })?.ext).toBe('docx');
    expect(officeFormatOf({ mime: 'application/pdf', name: 'Invoice #12' })?.ext).toBe('pdf');
    expect(officeFormatOf({ mime: 'text/rtf; charset=utf-8', name: null })?.ext).toBe('rtf');
  });

  it('returns null for files the editor does not handle', () => {
    expect(officeFormatOf({ mime: 'image/png', name: 'site.png' })).toBeNull();
    expect(officeFormatOf({ mime: 'application/zip', name: 'plans.zip' })).toBeNull();
    expect(officeFormatOf({})).toBeNull();
  });
});

describe('extensionOf', () => {
  it('lower-cases the last extension and returns empty when there is none', () => {
    expect(extensionOf('A.B.XLSX')).toBe('xlsx');
    expect(extensionOf('README')).toBe('');
    expect(extensionOf(null)).toBe('');
  });
});
