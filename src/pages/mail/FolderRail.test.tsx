// src/pages/mail/FolderRail.test.tsx
import React from 'react';
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { FolderRail } from './FolderRail';
import type { MailAccount, MailFolder } from './types';

const account = (over: Partial<MailAccount> = {}): MailAccount => ({
  id: 'a1', provider: 'imap', emailAddress: 'noah@birchwoodplaster.example', displayName: 'Noah',
  signatureHtml: null, isDefault: 1, status: 'ok', lastSyncAt: null, lastError: null,
  indexedSince: '2026-02-01T00:00:00.000Z', unreadCount: 3, ...over,
});

const folder = (id: string, name: string, role: string | null, unreadCount = 0): MailFolder => ({
  id, accountId: 'a1', providerId: id, name, role, unreadCount, totalCount: 0, sortOrder: 0,
});

// Deliberately shuffled: the rail, not the server, owns the display order.
const FOLDERS: MailFolder[] = [
  folder('f-trash', 'Trash', 'trash'),
  folder('f-zeta', 'Zeta', null),
  folder('f-sent', '[Gmail]/Sent Mail', 'sent'),
  folder('f-inbox', 'INBOX', 'inbox', 4),
  folder('f-alpha', 'Alpha', null, 2),
  folder('f-drafts', 'Drafts', 'drafts', 1),
  folder('f-archive', 'All Mail', 'archive'),
  folder('f-spam', 'Spam', 'spam'),
  folder('f-starred', 'Starred', 'starred'),
];

const props = {
  accounts: [account()],
  accountId: 'a1',
  folders: FOLDERS,
  folderId: 'f-inbox',
  onSelectAccount: vi.fn(),
  onSelectFolder: vi.fn(),
  onCompose: vi.fn(),
};

const rowIds = () => screen.getAllByTestId('mail-folder-row').map(r => r.getAttribute('data-folder-id'));
const row = (id: string): HTMLElement =>
  screen.getAllByTestId('mail-folder-row').find(r => r.getAttribute('data-folder-id') === id)!;

describe('FolderRail', () => {
  it('orders the role folders by their mailbox meaning, not by the server order', () => {
    render(<FolderRail {...props} />);
    expect(rowIds().slice(0, 7)).toEqual([
      'f-inbox', 'f-starred', 'f-sent', 'f-drafts', 'f-archive', 'f-trash', 'f-spam',
    ]);
  });

  it('names role folders canonically instead of echoing provider paths', () => {
    render(<FolderRail {...props} />);
    const sent = row('f-sent');
    expect(within(sent).getByText('Sent')).toBeInTheDocument();
    expect(within(sent).queryByText('[Gmail]/Sent Mail')).toBeNull();
  });

  it('lists the remaining folders alphabetically under a Labels caption', () => {
    render(<FolderRail {...props} />);
    expect(screen.getByText('Labels')).toBeInTheDocument();
    expect(rowIds().slice(7)).toEqual(['f-alpha', 'f-zeta']);
  });

  it('shows an unread count only for folders that have one', () => {
    render(<FolderRail {...props} />);
    expect(within(row('f-inbox')).getByText('4')).toBeInTheDocument();
    expect(within(row('f-inbox')).getByLabelText('4 unread')).toBeInTheDocument();
    expect(within(row('f-alpha')).getByText('2')).toBeInTheDocument();
    expect(within(row('f-trash')).queryByText('0')).toBeNull();
  });

  it('marks the current folder as selected and reports folder clicks', () => {
    const onSelectFolder = vi.fn();
    render(<FolderRail {...props} onSelectFolder={onSelectFolder} />);
    expect(row('f-inbox')).toHaveAttribute('data-selected', 'true');
    fireEvent.click(row('f-alpha'));
    expect(onSelectFolder).toHaveBeenCalledWith('f-alpha');
  });

  it('hides the account picker for a single account and shows it for two', () => {
    const { rerender } = render(<FolderRail {...props} />);
    expect(screen.queryByLabelText('Mail account')).toBeNull();
    expect(screen.getByText('noah@birchwoodplaster.example')).toBeInTheDocument();

    const onSelectAccount = vi.fn();
    rerender(
      <FolderRail
        {...props}
        onSelectAccount={onSelectAccount}
        accounts={[account(), account({ id: 'a2', emailAddress: 'office@birchwoodplaster.example', isDefault: 0 })]}
      />,
    );
    const select = screen.getByLabelText('Mail account');
    fireEvent.change(select, { target: { value: 'a2' } });
    expect(onSelectAccount).toHaveBeenCalledWith('a2');
  });

  it('offers Compose', () => {
    const onCompose = vi.fn();
    render(<FolderRail {...props} onCompose={onCompose} />);
    fireEvent.click(screen.getByRole('button', { name: /compose/i }));
    expect(onCompose).toHaveBeenCalledTimes(1);
  });
});
