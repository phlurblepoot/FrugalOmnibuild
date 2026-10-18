// src/pages/project/billing/AiaSettingsForm.test.tsx
//
// Flipping the retainage mode re-derives retainage on EVERY existing pay
// application — finalized ones included — so the save is confirmed first.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { AiaSettingsForm } from './AiaSettingsForm';
import { ToastProvider } from '../../../components/Toast';
import { ConfirmProvider } from '../../../components/ConfirmDialog';
import type { AiaPayApp, AiaSettings, AiaSovLine } from '../../../utils/store';

const saveAiaSettings = vi.hoisted(() => vi.fn());
vi.mock('../../../utils/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../utils/store')>();
  return { ...actual, saveAiaSettings };
});

beforeEach(() => {
  saveAiaSettings.mockReset();
  saveAiaSettings.mockResolvedValue(undefined);
});

const sovLines: AiaSovLine[] = [
  { id: 'sov1', projectId: 'p1', itemNo: '1', description: 'Line 1', scheduledValueCents: 10000000, retainagePercent: null, isChangeOrder: 0, changeOrderId: null, sortOrder: 0, version: 1, createdAt: 0 },
];

const mkApp = (over: Partial<AiaPayApp> = {}): AiaPayApp => ({
  id: 'app1', projectId: 'p1', number: 1, periodTo: null, applicationDate: null,
  retainagePercent: 10, storedRetainagePercent: 10, releasedRetainagePoints: 0,
  status: 'finalized', version: 1, createdAt: 0, updatedAt: 0, ...over,
});

const settings: AiaSettings = { retainagePercent: 10, retainageMode: 'uniform' };

const renderForm = (payApps: AiaPayApp[], over: Partial<AiaSettings> = {}) =>
  render(
    <ToastProvider>
      <ConfirmProvider>
        <AiaSettingsForm
          projectId="p1"
          settings={{ ...settings, ...over }}
          sovLines={sovLines}
          payApps={payApps}
          onSaved={vi.fn()}
          defaultOpen
        />
      </ConfirmProvider>
    </ToastProvider>
  );

describe('AiaSettingsForm — retainage mode change', () => {
  it('confirms before a mode change that would recompute existing applications', async () => {
    renderForm([mkApp(), mkApp({ id: 'app2', number: 2, status: 'draft' })]);

    fireEvent.click(screen.getByRole('button', { name: 'Per-line rates' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await screen.findByText(/recalculates retainage on 2 existing application\(s\), including finalized ones/);
    expect(saveAiaSettings).not.toHaveBeenCalled();
  });

  it('cancelling the confirm abandons the save entirely', async () => {
    renderForm([mkApp()]);

    fireEvent.click(screen.getByRole('button', { name: 'Per-line rates' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));

    await waitFor(() => expect(screen.queryByText(/recalculates retainage/)).toBeNull());
    expect(saveAiaSettings).not.toHaveBeenCalled();
  });

  it('accepting the confirm saves the new mode', async () => {
    renderForm([mkApp()]);

    fireEvent.click(screen.getByRole('button', { name: 'Per-line rates' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Change mode' }));

    await waitFor(() => expect(saveAiaSettings).toHaveBeenCalledTimes(1));
    expect(saveAiaSettings.mock.calls[0][1]).toMatchObject({ retainageMode: 'perLine' });
  });

  it('saves straight through when there are no applications to recompute', async () => {
    renderForm([]);

    fireEvent.click(screen.getByRole('button', { name: 'Per-line rates' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(saveAiaSettings).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/recalculates retainage/)).toBeNull();
  });

  it('saves straight through when the mode is untouched, even with applications', async () => {
    renderForm([mkApp()]);

    // Edit an unrelated field; the mode toggle is left alone.
    fireEvent.change(screen.getByLabelText('Owner name'), { target: { value: 'Acme' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));

    await waitFor(() => expect(saveAiaSettings).toHaveBeenCalledTimes(1));
    expect(screen.queryByText(/recalculates retainage/)).toBeNull();
  });

  it('does not re-confirm a second save once the new mode is persisted', async () => {
    renderForm([mkApp()]);

    fireEvent.click(screen.getByRole('button', { name: 'Per-line rates' }));
    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Change mode' }));
    await waitFor(() => expect(saveAiaSettings).toHaveBeenCalledTimes(1));
    // Let the (animated) dialog finish leaving before asserting on the second.
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Change mode' })).toBeNull());

    fireEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(saveAiaSettings).toHaveBeenCalledTimes(2));
    expect(screen.queryByRole('button', { name: 'Change mode' })).toBeNull();
  });
});
