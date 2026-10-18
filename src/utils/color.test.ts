import { describe, it, expect } from 'vitest';
import { hexToOklch, hexToAccentHue } from './color';

describe('hexToOklch', () => {
  it('converts pure red to an OKLCH hue around 29 degrees', () => {
    const { h } = hexToOklch('#ff0000');
    expect(h).toBeGreaterThan(24);
    expect(h).toBeLessThan(34);
  });

  it('converts pure green to an OKLCH hue around 142 degrees', () => {
    const { h } = hexToOklch('#00ff00');
    expect(h).toBeGreaterThan(137);
    expect(h).toBeLessThan(147);
  });

  it('converts pure blue to an OKLCH hue around 264 degrees', () => {
    const { h } = hexToOklch('#0000ff');
    expect(h).toBeGreaterThan(259);
    expect(h).toBeLessThan(269);
  });

  it('produces a non-zero chroma for saturated colours', () => {
    expect(hexToOklch('#ff0000').c).toBeGreaterThan(0.1);
  });

  it('accepts shorthand #rgb hex', () => {
    const long = hexToOklch('#ff0000');
    const short = hexToOklch('#f00');
    expect(Math.abs(short.h - long.h)).toBeLessThan(0.5);
  });

  it('treats achromatic colours as the fallback hue', () => {
    expect(hexToOklch('#808080').h).toBe(264);
  });
});

describe('hexToAccentHue', () => {
  it('returns the hue component', () => {
    expect(hexToAccentHue('#0000ff')).toBeGreaterThan(259);
    expect(hexToAccentHue('#0000ff')).toBeLessThan(269);
  });

  it('falls back to 264 for a malformed hex', () => {
    expect(hexToAccentHue('not-a-color')).toBe(264);
  });

  it('falls back to 264 for an empty string', () => {
    expect(hexToAccentHue('')).toBe(264);
  });
});
