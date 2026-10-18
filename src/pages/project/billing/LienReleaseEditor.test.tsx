// src/pages/project/billing/LienReleaseEditor.test.tsx
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { LienRelease } from '../../../utils/store';

const h = vi.hoisted(() => ({
  saveLienRelease: vi.fn(),
  createLienRelease: vi.fn(),
  getLienRelease: vi.fn(),
  getLienReleasePrefill: vi.fn(),
  setLienReleaseStatus: vi.fn(),
  makeLienReleaseUnconditional: vi.fn(),
  listSignatures: vi.fn(),
}));

vi.mock('../../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: null, sessions: [], mySessionId: 'me' }),
}));
vi.mock('../../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/store')>()),
  ...h,
  getSettings: vi.fn(async () => ({})),
  getMailAccounts: vi.fn(async () => []),
  getAlwaysCc: vi.fn(async () => ''),
  getProject: vi.fn(async () => null),
  getCustomer: vi.fn(async () => undefined),
  getDocumentTypes: vi.fn(async () => []),
  getDocumentsBySource: vi.fn(async () => ({})),
  getDocumentBySource: vi.fn(async () => null),
  fetchFileBlob: vi.fn(async () => new Blob(['x'])),
}));
vi.mock('../../../pages/documents/DocumentViewerModal', () => ({ DocumentViewerModal: () => <div /> }));

import { ToastProvider } from '../../../components/Toast';
import { LienReleaseEditor, draftFromPrefill } from './LienReleaseEditor';

const stored = (over: Partial<LienRelease> = {}): LienRelease => ({
  id: 'lr1', projectId: 'p1', number: '3', paymentType: 'progress', conditional: true,
  sourceType: null, sourceId: null, supersedesId: null,
  lienorName: 'Birchwood Plaster', customerName: 'Acme GC', ownerName: 'Jane Owner',
  propertyDescription: 'Maple House\n1 Main St', amountCents: 123456,
  throughDate: '2026-10-01', releaseDate: '2026-10-15', signerName: 'Noah', signerTitle: 'Owner',
  conditionKind: 'funds', checkNumber: null, checkMaker: 'Acme GC', checkBank: null,
  exceptions: null, signatureFileId: null, status: 'draft', version: 4, createdAt: 1, updatedAt: 10,
  ...over,
});

const mount = (release: LienRelease) => {
  const fns = { onClose: vi.fn(), onSaved: vi.fn(), onCreated: vi.fn(), onOpenOther: vi.fn() };
  render(
    <MemoryRouter>
      <ToastProvider>
        <LienReleaseEditor release={release} projectId="p1" projectName="Maple House" {...fns} />
      </ToastProvider>
    </MemoryRouter>,
  );
  return fns;
};

beforeEach(() => {
  vi.clearAllMocks();
  h.saveLienRelease.mockResolvedValue({ version: 5 });
  h.createLienRelease.mockResolvedValue({ id: 'new-1', number: '4', version: 1 });
  h.makeLienReleaseUnconditional.mockResolvedValue({ id: 'lr2', number: '4', version: 1 });
  h.setLienReleaseStatus.mockResolvedValue(undefined);
  h.getLienReleasePrefill.mockResolvedValue({ source: null });
  h.listSignatures.mockResolvedValue([]);
});

describe('LienReleaseEditor', () => {
  it('shows the release and its live preview, with no unconditional warning on a conditional release', async () => {
    mount(stored());
    expect(await screen.findByText('Release of lien LR-3')).toBeTruthy();
    expect(screen.getByTestId('lien-preview').textContent).toContain('CONDITIONAL WAIVER AND RELEASE OF LIEN');
    expect(screen.getByTestId('lien-preview').textContent).toContain('1,234.56');
    expect(screen.queryByTestId('lien-unconditional-warning')).toBeNull();
    expect(screen.getByTestId('lien-condition-box')).toBeTruthy();
  });

  it('switching to unconditional shows the warning and hides the condition box', async () => {
    mount(stored());
    fireEvent.click(await screen.findByRole('button', { name: 'Unconditional' }));
    expect(screen.getByTestId('lien-unconditional-warning').textContent).toContain('paid or not');
    expect(screen.queryByTestId('lien-condition-box')).toBeNull();
    expect(screen.getByTestId('lien-preview').textContent).not.toContain('CONDITIONAL');
  });

  it('hides the through date on a final release', async () => {
    mount(stored());
    expect(await screen.findByLabelText('Through date')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Final' }));
    expect(screen.queryByLabelText('Through date')).toBeNull();
  });

  it('saves with the loaded version and the check wording when a check number is typed', async () => {
    const { onSaved } = mount(stored());
    fireEvent.change(await screen.findByLabelText('Check number'), { target: { value: '1042' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save release' }));
    await waitFor(() => expect(h.saveLienRelease).toHaveBeenCalled());
    const [id, body] = h.saveLienRelease.mock.calls[0];
    expect(id).toBe('lr1');
    expect(body).toMatchObject({ version: 4, conditional: true, conditionKind: 'check', checkNumber: '1042', checkMaker: 'Acme GC', amountCents: 123456 });
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });

  it('creates an unsaved draft on Save and reports the new id', async () => {
    const draft = draftFromPrefill('p1', {
      paymentType: 'final', conditional: false, sourceType: null, sourceId: null,
      lienorName: 'Birchwood Plaster', customerName: 'Acme GC', ownerName: 'Jane Owner', propertyDescription: 'Maple House',
      amountCents: 5000, throughDate: null, releaseDate: '2026-10-15', signerName: 'Noah', signerTitle: '',
      conditionKind: null, checkMaker: '', exceptions: '', source: null, warnings: [],
    });
    const { onCreated } = mount(draft);
    expect(await screen.findByText('New release of lien')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Save release' }));
    await waitFor(() => expect(h.createLienRelease).toHaveBeenCalled());
    expect(h.createLienRelease.mock.calls[0][0]).toBe('p1');
    expect(h.createLienRelease.mock.calls[0][1]).toMatchObject({ paymentType: 'final', conditional: false, throughDate: null, amountCents: 5000 });
    await waitFor(() => expect(onCreated).toHaveBeenCalledWith('new-1'));
  });

  it('Make unconditional creates the new release and opens it', async () => {
    const { onOpenOther } = mount(stored());
    fireEvent.click(await screen.findByRole('button', { name: 'Make unconditional' }));
    await waitFor(() => expect(onOpenOther).toHaveBeenCalledWith('lr2'));
    expect(h.makeLienReleaseUnconditional).toHaveBeenCalledWith('lr1');
  });

  it('offers Make unconditional only on a conditional release', async () => {
    mount(stored({ conditional: false, conditionKind: null }));
    await screen.findByText('Release of lien LR-3');
    expect(screen.queryByRole('button', { name: 'Make unconditional' })).toBeNull();
  });

  it('offers the signature checkbox only when the user has one, off by default', async () => {
    h.listSignatures.mockResolvedValue([{ id: 'sig1', name: 'Mine', isDefault: true }]);
    mount(stored());
    const box = await screen.findByLabelText('Sign with my signature') as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    fireEvent.click(screen.getByRole('button', { name: 'Save release' }));
    await waitFor(() => expect(h.saveLienRelease).toHaveBeenCalled());
    expect(h.saveLienRelease.mock.calls[0][1].signatureFileId).toBe('sig1');
  });

  it('voids a sent release and offers to restore a void one', async () => {
    const { onSaved } = mount(stored({ status: 'void' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restore to draft' }));
    await waitFor(() => expect(h.setLienReleaseStatus).toHaveBeenCalledWith('lr1', 'draft'));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
  });
});
