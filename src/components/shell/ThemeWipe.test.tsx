import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ThemeProvider } from '../../context/ThemeContext';
import { ThemeWipe } from './ThemeWipe';

describe('ThemeWipe', () => {
  beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
  afterEach(() => vi.useRealTimers());

  it('shows an overlay on theme-wipe and removes it after the animation', () => {
    render(<ThemeProvider><ThemeWipe /></ThemeProvider>);
    act(() => {
      window.dispatchEvent(new CustomEvent('theme-wipe', { detail: { x: 40, y: 500 } }));
    });
    expect(screen.getByTestId('theme-wipe')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(700); });
    expect(screen.queryByTestId('theme-wipe')).toBeNull();
  });

  it('does nothing under reduced motion', () => {
    localStorage.setItem('theme-motion', 'reduced');
    render(<ThemeProvider><ThemeWipe /></ThemeProvider>);
    act(() => {
      window.dispatchEvent(new CustomEvent('theme-wipe', { detail: { x: 0, y: 0 } }));
    });
    expect(screen.queryByTestId('theme-wipe')).toBeNull();
  });
});
