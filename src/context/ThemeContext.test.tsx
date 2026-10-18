import { describe, it, expect, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import { ThemeProvider, daypartForHour } from './ThemeContext';

describe('ThemeContext accent hue var', () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.cssText = '';
  });

  it('sets --accent-h on the root element for preset accents', () => {
    localStorage.setItem('theme-accent', 'emerald');
    render(<ThemeProvider><div /></ThemeProvider>);
    expect(document.documentElement.style.getPropertyValue('--accent-h')).toBe('162');
  });

  it('sets --accent-h from the custom accent hex hue', () => {
    localStorage.setItem('theme-accent', 'custom');
    localStorage.setItem('theme-accent-custom', '#2563eb');
    render(<ThemeProvider><div /></ThemeProvider>);
    const h = parseFloat(document.documentElement.style.getPropertyValue('--accent-h'));
    expect(h).toBeGreaterThan(0); // exact hue comes from hexToAccentHue
  });
});

describe('daypartForHour', () => {
  it('maps hours to dayparts', () => {
    expect(daypartForHour(6)).toBe('morning');
    expect(daypartForHour(10)).toBe('morning');
    expect(daypartForHour(11)).toBe('midday');
    expect(daypartForHour(16)).toBe('midday');
    expect(daypartForHour(17)).toBe('evening');
    expect(daypartForHour(2)).toBe('evening');
  });
});

describe('appearance prefs', () => {
  it('applies data-daypart when ambience is auto (default)', () => {
    render(<ThemeProvider><div /></ThemeProvider>);
    expect(document.documentElement.dataset.daypart).toMatch(/^(morning|midday|evening)$/);
  });

  it('removes data-daypart when ambience is off', () => {
    localStorage.setItem('theme-ambience', 'off');
    render(<ThemeProvider><div /></ThemeProvider>);
    expect(document.documentElement.dataset.daypart).toBeUndefined();
  });

  it('toggles the solid-surfaces class from the pref', () => {
    localStorage.setItem('theme-surfaces', 'solid');
    render(<ThemeProvider><div /></ThemeProvider>);
    expect(document.documentElement.classList.contains('solid-surfaces')).toBe(true);
  });
});
