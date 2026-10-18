import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';
import React from 'react';
import { useSoftZoom } from './useSoftZoom';

// jsdom has no ResizeObserver — stub it.
beforeEach(() => {
  (globalThis as any).ResizeObserver = class {
    observe() {} unobserve() {} disconnect() {}
  };
});

const Probe: React.FC<{ width: number }> = ({ width }) => {
  const ref = useSoftZoom<HTMLDivElement>();
  // jsdom reports offsetWidth 0; fake it per-instance.
  React.useLayoutEffect(() => {
    if (ref.current) Object.defineProperty(ref.current, 'offsetWidth', { value: width, configurable: true });
  }, [width]);
  return <div ref={ref} data-testid="probe" className="soft-zoom" />;
};

describe('useSoftZoom', () => {
  it('sets a pixel-constant scale: ~6px growth for a 300px element', () => {
    const { getByTestId, rerender } = render(<Probe width={300} />);
    rerender(<Probe width={300} />); // second pass so the effect reads the faked width
    const v = parseFloat(getByTestId('probe').style.getPropertyValue('--soft-zoom'));
    expect(v).toBeCloseTo(1 + 6 / 300, 3);
  });

  it('caps the scale at 1.03 for tiny elements', () => {
    const { getByTestId, rerender } = render(<Probe width={40} />);
    rerender(<Probe width={40} />);
    const v = parseFloat(getByTestId('probe').style.getPropertyValue('--soft-zoom'));
    expect(v).toBe(1.03);
  });
});
