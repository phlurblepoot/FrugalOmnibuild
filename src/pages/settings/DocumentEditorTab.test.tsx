// src/pages/settings/DocumentEditorTab.test.tsx
//
// Settings → Document Editor is where an admin lands when the editor won't
// open, so the tests cover the states that matter then: not set up yet (which
// settings are missing), a failed check with its fix-it message, all three
// checks passing, and "Check again" really re-running.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const h = vi.hoisted(() => ({ getOnlyofficeStatus: vi.fn(), checkEditorScript: vi.fn() }));
vi.mock('../../utils/store', async (orig) => ({ ...(await orig<typeof import('../../utils/store')>()), getOnlyofficeStatus: h.getOnlyofficeStatus }));
vi.mock('../../utils/onlyofficeApi', () => ({ checkEditorScript: h.checkEditorScript }));
import { DocumentEditorTab } from './DocumentEditorTab';

const ok = (message: string) => ({ status: 'ok', message });
const configured = (over: Partial<any> = {}) => ({
  configured: true,
  problems: [],
  publicUrl: 'https://docs-test.example.com',
  internalUrl: 'http://onlyoffice',
  appInternalUrl: 'http://app:3000',
  version: '9.4.0.1',
  checks: { appToOnlyoffice: ok('Connected to ONLYOFFICE 9.4.0.1'), onlyofficeToApp: ok('ONLYOFFICE downloaded a test file') },
  ...over,
});

const rows = () => screen.getAllByTestId('oo-check');

beforeEach(() => {
  vi.clearAllMocks();
  h.checkEditorScript.mockResolvedValue(ok('Your browser loaded the editor'));
});

describe('DocumentEditorTab', () => {
  it('lists the missing settings and skips every check when ONLYOFFICE is not set up', async () => {
    h.getOnlyofficeStatus.mockResolvedValue({
      ...configured(), configured: false, publicUrl: null, internalUrl: null, appInternalUrl: null, version: null,
      problems: [{ variable: 'ONLYOFFICE_PUBLIC_URL', problem: 'Not set.' }, { variable: 'ONLYOFFICE_JWT_SECRET', problem: 'Not set.' }],
      checks: { appToOnlyoffice: { status: 'skipped', message: 'Finish the setup above first.' }, onlyofficeToApp: { status: 'skipped', message: 'Finish the setup above first.' } },
    });
    render(<DocumentEditorTab />);
    expect(await screen.findByText(/isn't set up yet/)).toBeInTheDocument();
    expect(screen.getByText('ONLYOFFICE_PUBLIC_URL')).toBeInTheDocument();
    expect(screen.getByText('ONLYOFFICE_JWT_SECRET')).toBeInTheDocument();
    await waitFor(() => expect(rows().every(r => within(r).queryByText('Skipped'))).toBe(true));
    expect(h.checkEditorScript).not.toHaveBeenCalled();
  });

  it('shows the addresses, the version and three working checks when everything connects', async () => {
    h.getOnlyofficeStatus.mockResolvedValue(configured());
    render(<DocumentEditorTab />);
    expect(await screen.findByText('https://docs-test.example.com')).toBeInTheDocument();
    expect(screen.getByText('http://onlyoffice')).toBeInTheDocument();
    expect(screen.getByText('http://app:3000')).toBeInTheDocument();
    expect(screen.getByText('9.4.0.1')).toBeInTheDocument();
    await waitFor(() => expect(rows().map(r => within(r).queryByText('Working') !== null)).toEqual([true, true, true]));
    expect(h.checkEditorScript).toHaveBeenCalledWith('https://docs-test.example.com');
  });

  it('shows a failed check with its fix-it message', async () => {
    h.getOnlyofficeStatus.mockResolvedValue(configured({
      checks: {
        appToOnlyoffice: ok('Connected'),
        onlyofficeToApp: { status: 'failed', message: 'Check APP_INTERNAL_URL, and ALLOW_PRIVATE_IP_ADDRESS=true.' },
      },
    }));
    render(<DocumentEditorTab />);
    const row = (await screen.findByText(/Check APP_INTERNAL_URL/)).closest('[data-testid="oo-check"]') as HTMLElement;
    expect(within(row).getByText('Problem')).toBeInTheDocument();
    expect(within(row).getByText('ONLYOFFICE can reach this app')).toBeInTheDocument();
  });

  it('says so when the checks themselves cannot run', async () => {
    h.getOnlyofficeStatus.mockRejectedValue(new Error('Admin access required'));
    render(<DocumentEditorTab />);
    expect(await screen.findByText(/Couldn't run the checks: Admin access required/)).toBeInTheDocument();
  });

  it('re-runs every check on "Check again"', async () => {
    h.getOnlyofficeStatus.mockResolvedValue(configured());
    render(<DocumentEditorTab />);
    const button = await screen.findByRole('button', { name: /check again/i });
    await waitFor(() => expect(button).not.toBeDisabled());
    fireEvent.click(button);
    await waitFor(() => expect(h.getOnlyofficeStatus).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(h.checkEditorScript).toHaveBeenCalledTimes(2));
  });
});
