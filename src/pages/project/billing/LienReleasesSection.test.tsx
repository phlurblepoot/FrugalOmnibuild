// src/pages/project/billing/LienReleasesSection.test.tsx
// The Lien Releases tab and the launcher buttons that start a release.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { LienRelease } from '../../../utils/store';

const h = vi.hoisted(() => ({
  getLienReleases: vi.fn(),
  getLienRelease: vi.fn(),
  getLienReleasePrefill: vi.fn(),
  deleteLienRelease: vi.fn(),
  getPayApps: vi.fn(),
  getInvoices: vi.fn(),
  getDocumentsBySource: vi.fn(),
}));

vi.mock('../../../context/CollaborationContext', () => ({
  useCollaboration: () => ({ socket: null, sessions: [], mySessionId: 'me' }),
}));
vi.mock('../../../utils/store', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../utils/store')>()),
  ...h,
  getProject: vi.fn(async () => ({ name: 'Maple House' })),
  getDocumentTypes: vi.fn(async () => []),
}));
vi.mock('../../../pages/documents/DocumentViewerModal', () => ({ DocumentViewerModal: () => <div /> }));

// The editor is covered by its own test; here it just reports what it was given.
vi.mock('./LienReleaseEditor', async (orig) => ({
  ...(await orig<typeof import('./LienReleaseEditor')>()),
  LienReleaseEditor: ({ release, initialSource }: any) => (
    <div data-testid="editor">{release.id || 'new'}|{release.paymentType}|{String(release.conditional)}|{release.amountCents}|{initialSource?.label ?? ''}</div>
  ),
}));

import { ToastProvider } from '../../../components/Toast';
import { LienReleasesSection } from './LienReleasesSection';
import { LienReleaseLauncher } from './LienReleaseLauncher';

const rel = (over: Partial<LienRelease> = {}): LienRelease => ({
  id: 'lr1', projectId: 'p1', number: '1', paymentType: 'progress', conditional: true,
  sourceType: 'payapp', sourceId: 'pa1', supersedesId: null,
  lienorName: 'A', customerName: 'B', ownerName: 'C', propertyDescription: 'D', amountCents: 250000,
  throughDate: '2026-09-30', releaseDate: '2026-10-15', signerName: 'N', signerTitle: null,
  conditionKind: 'funds', checkNumber: null, checkMaker: null, checkBank: null,
  exceptions: null, signatureFileId: null, status: 'draft', version: 1, createdAt: 1, updatedAt: 2,
  ...over,
});

const prefill = (over: any = {}) => ({
  paymentType: 'progress', conditional: true, sourceType: null, sourceId: null,
  lienorName: 'A', customerName: 'B', ownerName: 'C', propertyDescription: 'D', amountCents: 9900,
  throughDate: '2026-10-01', releaseDate: '2026-10-15', signerName: 'N', signerTitle: '',
  conditionKind: 'funds', checkMaker: 'B', exceptions: '', source: { label: 'Pay App #2', totalCents: 1, paidCents: 0, balanceCents: 1 }, warnings: [],
  ...over,
});

const wrap = (ui: React.ReactElement) => render(<MemoryRouter><ToastProvider>{ui}</ToastProvider></MemoryRouter>);

beforeEach(() => {
  vi.clearAllMocks();
  h.getLienReleases.mockResolvedValue([
    rel(),
    rel({ id: 'lr2', number: '2', conditional: false, paymentType: 'final', throughDate: null, status: 'sent', sourceType: 'invoice', sourceId: 'i1' }),
  ]);
  h.getPayApps.mockResolvedValue([{ id: 'pa1', number: 2 }]);
  h.getInvoices.mockResolvedValue([{ id: 'i1', number: '1005' }]);
  h.getDocumentsBySource.mockResolvedValue({});
  h.getLienRelease.mockImplementation(async (id: string) => rel({ id }));
  h.getLienReleasePrefill.mockResolvedValue(prefill());
  h.deleteLienRelease.mockResolvedValue(undefined);
});

describe('LienReleasesSection', () => {
  it('lists releases with variant, amount, status and the pay app or invoice they came from', async () => {
    wrap(<LienReleasesSection projectId="p1" />);
    expect(await screen.findByText('LR-1')).toBeTruthy();
    const row1 = screen.getByText('LR-1').closest('tr')!;
    expect(row1.textContent).toContain('Conditional progress');
    expect(row1.textContent).toContain('2,500.00');
    expect(row1.textContent).toContain('Pay App #2');
    expect(row1.textContent).toContain('Draft');
    const row2 = screen.getByText('LR-2').closest('tr')!;
    expect(row2.textContent).toContain('Unconditional final');
    expect(row2.textContent).toContain('Invoice 1005');
    expect(row2.textContent).toContain('Sent');
  });

  it('offers delete on drafts only', async () => {
    wrap(<LienReleasesSection projectId="p1" />);
    await screen.findByText('LR-1');
    expect(within(screen.getByText('LR-1').closest('tr')!).queryByLabelText('Delete draft')).toBeTruthy();
    expect(within(screen.getByText('LR-2').closest('tr')!).queryByLabelText('Delete draft')).toBeNull();
  });

  it('opens a release in the editor when its row is clicked', async () => {
    wrap(<LienReleasesSection projectId="p1" />);
    fireEvent.click((await screen.findByText('LR-1')).closest('tr')!);
    expect((await screen.findByTestId('editor')).textContent).toContain('lr1|progress|true');
  });

  it('New release opens the four-variant menu and starts an unsaved draft of the chosen variant', async () => {
    wrap(<LienReleasesSection projectId="p1" />);
    fireEvent.click(await screen.findByTestId('lien-new-release'));
    expect(screen.getAllByRole('menuitem').map(b => b.textContent)).toEqual([
      'Conditional, progress payment', 'Unconditional, progress payment',
      'Conditional, final payment', 'Unconditional, final payment',
    ]);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Unconditional, final payment' }));
    await waitFor(() => expect(h.getLienReleasePrefill).toHaveBeenCalledWith('p1', { paymentType: 'final', conditional: false }));
    expect((await screen.findByTestId('editor')).textContent).toContain('new|progress|true');
  });
});

describe('LienReleaseLauncher', () => {
  it('starts from a pay app with its source in the prefill query', async () => {
    wrap(<LienReleaseLauncher projectId="p1" source={{ sourceType: 'payapp', sourceId: 'pa1' }} />);
    fireEvent.click(screen.getByTestId('lien-release-launcher'));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Conditional, progress payment' }));
    await waitFor(() => expect(h.getLienReleasePrefill).toHaveBeenCalledWith('p1', {
      sourceType: 'payapp', sourceId: 'pa1', paymentType: 'progress', conditional: true,
    }));
    expect((await screen.findByTestId('editor')).textContent).toContain('Pay App #2');
  });

  it('a payment starts one unconditional release directly, from the payment', async () => {
    wrap(
      <LienReleaseLauncher
        projectId="p1" paymentId="pay1" label="Unconditional release for this payment"
        variant={{ paymentType: 'progress', conditional: false }}
      />,
    );
    fireEvent.click(screen.getByRole('button', { name: /Unconditional release for this payment/ }));
    await waitFor(() => expect(h.getLienReleasePrefill).toHaveBeenCalledWith('p1', {
      paymentId: 'pay1', paymentType: 'progress', conditional: false,
    }));
    expect(await screen.findByTestId('editor')).toBeTruthy();
    expect(screen.queryByRole('menu')).toBeNull();
  });
});
