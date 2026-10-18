import { describe, it, expect } from 'vitest';
import { hexToRgb, BRAND_GREEN } from './documentLetterhead';

describe('hexToRgb', () => {
  it('parses a 6-digit hex with #', () => {
    expect(hexToRgb('#99CB38')).toEqual([153, 203, 56]);
  });

  it('parses a 6-digit hex without #', () => {
    expect(hexToRgb('ff8000')).toEqual([255, 128, 0]);
  });

  it('parses lowercase hex', () => {
    expect(hexToRgb('#abcdef')).toEqual([171, 205, 239]);
  });

  it('expands 3-digit shorthand', () => {
    expect(hexToRgb('#f0a')).toEqual([255, 0, 170]);
  });

  it('expands 3-digit shorthand without #', () => {
    expect(hexToRgb('0f0')).toEqual([0, 255, 0]);
  });

  it('parses pure black and white', () => {
    expect(hexToRgb('#000000')).toEqual([0, 0, 0]);
    expect(hexToRgb('#ffffff')).toEqual([255, 255, 255]);
  });

  it('falls back to brand green on an invalid hex', () => {
    expect(hexToRgb('not-a-color')).toEqual(BRAND_GREEN);
  });

  it('falls back to brand green on a wrong-length hex', () => {
    expect(hexToRgb('#12345')).toEqual(BRAND_GREEN);
  });

  it('falls back to brand green on non-hex characters', () => {
    expect(hexToRgb('#gggggg')).toEqual(BRAND_GREEN);
  });

  it('falls back to brand green on an empty string', () => {
    expect(hexToRgb('')).toEqual(BRAND_GREEN);
  });

  it('falls back to brand green on a non-string input', () => {
    const bad = null as unknown as string; // exercise the runtime guard
    expect(hexToRgb(bad)).toEqual(BRAND_GREEN);
  });
});
