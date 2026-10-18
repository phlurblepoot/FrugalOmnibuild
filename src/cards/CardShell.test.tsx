// src/cards/CardShell.test.tsx
import React from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { CardShell } from './CardShell';

describe('CardShell', () => {
  it('renders title and children', () => {
    render(
      <CardShell title="Attention">
        <div>hello world</div>
      </CardShell>
    );
    expect(screen.getByText('Attention')).toBeInTheDocument();
    expect(screen.getByText('hello world')).toBeInTheDocument();
  });

  it('shows skeletons and hides children while loading', () => {
    const { container } = render(
      <CardShell title="Attention" loading>
        <div>hello world</div>
      </CardShell>
    );
    expect(screen.queryByText('hello world')).not.toBeInTheDocument();
    expect(container.querySelectorAll('.animate-pulse').length).toBeGreaterThan(0);
  });

  it('shows emptyTitle when empty', () => {
    render(
      <CardShell title="Attention" empty emptyTitle="Nothing needs attention">
        <div>hello world</div>
      </CardShell>
    );
    expect(screen.queryByText('hello world')).not.toBeInTheDocument();
    expect(screen.getByText('Nothing needs attention')).toBeInTheDocument();
  });

  it('renders the EmptyArt illustration matching emptyIllustration when empty', () => {
    const { container } = render(
      <CardShell title="Mail" empty emptyIllustration="inbox">
        <div>hello world</div>
      </CardShell>
    );
    const svg = container.querySelector('svg[data-kind="inbox"]');
    expect(svg).toBeInTheDocument();
  });

  it('defaults the empty illustration to "clear" when emptyIllustration is unset', () => {
    const { container } = render(
      <CardShell title="Attention" empty emptyTitle="Nothing here">
        <div>hello world</div>
      </CardShell>
    );
    expect(container.querySelector('svg[data-kind="clear"]')).toBeInTheDocument();
  });
});
