// src/pages/Settings.test.tsx
//
// Covers only what Settings itself owns around the Mail tab: the OAuth callback
// lands the browser back on `/settings?tab=mail&connected=…` (or `&error=…`,
// see server/mail/routes.ts), so the page has to open that tab, say what
// happened, and then clear those params — a reload must not re-toast, and an
// error message must never linger in the URL bar.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

const h = vi.hoisted(() => ({ toast: vi.fn(), getSettings: vi.fn() }));
vi.mock('../utils/store', async orig => ({
  ...(await orig<typeof import('../utils/store')>()),
  getSettings: h.getSettings,
}));
vi.mock('../components/Toast', async orig => ({
  ...(await orig<typeof import('../components/Toast')>()),
  useToast: () => ({ toast: h.toast }),
}));
// PreferencesTab (the default tab) polls the local AI status on mount; stub it
// so an unrelated tab does not put the network in the middle of these tests.
vi.mock('../utils/aiSheets', () => ({
  getAiStatus: vi.fn().mockResolvedValue({ state: 'idle' }),
  aiAutoNameEnabled: () => false,
  setAiAutoNameEnabled: vi.fn(),
}));
// The tab's own behaviour is covered by MailAccountsTab.test.tsx.
vi.mock('./settings/MailAccountsTab', () => ({
  MailAccountsTab: ({ isAdmin }: { isAdmin?: boolean }) => (
    <div data-testid="mail-tab">{String(!!isAdmin)}</div>
  ),
}));

import { Settings } from './Settings';

const Probe: React.FC = () => {
  const loc = useLocation();
  return <span data-testid="loc">{`${loc.pathname}${loc.search}`}</span>;
};

const mount = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes><Route path="/settings" element={<Settings />} /></Routes>
      <Probe />
    </MemoryRouter>
  );

beforeEach(() => {
  h.toast.mockReset();
  h.getSettings.mockReset().mockResolvedValue({});
  localStorage.clear();
});

describe('Settings — Mail tab entry points', () => {
  it('opens the Mail tab from ?tab=mail', async () => {
    mount('/settings?tab=mail');
    expect(await screen.findByTestId('mail-tab')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mail' })).toBeInTheDocument();
    // The old Email tab is gone.
    expect(screen.queryByRole('button', { name: 'Email' })).not.toBeInTheDocument();
  });

  it('tells the user a mailbox connected and strips the param', async () => {
    mount('/settings?tab=mail&connected=acct-1');
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith('Mail account connected', { type: 'success' }));
    await waitFor(() => expect(screen.getByTestId('loc')).toHaveTextContent('/settings?tab=mail'));
    expect(screen.getByTestId('loc')).not.toHaveTextContent('connected');
  });

  it('surfaces the callback error and strips it from the URL', async () => {
    mount('/settings?tab=mail&error=APP_PUBLIC_URL%20is%20not%20set%20on%20this%20server');
    await waitFor(() => expect(h.toast)
      .toHaveBeenCalledWith('APP_PUBLIC_URL is not set on this server', { type: 'error' }));
    await waitFor(() => expect(screen.getByTestId('loc')).not.toHaveTextContent('error'));
  });

  it('passes admin down to the Mail tab', async () => {
    localStorage.setItem('user', JSON.stringify({ role: 'admin' }));
    mount('/settings?tab=mail');
    expect(await screen.findByTestId('mail-tab')).toHaveTextContent('true');
  });

  it('ignores an unknown tab and toasts nothing', async () => {
    mount('/settings?tab=nope');
    await waitFor(() => expect(h.getSettings).toHaveBeenCalled());
    expect(screen.queryByTestId('mail-tab')).not.toBeInTheDocument();
    expect(h.toast).not.toHaveBeenCalled();
  });
});
