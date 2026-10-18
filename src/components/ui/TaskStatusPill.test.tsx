// src/components/ui/TaskStatusPill.test.tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { TaskStatusPill, TASK_STATUS_META } from './TaskStatusPill';

describe('TaskStatusPill', () => {
  it('maps every task status', () => {
    for (const s of ['todo', 'in_progress', 'done']) expect(TASK_STATUS_META[s], s).toBeDefined();
  });
  it('renders labels', () => {
    render(<TaskStatusPill status="todo" />);
    expect(screen.getByText('To do')).toBeInTheDocument();

    render(<TaskStatusPill status="in_progress" />);
    expect(screen.getByText('In progress')).toBeInTheDocument();

    render(<TaskStatusPill status="done" />);
    expect(screen.getByText('Done')).toBeInTheDocument();
  });
  it('falls back to slate for unknown statuses (prototype-safe)', () => {
    render(<TaskStatusPill status="constructor" />);
    // StatusPill's 'slate' tone NAME is unchanged; its classes were retokened
    // to bg-sunken/text-ink-soft (Wave 3 token migration), so assert on the
    // token class rather than the literal string "slate".
    expect(screen.getByText('constructor').className).toContain('bg-sunken');
  });
});
