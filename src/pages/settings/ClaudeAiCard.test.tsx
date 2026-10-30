// src/pages/settings/ClaudeAiCard.test.tsx
//
// The Claude card: an admin connects with a subscription token or an API key,
// sees "Connected" with only the last 4, tests, disconnects (with a confirm)
// and picks a model; the API-key path shows the per-sheet cost. Non-admins see
// the status and their own switch but no connection controls.
import React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

const MODELS = [
  { id: 'claude-opus-5-5', label: 'Opus 5.5', centsPerSheet: 7 },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5', centsPerSheet: 3.5 },
  { id: 'claude-haiku-5-5', label: 'Haiku 5.5', centsPerSheet: 0.2 },
];
const off = { connected: false, source: null, last4: null, connectedAt: null, model: 'claude-opus-5-5', models: MODELS };
const on = { ...off, connected: true, source: 'token', last4: 'WXYZ', connectedAt: '2026-10-29T00:00:00Z' };

const h = vi.hoisted(() => ({
  getAiStatus: vi.fn(),
  api: { get: vi.fn(), connect: vi.fn(), disconnect: vi.fn(), setModel: vi.fn(), test: vi.fn() },
  toast: vi.fn(),
  confirm: vi.fn(),
}));
vi.mock('../../utils/aiSheets', () => ({
  getAiStatus: h.getAiStatus,
  aiAutoNameEnabled: () => true,
  setAiAutoNameEnabled: vi.fn(),
  claudeApi: h.api,
}));
vi.mock('../../components/Toast', async orig => ({
  ...(await orig<typeof import('../../components/Toast')>()),
  useToast: () => ({ toast: h.toast }),
}));
vi.mock('../../components/ConfirmDialog', async orig => ({
  ...(await orig<typeof import('../../components/ConfirmDialog')>()),
  useConfirm: () => h.confirm,
}));

import { ClaudeAiCard } from './ClaudeAiCard';

beforeEach(() => {
  Object.values(h.api).forEach(f => f.mockReset());
  h.toast.mockReset();
  h.confirm.mockReset();
  h.getAiStatus.mockReset().mockResolvedValue({ available: false, model: 'claude-opus-5-5', device: 'none', state: 'off' });
});

