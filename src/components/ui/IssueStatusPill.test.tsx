// src/components/ui/IssueStatusPill.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { IssueStatusPill, ISSUE_STATUS_META } from './IssueStatusPill';

describe('IssueStatusPill', () => {
  it('maps every issue status', () => {
    for (const s of ['open', 'sent', 'resolved']) expect(ISSUE_STATUS_META[s], s).toBeDefined();
  });
  it('renders labels', () => {
    render(<IssueStatusPill status="resolved" />);
    expect(screen.getByText('Resolved')).toBeInTheDocument();
  });
  it('falls back to slate for unknown statuses (prototype-safe)', () => {
    render(<IssueStatusPill status="constructor" />);
    // StatusPill's 'slate' tone NAME is unchanged; its classes were retokened
    // to bg-sunken/text-ink-soft (Wave 3 token migration), so assert on the
    // token class rather than the literal string "slate".
    expect(screen.getByText('constructor').className).toContain('bg-sunken');
  });
});
