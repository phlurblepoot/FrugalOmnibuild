// src/components/tasks/TaskListPanel.test.tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import type { TaskListItem } from '../../utils/store';

const h = vi.hoisted(() => ({
  // Which task ids useReplyFlags reports as flagged — controlled per test.
  replyFlags: new Set<string>(),
}));

vi.mock('../../hooks/useReplyFlags', () => ({
  useReplyFlags: () => h.replyFlags,
}));
// EditingChip (rendered on every row) needs a CollaborationContext provider.
vi.mock('../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: null, sessions: [], mySessionId: 'me' }),
}));

import { TaskListPanel } from './TaskListPanel';

const task = (over: Partial<TaskListItem> = {}): TaskListItem => ({
  id: 't1', category: 'Framing', title: 'Order studs', notes: '',
  assigneeUserId: null, assigneeUsername: null, status: 'todo', dueDate: null, sortOrder: 0,
  projectId: null, customerId: null, projectName: null, customerName: null,
  version: 1, createdAt: 1, createdBy: null, photoCount: 0,
  ...over,
});

beforeEach(() => {
  h.replyFlags = new Set<string>();
});

describe('TaskListPanel — reply flag chip', () => {
  it('hides the chip when no task is flagged', () => {
    render(<TaskListPanel tasks={[task()]} onToggleDone={vi.fn()} onOpenTask={vi.fn()} />);
    expect(screen.getByText('Order studs')).toBeInTheDocument();
    expect(screen.queryByTestId('task-reply-flag-t1')).toBeNull();
  });

  it('shows the amber reply chip only on the flagged task', () => {
    h.replyFlags = new Set(['t1']);
    render(<TaskListPanel
      tasks={[task(), task({ id: 't2', title: 'Order trim' })]}
      onToggleDone={vi.fn()}
      onOpenTask={vi.fn()}
    />);
    const chip = screen.getByTestId('task-reply-flag-t1');
    expect(chip).toHaveTextContent('Reply');
    expect(chip).toHaveAttribute('title', 'The linked email thread has a new reply');
    expect(screen.queryByTestId('task-reply-flag-t2')).toBeNull();
  });
});
