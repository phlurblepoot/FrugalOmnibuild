// src/components/illustrations/EmptyArt.test.tsx
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { EmptyArt } from './EmptyArt';
import type { EmptyKind } from '../../cards/types';

const KINDS: EmptyKind[] = ['clear', 'inbox', 'money', 'checklist', 'photos', 'blueprint'];

describe('EmptyArt', () => {
  it.each(KINDS)('renders an svg for kind=%s', (kind) => {
    const { container } = render(<EmptyArt kind={kind} />);
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
  });

  it('marks the svg aria-hidden (decorative)', () => {
    const { container } = render(<EmptyArt kind="clear" />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('falls back to the clear illustration for an unknown kind', () => {
    // @ts-expect-error deliberately passing an invalid kind to test the fallback
    const { container } = render(<EmptyArt kind="not-a-real-kind" />);
    const svg = container.querySelector('svg');
    expect(svg).toBeInTheDocument();
    expect(svg).toHaveAttribute('data-kind', 'clear');
  });

  it('applies a className passed through to the svg', () => {
    const { container } = render(<EmptyArt kind="inbox" className="mb-2 h-16" />);
    expect(container.querySelector('svg')).toHaveClass('mb-2', 'h-16');
  });

  it('contains no text content (decorative only)', () => {
    const { container } = render(<EmptyArt kind="money" />);
    expect(container.querySelector('svg')?.textContent).toBe('');
  });
});
