// src/pages/documents/NewLienReleaseModal.test.tsx — Documents -> New -> Release of lien.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const h = vi.hoisted(() => ({
  getProjectsSummary: vi.fn(),
  getLienReleasePrefill: vi.fn(),
}));
vi.mock('../../utils/store', async (orig) => ({ ...(await orig<typeof import('../../utils/store')>()), ...h, getProject: vi.fn(async () => null) }));
vi.mock('../project/billing/LienReleaseEditor', async (orig) => ({
  ...(await orig<typeof import('../project/billing/LienReleaseEditor')>()),
  LienReleaseEditor: ({ release }: any) => <div data-testid="editor">{release.paymentType}|{String(release.conditional)}</div>,
}));

import { ToastProvider } from '../../components/Toast';
import { NewLienReleaseModal } from './NewLienReleaseModal';

const mount = (props: Partial<React.ComponentProps<typeof NewLienReleaseModal>> = {}) => {
  const onClose = vi.fn();
  render(<MemoryRouter><ToastProvider><NewLienReleaseModal open onClose={onClose} {...props} /></ToastProvider></MemoryRouter>);
  return { onClose };
};

beforeEach(() => {
  vi.clearAllMocks();
  h.getProjectsSummary.mockResolvedValue([
    { id: 'p1', name: 'Maple', archived: false }, { id: 'p2', name: 'Old', archived: true },
  ]);
  h.getLienReleasePrefill.mockResolvedValue({
    paymentType: 'final', conditional: false, sourceType: null, sourceId: null,
    lienorName: 'A', customerName: 'B', ownerName: 'C', propertyDescription: 'D', amountCents: 0,
    throughDate: null, releaseDate: '2026-10-15', signerName: 'N', signerTitle: '',
    conditionKind: null, checkMaker: '', exceptions: '', source: null, warnings: [],
  });
});

describe('NewLienReleaseModal', () => {
  it('needs a project, lists only live projects, and then opens the editor on the chosen variant', async () => {
    mount();
    const go = await screen.findByTestId('new-lien-release-create');
    expect((go as HTMLButtonElement).disabled).toBe(true);
    await waitFor(() => expect(screen.getByRole('option', { name: 'Maple' })).toBeTruthy());
    expect(screen.queryByRole('option', { name: 'Old' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Project'), { target: { value: 'p1' } });
    fireEvent.change(screen.getByLabelText('Release'), { target: { value: '3' } });
    fireEvent.click(go);
    await waitFor(() => expect(h.getLienReleasePrefill).toHaveBeenCalledWith('p1', { paymentType: 'final', conditional: false }));
    expect((await screen.findByTestId('editor')).textContent).toBe('final|false');
  });

  it('preselects the project it is opened inside', async () => {
    mount({ initialProjectId: 'p1' });
    await waitFor(() => expect((screen.getByLabelText('Project') as HTMLSelectElement).value).toBe('p1'));
    expect((screen.getByTestId('new-lien-release-create') as HTMLButtonElement).disabled).toBe(false);
  });
});
