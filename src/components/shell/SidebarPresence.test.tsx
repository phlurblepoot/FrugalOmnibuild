// src/components/shell/SidebarPresence.test.tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { SessionView } from '../../context/CollaborationContext';

const mkSession = (over: Partial<SessionView>): SessionView => ({
  sessionId: 's1', userId: 'u1', name: 'Sarah', role: 'user', color: '#40c9c6',
  device: 'Linux · Chrome', location: { path: '/dashboard' }, editing: null,
  cursor: null, lastActive: Date.now(), ...over,
});

const navigateSpy = vi.hoisted(() => vi.fn());
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  return { ...actual, useNavigate: () => navigateSpy };
});

const collab = {
  sessions: [] as SessionView[],
  mySessionId: 'me',
  followedSessionId: null as string | null,
  setFollowedSessionId: vi.fn(),
  updateUser: vi.fn(),
};
vi.mock('../../context/CollaborationContext', async (orig) => ({
  ...(await orig()),
  useCollaboration: () => collab,
}));
vi.mock('../../hooks/useLiveQuery', () => ({ useLiveQuery: () => {} }));
vi.mock('../../utils/store', async (orig) => ({
  ...(await orig()),
  getProjectsSummary: vi.fn(async () => []),
}));

const { SidebarPresence } = await import('./SidebarPresence');

const renderIt = () => render(
  <MemoryRouter><SidebarPresence expanded /></MemoryRouter>
);

