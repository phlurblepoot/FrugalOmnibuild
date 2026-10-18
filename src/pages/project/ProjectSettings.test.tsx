// src/pages/project/ProjectSettings.test.tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

const h = vi.hoisted(() => ({
  getProject: vi.fn(),
  getProjectDeleteCheck: vi.fn(),
  deleteProject: vi.fn(),
  patchProject: vi.fn(),
  confirm: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getProject: h.getProject,
  getCustomers: vi.fn(async () => []),
  getProjectDeleteCheck: h.getProjectDeleteCheck,
  deleteProject: h.deleteProject,
  patchProject: h.patchProject,
}));
vi.mock('../../components/ConfirmDialog', () => ({ useConfirm: () => h.confirm }));
vi.mock('../../components/Toast', () => ({ useToast: () => ({ toast: h.toast }) }));

import { ProjectSettings } from './ProjectSettings';
import { ProjectHasDataError } from '../../utils/store';

const project = (over: Record<string, unknown> = {}) => ({
  id: 'p1', name: 'Maple St', version: 3, status: 'in_progress', pages: [], takeoffs: [], createdAt: 1, ...over,
});

function mount() {
  return render(
    <MemoryRouter initialEntries={['/project/p1/settings']}>
      <Routes>
        <Route path="/project/:projectId/settings" element={<ProjectSettings />} />
        <Route path="/projects" element={<div data-testid="projects-page" />} />
      </Routes>
    </MemoryRouter>
  );
}

const deleteRow = async () => within(await screen.findByTestId('delete-project-row'));

beforeEach(() => {
  for (const f of Object.values(h)) f.mockReset();
  localStorage.clear();
  localStorage.setItem('user', JSON.stringify({ role: 'admin' }));
  h.getProject.mockResolvedValue(project());
  h.patchProject.mockResolvedValue({ version: 4, status: 'in_progress' });
});

// Only a project with nothing in it can be deleted (spec
// docs/superpowers/specs/2026-10-07-project-delete-guard-design.md).
describe('ProjectSettings delete', () => {
  it('a project with data: Delete is disabled with the reason; the Archive row above archives it', async () => {
    h.getProjectDeleteCheck.mockResolvedValue({ canDelete: false, summary: { invoices: 2, documents: 12 } });
    mount();
    const row = await deleteRow();
    expect(await row.findByText('Has 12 documents and 2 invoices — archive it instead.')).toBeInTheDocument();
    expect(row.getByRole('button', { name: /delete/i })).toBeDisabled();
    // One Archive button on the page: the Archive row's, not a second one in the Delete row.
    expect(row.queryByRole('button', { name: /archive/i })).toBeNull();
    expect(screen.getAllByRole('button', { name: /^archive$/i })).toHaveLength(1);

    fireEvent.click(screen.getByRole('button', { name: /^archive$/i }));
    await waitFor(() => expect(h.patchProject).toHaveBeenCalledWith('p1', { version: 3, archived: true }));
    expect(h.deleteProject).not.toHaveBeenCalled();
    expect(h.toast).toHaveBeenCalledWith('Project archived', { type: 'success' });
  });

  it('an archived project with data: the reason, Delete still disabled', async () => {
    h.getProject.mockResolvedValue(project({ archived: true }));
    h.getProjectDeleteCheck.mockResolvedValue({ canDelete: false, summary: { rfis: 1 } });
    mount();
    const row = await deleteRow();
    expect(await row.findByText('Has 1 RFI — archive it instead.')).toBeInTheDocument();
    expect(row.queryByRole('button', { name: /archive/i })).toBeNull();
    expect(row.getByRole('button', { name: /delete/i })).toBeDisabled();
  });

  it('an empty project deletes as before: the same confirm, then back to Projects', async () => {
    h.getProjectDeleteCheck.mockResolvedValue({ canDelete: true, summary: {} });
    h.confirm.mockResolvedValue(true);
    h.deleteProject.mockResolvedValue(undefined);
    mount();
    const row = await deleteRow();
    const del = row.getByRole('button', { name: /delete/i });
    await waitFor(() => expect(del).toBeEnabled());
    expect(row.queryByRole('button', { name: /archive/i })).toBeNull();

    fireEvent.click(del);
    await waitFor(() => expect(h.deleteProject).toHaveBeenCalledWith('p1'));
    expect(h.confirm).toHaveBeenCalledWith({
      title: 'Delete project',
      message: 'Delete this project and all its data? This cannot be undone.',
      confirmLabel: 'Delete',
      tone: 'danger',
    });
    expect(await screen.findByTestId('projects-page')).toBeInTheDocument();
  });

  it('if the server refuses after all, it says why and offers Archive', async () => {
    // Empty when the page asked; someone uploads a document before Delete.
    h.getProjectDeleteCheck
      .mockResolvedValueOnce({ canDelete: true, summary: {} })
      .mockResolvedValue({ canDelete: false, summary: { documents: 1 } });
    h.confirm.mockResolvedValue(true); // the delete confirm, then the Archive offer
    h.deleteProject.mockRejectedValue(new ProjectHasDataError({ documents: 1 }));
    mount();
    const row = await deleteRow();
    const del = row.getByRole('button', { name: /delete/i });
    await waitFor(() => expect(del).toBeEnabled());

    fireEvent.click(del);
    await waitFor(() => expect(h.confirm).toHaveBeenCalledTimes(2));
    expect(h.confirm).toHaveBeenLastCalledWith({
      title: "Can't delete this project", message: 'Has 1 document — archive it instead.', confirmLabel: 'Archive',
    });
    await waitFor(() => expect(h.patchProject).toHaveBeenCalledWith('p1', { version: 3, archived: true }));
    expect(await (await deleteRow()).findByText('Has 1 document — archive it instead.')).toBeInTheDocument();
    expect(screen.queryByTestId('projects-page')).toBeNull();
  });

  it('if the check itself fails, Delete stays offered (the server still decides)', async () => {
    h.getProjectDeleteCheck.mockRejectedValue(new Error('offline'));
    mount();
    const row = await deleteRow();
    await waitFor(() => expect(row.getByRole('button', { name: /delete/i })).toBeEnabled());
  });
});
