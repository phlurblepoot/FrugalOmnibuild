// src/pages/project/ProjectOverview.test.tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
const st = vi.hoisted(() => ({ tab: 'overview' }));
vi.mock('../../utils/store', () => ({
  peekDefaultProjectTab: () => st.tab,
  getDefaultProjectTab: async () => st.tab,
}));
import type { CardContext, CardPage } from '../../cards';

const h = vi.hoisted(() => ({ useProjectOutlet: vi.fn() }));

vi.mock('./ProjectLayout', () => ({ useProjectOutlet: h.useProjectOutlet }));

vi.mock('../../cards', () => ({
  CardGrid: ({ page, ctx }: { page: CardPage; ctx: CardContext }) => (
    <div data-testid="card-grid" data-page={page} data-project-id={ctx.projectId} data-is-admin={String(ctx.isAdmin)} />
  ),
}));

import { ProjectOverview } from './ProjectOverview';

function mount(initialEntry = '/project/p1') {
  return render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <Routes>
        <Route path="/project/:projectId" element={<ProjectOverview />} />
        <Route path="/project/:projectId/takeoff" element={<div data-testid="takeoff-page" />} />
      </Routes>
    </MemoryRouter>
  );
}

beforeEach(() => {
  h.useProjectOutlet.mockReset();
  localStorage.clear();
  st.tab = 'overview';
});

describe('ProjectOverview', () => {
  it('lands on the user default tab instead of the overview', () => {
    st.tab = 'takeoff';
    h.useProjectOutlet.mockReturnValue({ summary: null, refreshSummary: vi.fn() });
    mount();
    expect(screen.getByTestId('takeoff-page')).toBeInTheDocument();
  });

  it('stays on the overview when the default is overview', () => {
    h.useProjectOutlet.mockReturnValue({ summary: { id: 'p1', name: 'Test Project', version: 1, status: 'in_progress' }, refreshSummary: vi.fn() });
    mount();
    expect(screen.queryByTestId('takeoff-page')).not.toBeInTheDocument();
  });

  it('forwards a legacy ?tab= bookmark straight to the takeoff route', () => {
    h.useProjectOutlet.mockReturnValue({ summary: null, refreshSummary: vi.fn() });
    mount('/project/p1?tab=takeoffs');
    expect(screen.getByTestId('takeoff-page')).toBeInTheDocument();
  });

  it('shows a header skeleton and a skeleton grid placeholder before summary loads (no card-grid yet)', () => {
    h.useProjectOutlet.mockReturnValue({ summary: null, refreshSummary: vi.fn() });
    mount();
    expect(screen.queryByTestId('card-grid')).not.toBeInTheDocument();
    expect(screen.queryByText('Test Project')).not.toBeInTheDocument();
  });

  it('renders the project name, stage control, and card grid once summary loads', () => {
    localStorage.setItem('user', JSON.stringify({ role: 'admin' }));
    h.useProjectOutlet.mockReturnValue({
      summary: { id: 'p1', name: 'Test Project', version: 3, status: 'in_progress' },
      refreshSummary: vi.fn(),
    });
    mount();

    expect(screen.getByText('Test Project')).toBeInTheDocument();
    // ProjectStageControl renders the current stage pill/label somewhere —
    // just assert its dropdown trigger is present via role button.
    expect(screen.getByRole('button')).toBeInTheDocument();

    const grid = screen.getByTestId('card-grid');
    expect(grid).toHaveAttribute('data-page', 'project');
    expect(grid).toHaveAttribute('data-project-id', 'p1');
    expect(grid).toHaveAttribute('data-is-admin', 'true');
  });

  it('passes isAdmin=false for a non-admin user', () => {
    localStorage.setItem('user', JSON.stringify({ role: 'user' }));
    h.useProjectOutlet.mockReturnValue({
      summary: { id: 'p1', name: 'Test Project', version: 1, status: 'bidding' },
      refreshSummary: vi.fn(),
    });
    mount();
    expect(screen.getByTestId('card-grid')).toHaveAttribute('data-is-admin', 'false');
  });
});
