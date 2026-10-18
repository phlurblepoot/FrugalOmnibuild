// src/pages/TasksPage.test.tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const h = vi.hoisted(() => ({
  getTasks: vi.fn(async () => []),
  getTask: vi.fn(async () => ({ id: 't1', category: '', title: 'From a thread', notes: '' })),
  getAssignableUsers: vi.fn(async () => []),
  getProjectsSummary: vi.fn(async () => []),
  getCustomers: vi.fn(async () => []),
}));

vi.mock('../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: null, sessions: [], mySessionId: 'me' }),
}));
// Not under test here — see components/tasks/TaskListPanel.test.tsx.
vi.mock('../hooks/useReplyFlags', () => ({ useReplyFlags: () => new Set<string>() }));
vi.mock('../utils/store', async orig => ({
  ...(await orig<typeof import('../utils/store')>()),
  getTasks: h.getTasks,
  getTask: h.getTask,
  getAssignableUsers: h.getAssignableUsers,
  getProjectsSummary: h.getProjectsSummary,
  getCustomers: h.getCustomers,
}));
// TaskEditor itself is exercised elsewhere; here it's a stub that reports
// which task it was opened with.
vi.mock('./tasks/TaskEditor', () => ({
  TaskEditor: ({ task }: { task: { id: string; title: string } }) => (
    <div data-testid="editor" data-task-id={task.id}>{task.title}</div>
  ),
}));

import { TasksPage } from './TasksPage';

const mount = (initialEntry = '/tasks') =>
  render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes><Route path="/tasks" element={<TasksPage />} /></Routes>
    </MemoryRouter>
  );

beforeEach(() => vi.clearAllMocks());

describe('TasksPage', () => {
  it('?open= opens that task\'s editor (CreateFromThreadMenu convention) and strips the param', async () => {
    h.getTasks.mockResolvedValue([]);
    h.getTask.mockResolvedValue({ id: 't1', category: '', title: 'From a thread', notes: '' });
    mount('/tasks?open=t1');

    const editor = await screen.findByTestId('editor');
    expect(editor).toHaveAttribute('data-task-id', 't1');
    expect(h.getTask).toHaveBeenCalledWith('t1');
  });
});
