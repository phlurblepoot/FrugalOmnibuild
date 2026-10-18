// src/components/ProjectConflictListener.test.tsx
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import ProjectConflictListener from './ProjectConflictListener';
import { ToastProvider } from './Toast';

const getProject = vi.hoisted(() => vi.fn());
vi.mock('../utils/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/store')>();
  return { ...actual, getProject };
});

const renderListener = () =>
  render(
    <ToastProvider>
      <ProjectConflictListener />
    </ToastProvider>
  );

const originalLocation = window.location;
let reloadSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  getProject.mockReset();
  reloadSpy = vi.fn();
  // jsdom's window.location.reload is non-configurable, so vi.spyOn on it
  // throws; stub the whole location object instead (per-test, restored after).
  Object.defineProperty(window, 'location', {
    configurable: true,
    value: { ...originalLocation, reload: reloadSpy }
  });
});

afterEach(() => {
  Object.defineProperty(window, 'location', { configurable: true, value: originalLocation });
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('ProjectConflictListener', () => {
  it('on successful refetch, dispatches project-refreshed and does not reload', async () => {
    const project = { id: 'p1', version: 5 };
    getProject.mockResolvedValue(project);

    const refreshedHandler = vi.fn();
    window.addEventListener('project-refreshed', refreshedHandler);

    renderListener();
    window.dispatchEvent(new CustomEvent('project-conflict', { detail: { projectId: 'p1' } }));

    await waitFor(() => expect(getProject).toHaveBeenCalledWith('p1'));
    await waitFor(() => expect(refreshedHandler).toHaveBeenCalledTimes(1));

    const event = refreshedHandler.mock.calls[0][0] as CustomEvent;
    expect(event.detail).toEqual({ projectId: 'p1', project });

    expect(reloadSpy).not.toHaveBeenCalled();
    window.removeEventListener('project-refreshed', refreshedHandler);
  });

  it('falls back to reload after a failed refetch', async () => {
    vi.useFakeTimers();
    getProject.mockRejectedValue(new Error('network down'));

    renderListener();
    window.dispatchEvent(new CustomEvent('project-conflict', { detail: { projectId: 'p1' } }));

    await vi.waitFor(() => expect(getProject).toHaveBeenCalledWith('p1'));

    expect(reloadSpy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2000);
    expect(reloadSpy).toHaveBeenCalledTimes(1);
  });
});
