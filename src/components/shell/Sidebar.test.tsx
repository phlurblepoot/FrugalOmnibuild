// src/components/shell/Sidebar.test.tsx
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ThemeProvider } from '../../context/ThemeContext';
import { NotesProvider } from '../../context/NotesContext';

// useMailUnread ultimately depends on useLiveQuery, which needs a
// CollaborationProvider (socket context) this test harness doesn't set up —
// mock it at the module level, same pattern used across the app's other
// live-query-backed hooks.
const useMailUnread = vi.fn(() => 0);
vi.mock('../../pages/mail/useMailUnread', () => ({
  useMailUnread: () => useMailUnread(),
}));

// SidebarPresence (mounted in the footer) also needs a CollaborationProvider
// — mock it out the same way, since these tests exercise nav, not presence.
vi.mock('../../context/CollaborationContext', async (orig) => ({
  ...(await orig()),
  useCollaboration: () => ({
    sessions: [], mySessionId: null, followedSessionId: null,
    setFollowedSessionId: vi.fn(), updateUser: vi.fn(),
  }),
}));
vi.mock('../../hooks/useLiveQuery', () => ({ useLiveQuery: () => {} }));

const { Sidebar } = await import('./Sidebar');

const renderAt = (path: string) =>
  render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[path]}>
        <NotesProvider>
          <Sidebar state="expanded" onChange={() => {}} />
        </NotesProvider>
      </MemoryRouter>
    </ThemeProvider>
  );

const renderLockedAt = (path: string) =>
  render(
    <ThemeProvider>
      <MemoryRouter initialEntries={[path]}>
        <NotesProvider>
          <Sidebar state="expanded" onChange={() => {}} locked />
        </NotesProvider>
      </MemoryRouter>
    </ThemeProvider>
  );

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('token', 'test-token');
  localStorage.setItem('user', JSON.stringify({ username: 'noah' }));
  useMailUnread.mockReset();
  useMailUnread.mockReturnValue(0);
});

describe('Sidebar — company mode', () => {
  it('shows workspace and tools nav groups', () => {
    renderAt('/');
    for (const label of ['Dashboard', 'Projects', 'Tasks', 'Documents', 'Mail', 'Time', 'Document Editor', 'Settings']) {
      expect(screen.getByRole('button', { name: new RegExp(label) })).toBeInTheDocument();
    }
  });

  it('lists Mail right after Documents', () => {
    renderAt('/');
    const labels = screen.getAllByRole('button')
      .map(btn => btn.textContent?.trim())
      .filter((t): t is string => !!t && ['Dashboard', 'Projects', 'Customers', 'Tasks', 'Documents', 'Mail', 'Time'].some(l => t.startsWith(l)));
    const docIdx = labels.findIndex(t => t.startsWith('Documents'));
    const mailIdx = labels.findIndex(t => t.startsWith('Mail'));
    expect(docIdx).toBeGreaterThanOrEqual(0);
    expect(mailIdx).toBe(docIdx + 1);
  });

  it('shows an unread badge on Mail when useMailUnread reports a count', () => {
    useMailUnread.mockReturnValue(7);
    renderAt('/');
    const mailButton = screen.getByRole('button', { name: /Mail/ });
    expect(mailButton).toHaveTextContent('7');
    expect(screen.getByLabelText('7 unread')).toBeInTheDocument();
  });

  it('hides the badge when there are no unread messages', () => {
    useMailUnread.mockReturnValue(0);
    renderAt('/');
    expect(screen.queryByLabelText(/unread/)).not.toBeInTheDocument();
  });

  it('gives only the active item the glow treatment', () => {
    renderAt('/time');
    expect(screen.getByRole('button', { name: /Time/ }).className).toContain('glow-accent');
    expect(screen.getByRole('button', { name: /Projects/ }).className).not.toContain('glow-accent');
  });

  it('marks Dashboard active on /dashboard', () => {
    renderAt('/dashboard');
    expect(screen.getByRole('button', { name: /Dashboard/ }).className).toContain('glow-accent');
    expect(screen.getByRole('button', { name: /Projects/ }).className).not.toContain('glow-accent');
  });

  it('marks Projects active on /projects', () => {
    renderAt('/projects');
    expect(screen.getByRole('button', { name: /Projects/ }).className).toContain('glow-accent');
    expect(screen.getByRole('button', { name: /Dashboard/ }).className).not.toContain('glow-accent');
  });

  it('offers a theme toggle', () => {
    renderAt('/');
    expect(screen.getByRole('button', { name: /Dark mode|Light mode/ })).toBeInTheDocument();
  });

  it('renders nothing when logged out', () => {
    localStorage.clear();
    const { container } = renderAt('/');
    expect(container.querySelector('button')).toBeNull();
  });

  // /restore signs the bootstrap admin in, so a token exists there — the
  // chrome still has to stay away from a server with nothing to navigate to.
  it('renders nothing on the bare routes, token or not', () => {
    expect(renderAt('/login').container.querySelector('button')).toBeNull();
    expect(renderAt('/restore').container.querySelector('button')).toBeNull();
  });

  it('keeps the global workspace nav on project routes', () => {
    renderAt('/project/p1/billing');
    expect(screen.getByText('Dashboard')).toBeInTheDocument();
    expect(screen.getByText('Projects')).toBeInTheDocument();
    // No project-section entries in the sidebar anymore:
    expect(screen.queryByText('Takeoff & Estimate')).toBeNull();
    expect(screen.queryByText('All Projects')).toBeNull();
  });

  it('highlights Projects for project routes', () => {
    renderAt('/project/p1/billing');
    const btn = screen.getByRole('button', { name: 'Projects' });
    expect(btn.className).toContain('glow-accent');
  });

  it('shows the size toggles when not locked', () => {
    renderAt('/dashboard');
    expect(screen.getByTitle('Collapse')).toBeInTheDocument();
    expect(screen.getByTitle('Hide sidebar')).toBeInTheDocument();
  });

  // Reports is billing, which is admin-only everywhere.
  it('hides Reports from anyone but an admin', () => {
    renderAt('/reports');
    expect(screen.queryByRole('button', { name: /Reports/ })).toBeNull();
  });

  it('shows Reports to an admin, after Time, active on /reports', () => {
    localStorage.setItem('user', JSON.stringify({ username: 'noah', role: 'admin' }));
    renderAt('/reports?tab=payments');
    const reports = screen.getByRole('button', { name: /Reports/ });
    expect(reports.className).toContain('glow-accent');
    const labels = screen.getAllByRole('button').map(b => b.textContent?.trim());
    expect(labels.indexOf('Reports')).toBe(labels.indexOf('Time') + 1);
  });

  it('hides the size toggles when locked', () => {
    renderLockedAt('/dashboard');
    expect(screen.queryByTitle('Collapse')).toBeNull();
    expect(screen.queryByTitle('Expand navigation')).toBeNull();
    expect(screen.queryByTitle('Hide sidebar')).toBeNull();
  });

  // Photo and file links sign in by the media cookie (server/auth.ts), so
  // signing out has the server clear it as well as forgetting the token.
  it('Logout clears the media cookie and the token', () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }) as Response);
    vi.stubGlobal('fetch', fetchSpy);
    // jsdom can't follow Logout's move to /login and prints "Not implemented:
    // navigation"; harmless here.
    try {
      renderAt('/dashboard');
      fireEvent.click(screen.getByRole('button', { name: /Logout/ }));
      expect(fetchSpy).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST', keepalive: true });
      expect(localStorage.getItem('token')).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
