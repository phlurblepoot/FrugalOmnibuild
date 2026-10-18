// src/pages/tasks/TaskEditor.test.tsx
//
// Representative coverage for Task 8's edit-awareness wiring (fake-socket +
// mocked-context pattern from useCollabEditing.test.tsx / ProjectIssues.test.tsx).
// IssueEditor/RfiEditor/PunchItemEditor get the same three touches but aren't
// re-tested here — the hook itself is unit-tested in useCollabEditing.test.tsx.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, act, waitFor } from '@testing-library/react';
import React from 'react';
import { TaskEditor } from './TaskEditor';
import { ToastProvider } from '../../components/Toast';
import type { Task } from '../../utils/store';

const { fakeSocket } = vi.hoisted(() => {
  const handlers: Record<string, ((...a: any[]) => void)[]> = {};
  const fakeSocket = {
    handlers,
    on: vi.fn((e: string, cb: any) => { (handlers[e] ??= []).push(cb); return fakeSocket; }),
    off: vi.fn((e: string, cb: any) => { handlers[e] = (handlers[e] ?? []).filter(h => h !== cb); return fakeSocket; }),
    emit: vi.fn(),
    fire: (e: string, ...a: any[]) => (handlers[e] ?? []).forEach(cb => cb(...a)),
  };
  return { fakeSocket };
});

vi.mock('../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: fakeSocket, sessions: [], mySessionId: 'me' }),
}));

const h = vi.hoisted(() => ({
  saveTask: vi.fn(),
  addTaskPhoto: vi.fn(),
  saveBinaryFile: vi.fn(),
  uploadProjectFile: vi.fn(),
  pickerProps: { last: null as any },
}));
const saveTask = h.saveTask;
vi.mock('../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  saveTask: h.saveTask,
  addTaskPhoto: h.addTaskPhoto,
  saveBinaryFile: h.saveBinaryFile,
  uploadProjectFile: h.uploadProjectFile,
  getImageUrl: (id: string) => `/img/${id}`,
}));

// Stand-in picker: records the config the editor asked for and hands back one
// already-uploaded row on demand.
vi.mock('../../components/FilePickerModal', () => ({
  FilePickerModal: (props: any) => {
    h.pickerProps.last = props;
    return (
      <div data-testid="picker">
        <button data-testid="picker-pick" onClick={() => void props.onPick?.([{ id: 'up-1', name: 'shot.png' }])}>pick</button>
      </div>
    );
  },
}));

const task: Task = {
  id: 't1', category: '', title: 'Original title', notes: '',
  assigneeUserId: null, assigneeUsername: null, status: 'todo', dueDate: null,
  sortOrder: 0, projectId: null, customerId: null, projectName: null, customerName: null,
  version: 1, createdAt: 0, createdBy: null, photos: [],
};

const changeEvt = (over: Record<string, unknown> = {}) => ({
  type: 'task', id: 't1', action: 'updated', version: 7, bySessionId: 'other-tab', ...over,
});

function renderEditor(onSaved: () => void = vi.fn(), t: Task = task) {
  return render(
    <ToastProvider>
      <TaskEditor task={t} users={[]} projects={[]} customers={[]} onClose={vi.fn()} onSaved={onSaved} />
    </ToastProvider>
  );
}

