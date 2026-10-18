// src/pages/project/issues/issuePdf.test.ts
import { describe, it, expect } from 'vitest';
import { issueHeading } from './issuePdf';

describe('issue pdf data shaping', () => {
  it('issueHeading formats the issue number + title', () => {
    expect(issueHeading({ number: 7, title: 'Cracked drywall' } as any)).toBe('ISS-007 · Cracked drywall');
    expect(issueHeading({ number: 1, title: null } as any)).toBe('ISS-001 · (untitled)');
  });
});
