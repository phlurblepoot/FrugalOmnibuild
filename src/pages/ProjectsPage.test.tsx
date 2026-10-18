// src/pages/ProjectsPage.test.tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const h = vi.hoisted(() => ({
  getProjectsSummary: vi.fn(),
  getProjectDeleteCheck: vi.fn(),
  deleteProject: vi.fn(),
  patchProject: vi.fn(),
  toast: vi.fn(),
}));

vi.mock('../utils/store', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getProjectsSummary: h.getProjectsSummary,
  getProjectDeleteCheck: h.getProjectDeleteCheck,
  deleteProject: h.deleteProject,
  patchProject: h.patchProject,
  getCustomers: vi.fn(async () => []),
  getUserPreferences: vi.fn(async () => ({})),
  saveUserPreferences: vi.fn(async () => {}),
  getRecentProjects: () => [],
}));
vi.mock('../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: null, sessions: [], mySessionId: 's1' }),
}));
vi.mock('../components/Toast', () => ({ useToast: () => ({ toast: h.toast }) }));

import { ProjectsPage, groupSummaries, resolveTab, sortProjects, tabForProject } from './ProjectsPage';
import { ProjectHasDataError, type ProjectSummary } from '../utils/store';

const mk = (over: Partial<ProjectSummary>): ProjectSummary => ({
  id: 'x', name: 'P', status: 'bidding', contractor: null, customerId: null, address: null,
  bidDueDate: null, version: 1, createdAt: 1, updatedAt: null, archived: false,
  pageCount: 0, takeoffCount: 0, pageIds: [], openIssueCount: 0, punchDone: 0, punchTotal: 0, contractValueCents: 0, invoiceCount: 0, ...over,
});

describe('tabForProject', () => {
  it('routes the two live stages to their own tabs', () => {
    expect(tabForProject(mk({ status: 'bidding' }))).toBe('bidding');
    expect(tabForProject(mk({ status: 'in_progress' }))).toBe('in_progress');
  });

  it('lets archived win over whatever status the project carries', () => {
    expect(tabForProject(mk({ status: 'in_progress', archived: true }))).toBe('archive');
    expect(tabForProject(mk({ status: 'bidding', archived: true }))).toBe('archive');
  });

  it('collapses legacy statuses and folds unknown ones into bidding', () => {
    expect(tabForProject(mk({ status: 'proposal_sent' }))).toBe('bidding');
    expect(tabForProject(mk({ status: 'awarded' }))).toBe('in_progress');
    expect(tabForProject(mk({ status: 'punch_list' }))).toBe('in_progress');
    expect(tabForProject(mk({ status: 'something_weird' }))).toBe('bidding');
  });
});

describe('resolveTab', () => {
  it('accepts the three tab ids', () => {
    expect(resolveTab('bidding')).toBe('bidding');
    expect(resolveTab('in_progress')).toBe('in_progress');
    expect(resolveTab('archive')).toBe('archive');
  });

  it('lands old bookmarks on the tab their projects moved to', () => {
    expect(resolveTab('estimating')).toBe('bidding');
    expect(resolveTab('proposal_sent')).toBe('bidding');
    expect(resolveTab('awarded')).toBe('in_progress');
    expect(resolveTab('active')).toBe('in_progress');
    // migration 21 auto-archived complete and lost projects.
    expect(resolveTab('complete')).toBe('archive');
    expect(resolveTab('lost')).toBe('archive');
  });

  it('defaults to bidding when the param is missing or nonsense', () => {
    expect(resolveTab(null)).toBe('bidding');
    expect(resolveTab('')).toBe('bidding');
    expect(resolveTab('constructor')).toBe('bidding');
  });
});