describe('SidebarPresence', () => {
  beforeEach(() => {
    collab.sessions = [
      mkSession({ sessionId: 'me', userId: 'me-u', name: 'Noah' }),
      mkSession({ sessionId: 's2', userId: 'u2', name: 'Sarah' }),
    ];
    collab.setFollowedSessionId.mockClear();
    navigateSpy.mockClear();
  });

  it('shows the online count', () => {
    renderIt();
    expect(screen.getByTestId('sidebar-presence')).toHaveTextContent('2 online');
  });

  it('opens a popover listing users with Follow controls', () => {
    renderIt();
    fireEvent.click(screen.getByTestId('sidebar-presence'));
    expect(screen.getByTestId('presence-popover')).toBeInTheDocument();
    expect(screen.getByText('Sarah')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('checkbox', { name: /follow sarah/i }));
    expect(collab.setFollowedSessionId).toHaveBeenCalledWith('s2');
  });

  it('renders nothing when you are the only session', () => {
    collab.sessions = [mkSession({ sessionId: 'me', name: 'Noah' })];
    renderIt();
    // Still shows the stack (1 online) — presence is a permanent fixture:
    expect(screen.getByTestId('sidebar-presence')).toHaveTextContent('1 online');
  });

  it('merges a second tab of my own account into the self group instead of dropping it', () => {
    collab.sessions = [
      mkSession({ sessionId: 'me', userId: 'me-u', name: 'Noah', device: 'Windows · Chrome' }),
      mkSession({ sessionId: 'me2', userId: 'me-u', name: 'Noah', device: 'iPad · Safari' }),
    ];
    renderIt();
    // One user online (both sessions are mine), not two:
    expect(screen.getByTestId('sidebar-presence')).toHaveTextContent('1 online');

    fireEvent.click(screen.getByTestId('sidebar-presence'));
    // Both sessions' device lines render under the single "(you)" row —
    // the second tab must not be dropped.
    expect(screen.getByText(/Windows · Chrome/)).toBeInTheDocument();
    expect(screen.getByText(/iPad · Safari/)).toBeInTheDocument();
    expect(screen.getAllByText(/\(you\)/)).toHaveLength(1);
    // A same-account session never gets a Follow checkbox:
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
  });

  // ── Click-to-jump + per-session Follow ──────────────────────────────────

  it('single-session other user: the row is a jump button that navigates to their path and closes the popover', async () => {
    collab.sessions = [
      mkSession({ sessionId: 'me', userId: 'me-u', name: 'Noah' }),
      mkSession({ sessionId: 's2', userId: 'u2', name: 'Sarah', location: { path: '/project/p1/billing', projectId: 'p1', section: 'billing' } }),
    ];
    renderIt();
    fireEvent.click(screen.getByTestId('sidebar-presence'));
    const row = screen.getByTestId('presence-user-jump');
    expect(row.tagName).toBe('BUTTON');
    expect(row).toHaveTextContent('Sarah');
    // Only the single-session variant exists here — no per-session controls.
    expect(screen.queryByTestId('presence-session-jump')).not.toBeInTheDocument();
    expect(screen.queryByTestId('presence-session-follow')).not.toBeInTheDocument();

    fireEvent.click(row);
    expect(navigateSpy).toHaveBeenCalledWith('/project/p1/billing');
    // AnimatePresence keeps the popover mounted through its exit animation.
    await waitFor(() => expect(screen.queryByTestId('presence-popover')).not.toBeInTheDocument());
  });

  it('single-session other user: the user-level Follow checkbox does not trigger the jump', () => {
    collab.sessions = [
      mkSession({ sessionId: 'me', userId: 'me-u', name: 'Noah' }),
      mkSession({ sessionId: 's2', userId: 'u2', name: 'Sarah', location: { path: '/project/p1/billing', projectId: 'p1' } }),
    ];
    renderIt();
    fireEvent.click(screen.getByTestId('sidebar-presence'));
    fireEvent.click(screen.getByRole('checkbox', { name: /follow sarah/i }));
    expect(collab.setFollowedSessionId).toHaveBeenCalledWith('s2');
    expect(navigateSpy).not.toHaveBeenCalled();
    expect(screen.getByTestId('presence-popover')).toBeInTheDocument();
  });

  it('two-session other user: each session line jumps to ITS path and has its own Follow', async () => {
    collab.sessions = [
      mkSession({ sessionId: 'me', userId: 'me-u', name: 'Noah' }),
      mkSession({ sessionId: 's2', userId: 'u2', name: 'Sarah', device: 'Windows · Chrome', location: { path: '/project/p1/takeoff', projectId: 'p1', section: 'takeoff' } }),
      mkSession({ sessionId: 's3', userId: 'u2', name: 'Sarah', device: 'iPad · Safari', location: { path: '/project/p1/issues', projectId: 'p1', section: 'issues' } }),
    ];
    renderIt();
    fireEvent.click(screen.getByTestId('sidebar-presence'));
    // The user row itself is NOT a jump target for a multi-session user.
    expect(screen.queryByTestId('presence-user-jump')).not.toBeInTheDocument();

    const jumps = screen.getAllByTestId('presence-session-jump');
    expect(jumps).toHaveLength(2);
    expect(jumps[0]).toHaveTextContent('Windows · Chrome');
    expect(jumps[1]).toHaveTextContent('iPad · Safari');
    fireEvent.click(jumps[1]);
    expect(navigateSpy).toHaveBeenCalledTimes(1);
    expect(navigateSpy).toHaveBeenCalledWith('/project/p1/issues');
    await waitFor(() => expect(screen.queryByTestId('presence-popover')).not.toBeInTheDocument());

    // Re-open: two per-session Follow controls, no user-level one.
    fireEvent.click(screen.getByTestId('sidebar-presence'));
    expect(screen.getAllByTestId('presence-session-follow')).toHaveLength(2);
    expect(screen.queryByRole('checkbox', { name: /^follow sarah$/i })).not.toBeInTheDocument();
    const second = screen.getByRole('checkbox', { name: /follow sarah \(ipad · safari\)/i });
    fireEvent.click(second);
    expect(collab.setFollowedSessionId).toHaveBeenCalledWith('s3');
    // Checking a session's Follow must not also jump.
    expect(navigateSpy).toHaveBeenCalledTimes(1);
  });

  it('two-session other user: checked state tracks followedSessionId per session', () => {
    collab.sessions = [
      mkSession({ sessionId: 'me', userId: 'me-u', name: 'Noah' }),
      mkSession({ sessionId: 's2', userId: 'u2', name: 'Sarah', device: 'Windows · Chrome' }),
      mkSession({ sessionId: 's3', userId: 'u2', name: 'Sarah', device: 'iPad · Safari' }),
    ];
    collab.followedSessionId = 's3';
    try {
      renderIt();
      fireEvent.click(screen.getByTestId('sidebar-presence'));
      expect(screen.getByRole('checkbox', { name: /windows · chrome/i })).not.toBeChecked();
      expect(screen.getByRole('checkbox', { name: /ipad · safari/i })).toBeChecked();
      // Unchecking the followed one clears the follow.
      fireEvent.click(screen.getByRole('checkbox', { name: /ipad · safari/i }));
      expect(collab.setFollowedSessionId).toHaveBeenCalledWith(null);
    } finally {
      collab.followedSessionId = null;
    }
  });

  it('own sessions: other tabs are jumpable, this tab is not, and there is never a Follow', () => {
    collab.sessions = [
      mkSession({ sessionId: 'me', userId: 'me-u', name: 'Noah', device: 'Windows · Chrome', location: { path: '/dashboard' } }),
      mkSession({ sessionId: 'me2', userId: 'me-u', name: 'Noah', device: 'iPad · Safari', location: { path: '/project/p1/punch', projectId: 'p1', section: 'punch' } }),
    ];
    renderIt();
    fireEvent.click(screen.getByTestId('sidebar-presence'));
    expect(screen.queryByTestId('presence-user-jump')).not.toBeInTheDocument();
    expect(screen.queryByTestId('presence-session-follow')).not.toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    const jumps = screen.getAllByTestId('presence-session-jump');
    expect(jumps).toHaveLength(1);
    expect(jumps[0]).toHaveTextContent('iPad · Safari');
    fireEvent.click(jumps[0]);
    expect(navigateSpy).toHaveBeenCalledWith('/project/p1/punch');
  });

  it('a session with no known path is not a jump target', () => {
    collab.sessions = [
      mkSession({ sessionId: 'me', userId: 'me-u', name: 'Noah' }),
      mkSession({ sessionId: 's2', userId: 'u2', name: 'Sarah', location: null }),
    ];
    renderIt();
    fireEvent.click(screen.getByTestId('sidebar-presence'));
    expect(screen.getByText('Sarah')).toBeInTheDocument();
    expect(screen.queryByTestId('presence-user-jump')).not.toBeInTheDocument();
    expect(screen.queryByTestId('presence-session-jump')).not.toBeInTheDocument();
    // Follow is still offered (it's about the session, not its current path).
    expect(screen.getByRole('checkbox', { name: /follow sarah/i })).toBeInTheDocument();
  });
});
