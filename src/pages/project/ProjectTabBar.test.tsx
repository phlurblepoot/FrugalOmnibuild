// src/pages/project/ProjectTabBar.test.tsx
import { describe, it, expect, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ProjectTabBar } from './ProjectTabBar';

const renderAt = (path: string, isAdmin = false) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <ProjectTabBar projectId="p1" isAdmin={isAdmin} />
    </MemoryRouter>
  );

describe('ProjectTabBar', () => {
  beforeEach(() => localStorage.clear());

  it('renders the project sections as buttons', () => {
    renderAt('/project/p1');
    for (const label of ['Overview', 'Takeoff & Estimate', 'Documents', 'Punch & Checklists', 'Issues', 'RFIs', 'Daily Reports', 'Mail']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('gates admin-only sections', () => {
    renderAt('/project/p1', false);
    expect(screen.queryByRole('button', { name: 'Billing' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Proposal' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Project Settings' })).toBeNull();
  });

  it('shows admin sections for admins', () => {
    renderAt('/project/p1', true);
    expect(screen.getByRole('button', { name: 'Billing' })).toBeInTheDocument();
  });

  it('marks the active section with the glow treatment', () => {
    renderAt('/project/p1/issues');
    expect(screen.getByRole('button', { name: 'Issues' }).className).toContain('glow-accent');
    expect(screen.getByRole('button', { name: 'Overview' }).className).not.toContain('glow-accent');
  });

  it('keeps Takeoff active on canvas pages', () => {
    renderAt('/project/p1/page/page-9');
    expect(screen.getByRole('button', { name: 'Takeoff & Estimate' }).className).toContain('glow-accent');
  });
});
