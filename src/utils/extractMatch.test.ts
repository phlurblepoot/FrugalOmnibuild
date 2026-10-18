import { describe, it, expect } from 'vitest';
import { reconcileExtract } from './extractMatch';

it('returns the raw candidate closest to the OCR string', () => {
  const r = reconcileExtract({ rawCandidates: ['A-101', 'SCALE 1/4"', 'NORTH'], ocrText: 'A-1O1' });
  expect(r.value).toBe('A-101');         // clean chars from raw
  expect(r.confidence).toBe('high');
});

it('falls back to cleaned OCR when no raw candidate is close', () => {
  const r = reconcileExtract({ rawCandidates: ['TOTALLY DIFFERENT'], ocrText: 'A-205' });
  expect(r.value).toBe('A-205');
  expect(r.confidence).toBe('low');      // OCR-only
});

it('uses OCR directly when there are no raw candidates', () => {
  const r = reconcileExtract({ rawCandidates: [], ocrText: 'E-3.1' });
  expect(r.value).toBe('E-3.1');
  expect(r.confidence).toBe('low');
});

it('is high-confidence when raw and OCR agree exactly', () => {
  const r = reconcileExtract({ rawCandidates: ['A-101'], ocrText: 'A-101' });
  expect(r.confidence).toBe('high');
});

it('returns empty + low when nothing is available', () => {
  const r = reconcileExtract({ rawCandidates: [], ocrText: '' });
  expect(r.value).toBe('');
  expect(r.confidence).toBe('low');
});
