// src/components/FileViewerDots.test.tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import React from 'react';
import type { SessionView } from '../context/CollaborationContext';
import { FileViewerDots } from './FileViewerDots';

const mockCollab = vi.hoisted(() => vi.fn());
vi.mock('../context/CollaborationContext', () => ({
  useCollaboration: () => mockCollab(),
}));

const sess = (over: Partial<SessionView>): SessionView => ({
  sessionId: 's1', userId: 'u1', name: 'noah', role: 'admin', color: '#3b82f6',
  device: 'Windows · Chrome', location: null, editing: null, cursor: null, lastActive: 1,
  ...over,
});

const setup = (sessions: SessionView[], mySessionId: string | null) => {
  mockCollab.mockReturnValue({ sessions, mySessionId });
};

describe('FileViewerDots', () => {
  it('renders nothing when no other session is viewing the file', () => {
    setup(
      [sess({ sessionId: 'a1', name: 'sam', location: { path: '/other', fileId: 'file-2' } })],
      'me'
    );
    const { container } = render(<FileViewerDots fileId="file-1" />);
    expect(container.firstChild).toBeNull();
  });

  it('renders a dot for each other session viewing the file, with initial and title', () => {
    setup(
      [
        sess({ sessionId: 'a1', name: 'sam', color: '#ef4444', device: 'Mac · Safari', location: { path: '/x', fileId: 'file-1' } }),
        sess({ sessionId: 'a2', name: 'liz', color: '#10b981', device: 'iPad · Safari', location: { path: '/y', fileId: 'file-1' } }),
      ],
      'me'
    );
    render(<FileViewerDots fileId="file-1" />);

    const sam = screen.getByTitle('sam · Mac · Safari');
    expect(sam).toHaveTextContent('S');
    expect(sam).toHaveStyle({ backgroundColor: '#ef4444' });

    const liz = screen.getByTitle('liz · iPad · Safari');
    expect(liz).toHaveTextContent('L');
    expect(liz).toHaveStyle({ backgroundColor: '#10b981' });
  });

  it('excludes my own session even if it matches the file', () => {
    setup(
      [sess({ sessionId: 'me', name: 'noah', location: { path: '/x', fileId: 'file-1' } })],
      'me'
    );
    const { container } = render(<FileViewerDots fileId="file-1" />);
    expect(container.firstChild).toBeNull();
  });

  it('excludes sessions viewing a different file', () => {
    setup(
      [sess({ sessionId: 'a1', name: 'sam', location: { path: '/x', fileId: 'file-2' } })],
      'me'
    );
    const { container } = render(<FileViewerDots fileId="file-1" />);
    expect(container.firstChild).toBeNull();
  });

  it('caps at 3 dots when more than 3 other sessions are viewing the file', () => {
    setup(
      [
        sess({ sessionId: 'a1', name: 'ann', location: { path: '/x', fileId: 'file-1' } }),
        sess({ sessionId: 'a2', name: 'bob', location: { path: '/x', fileId: 'file-1' } }),
        sess({ sessionId: 'a3', name: 'cal', location: { path: '/x', fileId: 'file-1' } }),
        sess({ sessionId: 'a4', name: 'dee', location: { path: '/x', fileId: 'file-1' } }),
      ],
      'me'
    );
    const { container } = render(<FileViewerDots fileId="file-1" />);
    expect(container.querySelectorAll('[title]').length).toBe(3);
  });
});
