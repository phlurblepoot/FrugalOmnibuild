// src/pages/documents/VersionHistory.test.tsx — a document's earlier versions
// on the Documents page: who made each, restore as a new version, and delete
// for admins or the version's author only.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { ConfirmProvider } from '../../components/ConfirmDialog';
import { VersionHistory, versionFileName } from './VersionHistory';

const h = vi.hoisted(() => ({ toast: vi.fn() }));
vi.mock('../../components/Toast', () => ({ useToast: () => ({ toast: h.toast }) }));

vi.mock('../../utils/store', async (orig) => ({
  ...(await orig<typeof import('../../utils/store')>()),
  listFileVersions: vi.fn(),
  getAssignableUsers: vi.fn(async () => [{ id: 'u-noah', username: 'noah', role: 'admin' }, { id: 'u-crew', username: 'crew', role: 'user' }]),
  restoreFileVersion: vi.fn(async () => ({ versionNumber: 4, restoredFrom: 1 })),
  deleteFileVersion: vi.fn(async () => {}),
  fetchFileBlob: vi.fn(async () => new Blob(['x'])),
}));
vi.mock('../../utils/download', () => ({ downloadBlob: vi.fn() }));

import { RestoreError, deleteFileVersion, listFileVersions, restoreFileVersion } from '../../utils/store';
import { downloadBlob } from '../../utils/download';

const version = (n: number, over: Record<string, unknown> = {}) => ({
  id: n === 3 ? 'doc1' : `v${n}`, projectId: 'p1', name: 'Scope.docx', mime: 'x', size: 1, kind: 'document',
  parentFileId: n === 3 ? null : 'doc1', versionNumber: n, createdAt: 1_000 * n, createdBy: null, versionOrigin: null, ...over,
});
const VERSIONS = [
  version(3, { createdBy: 'u-crew' }),
  version(2, { createdBy: 'u-crew', versionOrigin: 'editor' }),
  version(1, { createdBy: 'u-noah' }),
];

const renderHistory = () => render(<ConfirmProvider><VersionHistory fileId="doc1" fileName="Scope.docx" /></ConfirmProvider>);
const rowFor = async (n: number) => (await screen.findAllByTestId('version-row')).find(r => r.textContent!.startsWith(`v${n}`))!;
const signIn = (user: Record<string, unknown>) => localStorage.setItem('user', JSON.stringify(user));

beforeEach(() => {
  vi.clearAllMocks();
  (listFileVersions as any).mockResolvedValue(VERSIONS);
  signIn({ id: 'u-crew', username: 'crew', role: 'user' });
});

describe('VersionHistory', () => {
  it('lists the earlier versions with who made them and how', async () => {
    renderHistory();
    const v2 = await rowFor(2);
    await waitFor(() => expect(v2).toHaveTextContent('by crew'));
    expect(v2).toHaveTextContent('edited');
    expect(await rowFor(1)).toHaveTextContent('by noah');
    expect(screen.getAllByTestId('version-row')).toHaveLength(2); // the current version isn't listed
  });

  it('offers delete only on versions this person made, unless they are an admin', async () => {
    renderHistory();
    expect(within(await rowFor(2)).getByRole('button', { name: 'Delete version 2' })).toBeInTheDocument();
    expect(within(await rowFor(1)).queryByRole('button', { name: 'Delete version 1' })).toBeNull();
  });

  it('lets an admin delete any version', async () => {
    signIn({ id: 'u-noah', role: 'admin' });
    renderHistory();
    expect(within(await rowFor(2)).getByRole('button', { name: 'Delete version 2' })).toBeInTheDocument();
    expect(within(await rowFor(1)).getByRole('button', { name: 'Delete version 1' })).toBeInTheDocument();
  });

  it('deletes after a confirm, then reloads the list', async () => {
    renderHistory();
    fireEvent.click(within(await rowFor(2)).getByRole('button', { name: 'Delete version 2' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Delete version 2?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deleteFileVersion).toHaveBeenCalledWith('doc1', 'v2'));
    await waitFor(() => expect(listFileVersions).toHaveBeenCalledTimes(2));
  });

  it('restores as a new version after a confirm that says so', async () => {
    renderHistory();
    fireEvent.click(within(await rowFor(1)).getByRole('button', { name: /restore/ }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('becomes the current version of "Scope.docx" (version 4)');
    expect(dialog).toHaveTextContent('The current version 3 stays in the history');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(restoreFileVersion).toHaveBeenCalledWith('doc1', { versionId: 'v1' }, 'documents'));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith('Version 1 restored as version 4', { type: 'success' }));
  });

  it('says who has the file open when a restore has to wait', async () => {
    (restoreFileVersion as any).mockRejectedValueOnce(
      new RestoreError('crew is editing this file. Restore once the editor is closed.', 409, 'open-in-editor', ['crew']),
    );
    renderHistory();
    fireEvent.click(within(await rowFor(1)).getByRole('button', { name: /restore/ }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Restore' }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith('crew is editing this file. Restore once the editor is closed.', { type: 'error' }));
  });

  it('downloads a version under a name that keeps its extension', async () => {
    renderHistory();
    fireEvent.click(within(await rowFor(1)).getByRole('button', { name: /download/ }));
    await waitFor(() => expect(downloadBlob).toHaveBeenCalledWith(expect.any(Blob), 'Scope (v1).docx'));
    expect(versionFileName('README', 2)).toBe('README (v2)');
  });
});
