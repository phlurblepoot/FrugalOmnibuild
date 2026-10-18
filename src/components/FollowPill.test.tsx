// src/components/FollowPill.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import React from 'react';
import type { SessionView } from '../context/CollaborationContext';
import { FollowPill } from './FollowPill';

const mockCollab = vi.hoisted(() => vi.fn());
vi.mock('../context/CollaborationContext', () => ({
  useCollaboration: () => mockCollab(),
}));

const sess = (over: Partial<SessionView>): SessionView => ({
  sessionId: 's1', userId: 'u1', name: 'noah', role: 'admin', color: '#3b82f6',
  device: 'Windows · Chrome', location: null, editing: null, cursor: null, lastActive: 1,
  ...over,
});

const setup = (sessions: SessionView[], followedSessionId: string | null) => {
  const setFollowedSessionId = vi.fn();
  mockCollab.mockReturnValue({ sessions, followedSessionId, setFollowedSessionId });
  return { setFollowedSessionId };
};

describe('FollowPill', () => {
  it('renders nothing when no one is being followed', () => {
    setup([sess({ sessionId: 'a1', name: 'sam', device: 'Mac · Safari' })], null);
    const { container } = render(<FollowPill />);
    expect(container.firstChild).toBeNull();
  });

  it('shows the followed session and stops on click', () => {
    const { setFollowedSessionId } = setup(
      [sess({ sessionId: 'a1', name: 'sam', device: 'Mac · Safari' })],
      'a1'
    );
    render(<FollowPill />);
    expect(screen.getByText('Following sam (Mac · Safari)')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
    expect(setFollowedSessionId).toHaveBeenCalledWith(null);
  });

  it('renders nothing when the followed session id has no live match', () => {
    setup([sess({ sessionId: 'a1', name: 'sam', device: 'Mac · Safari' })], 'gone');
    const { container } = render(<FollowPill />);
    expect(container.firstChild).toBeNull();
  });
});