describe('TaskEditor collab awareness', () => {
  beforeEach(() => {
    saveTask.mockReset().mockResolvedValue({ version: 8 });
    h.addTaskPhoto.mockReset().mockResolvedValue(undefined);
    h.saveBinaryFile.mockReset().mockResolvedValue({ fileId: 'up-photo' });
    h.uploadProjectFile.mockReset().mockResolvedValue({ fileId: 'up-photo', versioned: false });
    h.pickerProps.last = null;
    fakeSocket.emit.mockClear();
    for (const k of Object.keys(fakeSocket.handlers)) delete fakeSocket.handlers[k];
  });

  it('declares set-editing for this task on mount', () => {
    renderEditor();
    expect(fakeSocket.emit).toHaveBeenCalledWith('set-editing', { type: 'task', id: 't1' });
  });

  it('pristine: a foreign entity-changed event for this task debounce-calls onSaved (no banner)', () => {
    vi.useFakeTimers();
    try {
      const onSaved = vi.fn();
      renderEditor(onSaved);
      act(() => { fakeSocket.fire('entity-changed', changeEvt()); });
      expect(onSaved).not.toHaveBeenCalled();
      act(() => { vi.advanceTimersByTime(300); });
      expect(onSaved).toHaveBeenCalledTimes(1);
      expect(screen.queryByText(/saved changes while you were editing/)).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('dirty: a foreign entity-changed event shows the banner instead of reloading', () => {
    const onSaved = vi.fn();
    renderEditor(onSaved);
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Changed title' } });
    act(() => { fakeSocket.fire('entity-changed', changeEvt()); });
    expect(onSaved).not.toHaveBeenCalled();
    expect(screen.getByText(/saved changes while you were editing/)).toBeInTheDocument();
  });

  it('Keep mine then Save sends the event version, not the stale prop version', async () => {
    renderEditor();
    fireEvent.change(screen.getByLabelText('Title'), { target: { value: 'Changed title' } });
    act(() => { fakeSocket.fire('entity-changed', changeEvt()); });
    fireEvent.click(screen.getByText('Keep mine'));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(saveTask).toHaveBeenCalledTimes(1));
    expect(saveTask.mock.calls[0][1].version).toBe(7);
  });
});

// Photos are per stage, and a task is attributed to a project OR a customer —
// which is what decides where a new photo is stored.
describe('TaskEditor photo cards', () => {
  beforeEach(() => {
    h.addTaskPhoto.mockReset().mockResolvedValue(undefined);
    h.saveBinaryFile.mockReset().mockResolvedValue({ fileId: 'up-photo' });
    h.uploadProjectFile.mockReset().mockResolvedValue({ fileId: 'up-photo', versioned: false });
    h.pickerProps.last = null;
  });

  it('gives every stage its own picker button and no bare file input', () => {
    renderEditor();
    expect(screen.getAllByRole('button', { name: /Add photos/i })).toHaveLength(3);
    expect(document.querySelectorAll('input[type="file"]')).toHaveLength(0);
  });

  it('adds a picked photo to the stage it was picked from', async () => {
    const onSaved = vi.fn();
    renderEditor(onSaved);
    // Index 2 = the "After" stage.
    fireEvent.click(screen.getAllByRole('button', { name: /Add photos/i })[2]);
    fireEvent.click(await screen.findByTestId('picker-pick'));

    await waitFor(() => expect(h.addTaskPhoto).toHaveBeenCalledWith('t1', 'up-1', 'after'));
    expect(onSaved).toHaveBeenCalled();
  });

  it('a photo dropped on an unassigned task goes to the global file store', async () => {
    renderEditor();
    const shot = new File(['x'], 'shot.png', { type: 'image/png' });
    fireEvent.drop(screen.getByTestId('task-before-photo-dropzone'), { dataTransfer: { files: [shot] } });

    await waitFor(() => expect(h.saveBinaryFile).toHaveBeenCalledTimes(1));
    expect(h.saveBinaryFile.mock.calls[0][2]).toMatchObject({
      kind: 'task-photo', sourceType: 'task', sourceId: 't1',
    });
    expect(h.uploadProjectFile).not.toHaveBeenCalled();
    await waitFor(() => expect(h.addTaskPhoto).toHaveBeenCalledWith('t1', 'up-photo', 'before'));
  });

  it('a photo on a project task uploads into that project', async () => {
    renderEditor(vi.fn(), { ...task, projectId: 'p1' });
    const shot = new File(['x'], 'shot.png', { type: 'image/png' });
    fireEvent.drop(screen.getByTestId('task-before-photo-dropzone'), { dataTransfer: { files: [shot] } });

    await waitFor(() => expect(h.uploadProjectFile).toHaveBeenCalledWith(
      'p1', shot, 'task-photo', { sourceType: 'task', sourceId: 't1' },
    ));
    expect(h.saveBinaryFile).not.toHaveBeenCalled();
  });

  it('a customer-only task carries its customer onto the stored photo', async () => {
    renderEditor(vi.fn(), { ...task, customerId: 'c1' });
    fireEvent.drop(screen.getByTestId('task-after-photo-dropzone'), {
      dataTransfer: { files: [new File(['x'], 'shot.png', { type: 'image/png' })] },
    });

    await waitFor(() => expect(h.saveBinaryFile).toHaveBeenCalledTimes(1));
    expect(h.saveBinaryFile.mock.calls[0][2]).toMatchObject({ customerId: 'c1' });
  });
});