describe('groupSummaries', () => {
  it('returns exactly the three tabs, in board order', () => {
    const groups = groupSummaries([]);
    expect(groups.map(g => g.id)).toEqual(['bidding', 'in_progress', 'archive']);
  });

  it('puts every project in exactly one tab', () => {
    const groups = groupSummaries([
      mk({ id: 'a', status: 'bidding' }),
      mk({ id: 'b', status: 'proposal_sent' }),
      mk({ id: 'c', status: 'in_progress' }),
      mk({ id: 'd', status: 'awarded' }),
      mk({ id: 'e', status: 'in_progress', archived: true }),
      mk({ id: 'f', status: 'something_weird' }),
    ], 'name');
    expect(groups[0].projects.map(p => p.id)).toEqual(['a', 'b', 'f']);
    expect(groups[1].projects.map(p => p.id)).toEqual(['c', 'd']);
    expect(groups[2].projects.map(p => p.id)).toEqual(['e']);
  });

  it('defaults bidding to bid-due order and the other tabs to last updated', () => {
    const groups = groupSummaries([
      mk({ id: 'late', status: 'bidding', bidDueDate: 200, updatedAt: 99 }),
      mk({ id: 'soon', status: 'bidding', bidDueDate: 100, updatedAt: 1 }),
      mk({ id: 'stale', status: 'in_progress', updatedAt: 10 }),
      mk({ id: 'fresh', status: 'in_progress', updatedAt: 20 }),
      mk({ id: 'old-arch', status: 'in_progress', archived: true, updatedAt: 10 }),
      mk({ id: 'new-arch', status: 'in_progress', archived: true, updatedAt: 20 }),
    ]);
    expect(groups[0].projects.map(p => p.id)).toEqual(['soon', 'late']);
    expect(groups[1].projects.map(p => p.id)).toEqual(['fresh', 'stale']);
    expect(groups[2].projects.map(p => p.id)).toEqual(['new-arch', 'old-arch']);
  });

  it('lets an explicit sort override every tab default', () => {
    const groups = groupSummaries([
      mk({ id: 'late', status: 'bidding', bidDueDate: 200, updatedAt: 99 }),
      mk({ id: 'soon', status: 'bidding', bidDueDate: 100, updatedAt: 1 }),
    ], 'updated');
    expect(groups[0].projects.map(p => p.id)).toEqual(['late', 'soon']);
  });
});

describe('sortProjects', () => {
  it('sorts by name, date added, last updated, and bid due (undated last)', () => {
    const list = [
      mk({ id: 'b', name: 'Beta', createdAt: 100, updatedAt: 5, bidDueDate: 200 }),
      mk({ id: 'a', name: 'Alpha', createdAt: 300, updatedAt: 50, bidDueDate: null }),
      mk({ id: 'c', name: 'Gamma', createdAt: 200, updatedAt: 30, bidDueDate: 100 }),
    ];
    expect(sortProjects(list, 'name').map(p => p.id)).toEqual(['a', 'b', 'c']);
    expect(sortProjects(list, 'created').map(p => p.id)).toEqual(['a', 'c', 'b']);
    expect(sortProjects(list, 'updated').map(p => p.id)).toEqual(['a', 'c', 'b']);
    expect(sortProjects(list, 'bidDue').map(p => p.id)).toEqual(['c', 'b', 'a']);
  });
});

