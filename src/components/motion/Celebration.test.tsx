import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { ThemeProvider } from '../../context/ThemeContext';
import { CelebrationOverlay } from './Celebration';

describe('CelebrationOverlay', () => {
  beforeEach(() => { vi.useFakeTimers(); localStorage.clear(); });
  afterEach(() => vi.useRealTimers());

  it('renders confetti pieces on a confetti celebrate event and self-removes after ~1s', () => {
    render(<ThemeProvider><CelebrationOverlay /></ThemeProvider>);
    act(() => {
      window.dispatchEvent(new CustomEvent('celebrate', { detail: { variant: 'confetti', x: 40, y: 500 } }));
    });
    const overlay = screen.getByTestId('celebration-confetti');
    expect(overlay).toBeInTheDocument();
    expect(overlay.querySelectorAll('.celebration-confetti-piece').length).toBeGreaterThanOrEqual(14);
    act(() => { vi.advanceTimersByTime(1050); });
    expect(screen.queryByTestId('celebration-confetti')).toBeNull();
  });

  it('renders a pulse glow on a pulse celebrate event and self-removes after ~700ms', () => {
    render(<ThemeProvider><CelebrationOverlay /></ThemeProvider>);
    act(() => {
      window.dispatchEvent(new CustomEvent('celebrate', { detail: { variant: 'pulse', x: 10, y: 20 } }));
    });
    expect(screen.getByTestId('celebration-pulse')).toBeInTheDocument();
    expect(screen.queryByTestId('celebration-confetti')).toBeNull();
    act(() => { vi.advanceTimersByTime(750); });
    expect(screen.queryByTestId('celebration-pulse')).toBeNull();
  });

  it('defaults to confetti variant when none is given', () => {
    render(<ThemeProvider><CelebrationOverlay /></ThemeProvider>);
    act(() => {
      window.dispatchEvent(new CustomEvent('celebrate', { detail: {} }));
    });
    expect(screen.getByTestId('celebration-confetti')).toBeInTheDocument();
  });

  it('remounts the overlay DOM node on a rapid re-fire so the animation replays', () => {
    render(<ThemeProvider><CelebrationOverlay /></ThemeProvider>);
    act(() => {
      window.dispatchEvent(new CustomEvent('celebrate', { detail: { variant: 'pulse', x: 1, y: 1 } }));
    });
    const first = screen.getByTestId('celebration-pulse');
    act(() => { vi.advanceTimersByTime(300); });
    act(() => {
      window.dispatchEvent(new CustomEvent('celebrate', { detail: { variant: 'pulse', x: 2, y: 2 } }));
    });
    const second = screen.getByTestId('celebration-pulse');
    // Same testid, but a genuinely new DOM node — a reused node would keep
    // its CSS animation in its already-finished/paused state and never
    // visibly replay the pulse.
    expect(second).not.toBe(first);
  });

  it("does not let event 1's removal timer clear event 2's overlay", () => {
    render(<ThemeProvider><CelebrationOverlay /></ThemeProvider>);
    act(() => {
      window.dispatchEvent(new CustomEvent('celebrate', { detail: { variant: 'pulse', x: 1, y: 1 } }));
    });
    act(() => { vi.advanceTimersByTime(300); });
    act(() => {
      window.dispatchEvent(new CustomEvent('celebrate', { detail: { variant: 'pulse', x: 2, y: 2 } }));
    });
    // Event 1 fired at t=0 with a 700ms timer, due at t=700. Event 2 fired at
    // t=300; advancing another 400ms (t=700 overall) must NOT tear down
    // event 2's overlay, which still has 300ms left on ITS OWN timer.
    act(() => { vi.advanceTimersByTime(400); });
    expect(screen.getByTestId('celebration-pulse')).toBeInTheDocument();
    act(() => { vi.advanceTimersByTime(350); });
    expect(screen.queryByTestId('celebration-pulse')).toBeNull();
  });

  it('does nothing under reduced motion', () => {
    localStorage.setItem('theme-motion', 'reduced');
    render(<ThemeProvider><CelebrationOverlay /></ThemeProvider>);
    act(() => {
      window.dispatchEvent(new CustomEvent('celebrate', { detail: { variant: 'confetti', x: 0, y: 0 } }));
    });
    expect(screen.queryByTestId('celebration-confetti')).toBeNull();
    expect(screen.queryByTestId('celebration-pulse')).toBeNull();
  });
});
