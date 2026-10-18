import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { useReveal } from './useReveal';

let observeSpy: ReturnType<typeof vi.fn>;
let disconnectSpy: ReturnType<typeof vi.fn>;
let capturedCallback: ((entries: { isIntersecting: boolean }[]) => void) | null;
let capturedOptions: IntersectionObserverInit | undefined;

class FakeIntersectionObserver {
  constructor(cb: (entries: { isIntersecting: boolean }[]) => void, options?: IntersectionObserverInit) {
    capturedCallback = cb;
    capturedOptions = options;
  }
  observe = observeSpy;
  disconnect = disconnectSpy;
  unobserve = vi.fn();
}

const Probe: React.FC = () => {
  const ref = useReveal<HTMLDivElement>();
  return <div ref={ref} data-testid="probe" />;
};

describe('useReveal', () => {
  beforeEach(() => {
    observeSpy = vi.fn();
    disconnectSpy = vi.fn();
    capturedCallback = null;
    capturedOptions = undefined;
    (globalThis as any).IntersectionObserver = FakeIntersectionObserver;
  });

  it('jsdom/no-IO guard: stays visible and does not throw when IntersectionObserver is unavailable', () => {
    delete (globalThis as any).IntersectionObserver;
    const { getByTestId } = render(<Probe />);
    const el = getByTestId('probe');
    expect(el.classList.contains('reveal-init')).toBe(false);
    expect(el.classList.contains('reveal-in')).toBe(false);
  });

  it('adds reveal-init only after confirming IO support, then swaps to reveal-in on intersect', () => {
    const { getByTestId } = render(<Probe />);
    const el = getByTestId('probe');

    // Hidden while waiting to scroll into view.
    expect(el.classList.contains('reveal-init')).toBe(true);
    expect(observeSpy).toHaveBeenCalledTimes(1);
    expect(capturedOptions?.threshold).toBe(0.15);

    capturedCallback!([{ isIntersecting: true }]);

    expect(el.classList.contains('reveal-init')).toBe(false);
    expect(el.classList.contains('reveal-in')).toBe(true);
  });

  it('fires once: disconnects immediately on the first intersection', () => {
    render(<Probe />);
    capturedCallback!([{ isIntersecting: true }]);
    // Disconnecting synchronously on first intersect is what guarantees a
    // real browser never calls this observer back again — so "once" is
    // enforced at the source, not by a re-entrancy guard in the handler.
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
  });

  it('ignores non-intersecting entries (does not reveal early)', () => {
    const { getByTestId } = render(<Probe />);
    const el = getByTestId('probe');
    capturedCallback!([{ isIntersecting: false }]);
    expect(el.classList.contains('reveal-init')).toBe(true);
    expect(el.classList.contains('reveal-in')).toBe(false);
    expect(disconnectSpy).not.toHaveBeenCalled();
  });

  it('disconnects the observer on unmount', () => {
    const { unmount } = render(<Probe />);
    unmount();
    expect(disconnectSpy).toHaveBeenCalledTimes(1);
  });
});