// Only a project with nothing in it can be deleted (spec
// docs/superpowers/specs/2026-10-07-project-delete-guard-design.md).
describe('ProjectsPage delete', () => {
  function mount(path = '/projects') {
    return render(<MemoryRouter initialEntries={[path]}><ProjectsPage /></MemoryRouter>);
  }
  const openDelete = async (name: string) => {
    const row = (await screen.findByText(name)).closest('[data-testid="project-row"]') as HTMLElement;
    fireEvent.click(within(row).getByTitle('Delete'));
    return screen.findByRole('dialog');
  };

  beforeEach(() => {
    for (const f of Object.values(h)) f.mockReset();
    localStorage.clear();
    h.getProjectsSummary.mockResolvedValue([mk({ id: 'p1', name: 'Maple St', version: 2 })]);
    h.patchProject.mockResolvedValue({ version: 3, status: 'bidding' });
  });

  it('a project with data: the dialog says why and offers Archive instead of Delete', async () => {
    h.getProjectDeleteCheck.mockResolvedValue({ canDelete: false, summary: { documents: 12, invoices: 2 } });
    mount();
    const dialog = await openDelete('Maple St');
    expect(h.getProjectDeleteCheck).toHaveBeenCalledWith('p1');
    expect(await within(dialog).findByText('Has 12 documents and 2 invoices — archive it instead.')).toBeInTheDocument();
    expect(within(dialog).getByText('Can\'t delete "Maple St"')).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Delete project' })).toBeNull();
    expect(within(dialog).queryByPlaceholderText('delete')).toBeNull();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Archive' }));
    await waitFor(() => expect(h.patchProject).toHaveBeenCalledWith('p1', { version: 2, archived: true }));
    expect(h.toast).toHaveBeenCalledWith('Project archived', { type: 'success' });
    expect(h.deleteProject).not.toHaveBeenCalled();
  });

  it('an archived project with data: the reason and Close, no Archive', async () => {
    h.getProjectsSummary.mockResolvedValue([mk({ id: 'p1', name: 'Maple St', archived: true })]);
    h.getProjectDeleteCheck.mockResolvedValue({ canDelete: false, summary: { planPages: 40 } });
    mount('/projects?stage=archive');
    const dialog = await openDelete('Maple St');
    expect(await within(dialog).findByText('Has 40 plan pages — archive it instead.')).toBeInTheDocument();
    expect(within(dialog).getByText(/already archived/)).toBeInTheDocument();
    expect(within(dialog).queryByRole('button', { name: 'Archive' })).toBeNull();
    expect(within(dialog).getByRole('button', { name: 'Close' })).toBeInTheDocument();
  });

  it('an empty project deletes as before: type delete, then it is gone', async () => {
    h.getProjectDeleteCheck.mockResolvedValue({ canDelete: true, summary: {} });
    h.deleteProject.mockResolvedValue(undefined);
    mount();
    const dialog = await openDelete('Maple St');
    expect(within(dialog).getByText('Delete "Maple St"?')).toBeInTheDocument();
    fireEvent.change(await within(dialog).findByPlaceholderText('delete'), { target: { value: 'delete' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete project' }));
    await waitFor(() => expect(h.deleteProject).toHaveBeenCalledWith('p1'));
    expect(h.toast).toHaveBeenCalledWith('Project deleted', { type: 'success' });
    await waitFor(() => expect(screen.queryByText('Maple St')).toBeNull());
  });

  it('Delete waits for the check: nothing to type until it answers', async () => {
    h.getProjectDeleteCheck.mockReturnValue(new Promise(() => {}));
    mount();
    const dialog = await openDelete('Maple St');
    expect(within(dialog).getByText('Checking what\'s in this project…')).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Delete project' })).toBeDisabled();
  });

  it('if the server refuses after all, the project comes back and the dialog says why with Archive', async () => {
    h.getProjectDeleteCheck.mockResolvedValue({ canDelete: true, summary: {} });
    h.deleteProject.mockRejectedValue(new ProjectHasDataError({ rfis: 1 }));
    mount();
    let dialog = await openDelete('Maple St');
    fireEvent.change(await within(dialog).findByPlaceholderText('delete'), { target: { value: 'delete' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete project' }));

    await waitFor(() => expect(screen.getByText('Has 1 RFI — archive it instead.')).toBeInTheDocument());
    dialog = screen.getByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Archive' })).toBeInTheDocument();
    expect(screen.getAllByTestId('project-row')).toHaveLength(1);
    expect(h.toast).not.toHaveBeenCalledWith('Failed to delete project', expect.anything());
  });

  it('starring a project adds it to the Favorites switch, which is remembered', async () => {
    // The store's own preference calls bypass the module mock above.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })));
    mount();
    const row = (await screen.findByText('Maple St')).closest('[data-testid="project-row"]') as HTMLElement;
    fireEvent.click(within(row).getByTestId('favorite-star'));
    await waitFor(() => expect(within(row).getByTestId('favorite-star')).toHaveAttribute('aria-pressed', 'true'));
    fireEvent.click(screen.getByTestId('quick-favorites'));
    expect(localStorage.getItem('projectsQuickView')).toBe('favorites');
    await waitFor(() => expect(screen.getAllByTestId('project-row')).toHaveLength(2));
    expect(screen.queryByTestId('quick-empty')).toBeNull();
    fireEvent.click(screen.getByTestId('quick-recent'));
    expect(await screen.findByTestId('quick-empty')).toBeInTheDocument();
  });
});
