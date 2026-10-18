// src/components/ProjectStageControl.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { ProjectStageControl } from './ProjectStageControl';
import { ToastProvider } from './Toast';

const patchProject = vi.hoisted(() => vi.fn());
vi.mock('../utils/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../utils/store')>();
  return { ...actual, patchProject };
});

beforeEach(() => patchProject.mockReset());

const renderControl = (onChanged = vi.fn(), status = 'bidding') =>
  render(
    <ToastProvider>
      <ProjectStageControl projectId="p1" version={3} status={status} onChanged={onChanged} />
    </ToastProvider>
  );

describe('ProjectStageControl', () => {
  it('offers the two live stages and nothing else', () => {
    renderControl();
    fireEvent.click(screen.getByTitle('Change project stage'));
    const options = screen.getAllByRole('button').filter(b => b.className.includes('text-left'));
    expect(options.map(b => b.textContent)).toEqual(['Bidding', 'In Progress']);
  });

  it('patches the stage and reports the new version', async () => {
    patchProject.mockResolvedValue({ version: 4, status: 'in_progress' });
    const onChanged = vi.fn();
    renderControl(onChanged);
    fireEvent.click(screen.getByTitle('Change project stage'));
    fireEvent.click(screen.getByRole('button', { name: 'In Progress' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalledWith(4, 'in_progress'));
    expect(patchProject).toHaveBeenCalledWith('p1', { version: 3, status: 'in_progress' });
  });

  it('dispatches a confetti celebration when a bid is won (bidding -> in_progress)', async () => {
    patchProject.mockResolvedValue({ version: 4, status: 'in_progress' });
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    renderControl(vi.fn(), 'bidding');
    fireEvent.click(screen.getByTitle('Change project stage'));
    fireEvent.click(screen.getByRole('button', { name: 'In Progress' }));
    await waitFor(() => expect(patchProject).toHaveBeenCalled());
    const celebrateCall = dispatchSpy.mock.calls.find(([evt]) => (evt as CustomEvent).type === 'celebrate');
    expect(celebrateCall).toBeDefined();
    expect((celebrateCall![0] as CustomEvent).detail.variant).toBe('confetti');
    dispatchSpy.mockRestore();
  });

  it('does not dispatch a celebration on the reverse transition (in_progress -> bidding)', async () => {
    patchProject.mockResolvedValue({ version: 4, status: 'bidding' });
    const dispatchSpy = vi.spyOn(window, 'dispatchEvent');
    renderControl(vi.fn(), 'in_progress');
    fireEvent.click(screen.getByTitle('Change project stage'));
    fireEvent.click(screen.getByRole('button', { name: 'Bidding' }));
    await waitFor(() => expect(patchProject).toHaveBeenCalled());
    const celebrateCall = dispatchSpy.mock.calls.find(([evt]) => (evt as CustomEvent).type === 'celebrate');
    expect(celebrateCall).toBeUndefined();
    dispatchSpy.mockRestore();
  });

  it('treats a legacy status as the stage it collapses to', () => {
    renderControl(vi.fn(), 'awarded');
    // The pill reads the collapsed stage, and re-picking it is a no-op write.
    expect(screen.getByText('In Progress')).toBeInTheDocument();
    fireEvent.click(screen.getByTitle('Change project stage'));
    // The trigger pill also reads "In Progress", so pick the menu option by role.
    const option = screen.getAllByRole('button')
      .find(b => b.className.includes('text-left') && b.textContent === 'In Progress')!;
    fireEvent.click(option);
    expect(patchProject).not.toHaveBeenCalled();
  });
});