describe('ClaudeAiCard', () => {
  it('says that page images are sent to Anthropic', async () => {
    h.api.get.mockResolvedValue(off);
    render(<ClaudeAiCard isAdmin />);
    expect(await screen.findByText(/sent to Anthropic/)).toBeInTheDocument();
  });

  it('non-admins get no connection controls and never ask for the connection', async () => {
    render(<ClaudeAiCard isAdmin={false} />);
    expect(await screen.findByText(/An admin can connect it here/)).toBeInTheDocument();
    expect(screen.queryByText('Claude connection')).toBeNull();
    expect(h.api.get).not.toHaveBeenCalled();
    expect(screen.getByRole('switch')).toBeDisabled();
  });

  it('connects with a setup-token, then shows Connected with only the last 4', async () => {
    h.api.get.mockResolvedValue(off);
    h.api.connect.mockResolvedValue(on);
    render(<ClaudeAiCard isAdmin />);
    expect(await screen.findByText('Not connected')).toBeInTheDocument();
    expect(screen.getByText('claude setup-token', { selector: 'code' })).toBeInTheDocument();
    expect(screen.getByText(/plan’s usage limits/)).toBeInTheDocument();
    expect(screen.getByText(/for your own private install; for anything shared more widely, use an API key/)).toBeInTheDocument();
    const input = screen.getByLabelText('Claude Code token');
    expect(input).toHaveAttribute('type', 'password');
    fireEvent.change(input, { target: { value: 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyzWXYZ' } });
    h.getAiStatus.mockResolvedValue({ available: true, model: 'claude-opus-5-5', device: 'cloud', state: 'ready' });
    fireEvent.click(screen.getByRole('button', { name: /Connect/ }));
    await waitFor(() => expect(h.api.connect).toHaveBeenCalledWith('token', 'sk-ant-oat01-abcdefghijklmnopqrstuvwxyzWXYZ'));
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    expect(screen.getByTestId('claude-connection-detail')).toHaveTextContent('Claude subscription · ending in WXYZ');
    expect(screen.queryByDisplayValue(/sk-ant/)).toBeNull();
  });

  it('the API-key option shows the rough cost per sheet', async () => {
    h.api.get.mockResolvedValue(off);
    render(<ClaudeAiCard isAdmin />);
    fireEvent.click(await screen.findByRole('radio', { name: 'API key' }));
    expect(screen.getByLabelText('API key')).toBeInTheDocument();
    expect(screen.getByText(/7¢ on Opus, 3.5¢ on Sonnet, 0.2¢ on Haiku/)).toBeInTheDocument();
    expect(screen.getByText(/Use this for anything shared more widely/)).toBeInTheDocument();
  });

  it('shows a server-side rejection of the paste', async () => {
    h.api.get.mockResolvedValue(off);
    h.api.connect.mockRejectedValue(new Error('That is too short to be a token or key.'));
    render(<ClaudeAiCard isAdmin />);
    fireEvent.change(await screen.findByLabelText('Claude Code token'), { target: { value: 'nope' } });
    fireEvent.click(screen.getByRole('button', { name: /Connect/ }));
    await waitFor(() => expect(h.toast).toHaveBeenCalledWith('That is too short to be a token or key.', { type: 'error' }));
  });

  it('tests the connection and shows the answer or the reason', async () => {
    h.api.get.mockResolvedValue(on);
    h.api.test.mockResolvedValueOnce({ ok: true, model: 'claude-opus-5-5' })
      .mockResolvedValueOnce({ ok: false, code: 'rate_limit', error: 'Claude usage or rate limit reached.' });
    render(<ClaudeAiCard isAdmin />);
    fireEvent.click(await screen.findByRole('button', { name: /Test connection/ }));
    expect(await screen.findByText('Claude answered (Opus 5.5).')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Test connection/ }));
    expect(await screen.findByText('Claude usage or rate limit reached.')).toBeInTheDocument();
  });

  it('disconnects only after a confirm', async () => {
    h.api.get.mockResolvedValue(on);
    h.api.disconnect.mockResolvedValue(off);
    h.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(<ClaudeAiCard isAdmin />);
    fireEvent.click(await screen.findByRole('button', { name: /Disconnect/ }));
    await waitFor(() => expect(h.confirm).toHaveBeenCalledTimes(1));
    expect(h.api.disconnect).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: /Disconnect/ }));
    await waitFor(() => expect(h.api.disconnect).toHaveBeenCalled());
    expect(await screen.findByText('Not connected')).toBeInTheDocument();
  });

  it('a container-env credential has no Disconnect button and says where it comes from', async () => {
    h.api.get.mockResolvedValue({ ...on, source: 'env', last4: 'ABCD' });
    render(<ClaudeAiCard isAdmin />);
    expect(await screen.findByText(/Set on the container/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Disconnect/ })).toBeNull();
  });

  it('changes the model', async () => {
    h.api.get.mockResolvedValue(on);
    h.api.setModel.mockResolvedValue({ ...on, model: 'claude-haiku-5-5' });
    render(<ClaudeAiCard isAdmin />);
    fireEvent.change(await screen.findByLabelText('Model'), { target: { value: 'claude-haiku-5-5' } });
    await waitFor(() => expect(h.api.setModel).toHaveBeenCalledWith('claude-haiku-5-5'));
    await waitFor(() => expect(screen.getByLabelText('Model')).toHaveValue('claude-haiku-5-5'));
  });

  it('shows why the last read failed', async () => {
    h.getAiStatus.mockResolvedValue({ available: true, model: 'claude-opus-5-5', device: 'cloud', state: 'ready', lastError: { code: 'auth', message: 'Claude sign-in failed.', at: '' } });
    h.api.get.mockResolvedValue(on);
    render(<ClaudeAiCard isAdmin />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Last AI read failed: Claude sign-in failed.');
  });
});
