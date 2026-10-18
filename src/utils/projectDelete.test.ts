import { describe, it, expect } from 'vitest';
import { describeProjectData, projectDeleteBlockedReason } from './projectDelete';

describe('describeProjectData', () => {
  it('names one kind, singular or plural', () => {
    expect(describeProjectData({ documents: 1 })).toBe('1 document');
    expect(describeProjectData({ documents: 12 })).toBe('12 documents');
    expect(describeProjectData({ rfis: 2 })).toBe('2 RFIs');
    expect(describeProjectData({ timeEntries: 1 })).toBe('1 time entry');
  });

  it('joins two or three kinds with "and", most recognizable first whatever order they came in', () => {
    expect(describeProjectData({ invoices: 2, documents: 12 })).toBe('12 documents and 2 invoices');
    expect(describeProjectData({ issues: 1, invoices: 2, documents: 12 })).toBe('12 documents, 2 invoices and 1 issue');
  });

  it('names three and says "and more" past that, so it stays one line', () => {
    expect(describeProjectData({ documents: 12, planPages: 40, measurements: 310, invoices: 2, rfis: 1 }))
      .toBe('12 documents, 40 plan pages, 310 measurements and more');
  });

  it('names the folded-together kinds someone who is not an admin sees, and a kind it does not know', () => {
    expect(describeProjectData({ documents: 3, otherRecords: 5 })).toBe('3 documents and 5 other records');
    expect(describeProjectData({ widgets: 4 })).toBe('4 widgets');
  });

  it('falls back to "records" when nothing is named', () => {
    expect(describeProjectData({})).toBe('records');
  });
});

describe('projectDeleteBlockedReason', () => {
  it('reads as one line ending in what to do instead', () => {
    expect(projectDeleteBlockedReason({ documents: 12, invoices: 2 })).toBe('Has 12 documents and 2 invoices — archive it instead.');
  });
});
