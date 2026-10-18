// src/pages/mail/MailSetupGuide.test.tsx
//
// The guide's whole job is to show an admin the values THIS deployment
// resolved — a redirect URI typed from memory into a provider console is the
// most common way a connect flow fails — so the tests pin that the URIs come
// from setup-info rather than from a template, that an unset env var is
// visibly unset, and that the copy button disappears (leaving selectable text)
// where navigator.clipboard does not exist: the owner runs this over plain HTTP
// on the LAN, where it does not.
import React from 'react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { SetupInfo } from './types';

const h = vi.hoisted(() => ({ setupInfo: vi.fn(), toast: vi.fn() }));
vi.mock('../../utils/mailApi', () => ({ mailApi: h }));
vi.mock('../../components/Toast', async orig => ({
  ...(await orig<typeof import('../../components/Toast')>()),
  useToast: () => ({ toast: h.toast }),
}));

import { MailSetupGuide } from './MailSetupGuide';

const INFO: SetupInfo = {
  publicUrl: 'https://takeoff.example.com',
  google: {
    configured: true,
    redirectUri: 'https://takeoff.example.com/api/mail/oauth/google/callback',
    pubsub: {
      configured: true,
      topic: 'projects/ft/topics/mail',
      webhookUrl: 'https://takeoff.example.com/api/mail/google/webhook?token=s3cr3t',
    },
  },
  microsoft: {
    configured: false,
    redirectUri: 'https://takeoff.example.com/api/mail/oauth/microsoft/callback',
    webhookUrl: 'https://takeoff.example.com/api/mail/ms/webhook',
    tenant: 'common',
  },
  secretKey: 'file',
};

const realClipboard = navigator.clipboard;
const setClipboard = (value: unknown) =>
  Object.defineProperty(navigator, 'clipboard', { value, configurable: true });

beforeEach(() => {
  h.setupInfo.mockReset().mockResolvedValue(INFO);
  h.toast.mockReset();
});
afterEach(() => setClipboard(realClipboard));

describe('MailSetupGuide', () => {
  it('shows the redirect URIs and webhook URL this deployment resolved', async () => {
    render(<MailSetupGuide />);
    expect(await screen.findByText('https://takeoff.example.com/api/mail/oauth/google/callback')).toBeInTheDocument();
    expect(screen.getByText('https://takeoff.example.com/api/mail/oauth/microsoft/callback')).toBeInTheDocument();
    expect(screen.getByText('https://takeoff.example.com/api/mail/ms/webhook')).toBeInTheDocument();
  });

  it('badges each env var as set or not set', async () => {
    render(<MailSetupGuide />);
    const google = await screen.findByTestId('env-GOOGLE_OAUTH_CLIENT_ID');
    expect(google).toHaveTextContent('set');
    expect(google).not.toHaveTextContent('not set');
    expect(screen.getByTestId('env-MS_OAUTH_CLIENT_ID')).toHaveTextContent('not set');
    expect(screen.getByTestId('env-APP_PUBLIC_URL')).toHaveTextContent('set');
  });

  it('warns when APP_PUBLIC_URL is unset and marks the URIs unavailable', async () => {
    h.setupInfo.mockResolvedValue({
      ...INFO,
      publicUrl: null,
      google: { configured: false, redirectUri: null, pubsub: { configured: false, topic: null, webhookUrl: null } },
      microsoft: { configured: false, redirectUri: null, webhookUrl: null, tenant: 'common' },
    });
    render(<MailSetupGuide />);
    expect(await screen.findByText(/APP_PUBLIC_URL is not set/)).toBeInTheDocument();
    expect(screen.getByTestId('env-APP_PUBLIC_URL')).toHaveTextContent('not set');
  });

  it('shows the Pub/Sub topic and the push URL an admin pastes into the subscription', async () => {
    render(<MailSetupGuide />);
    expect(await screen.findByText('https://takeoff.example.com/api/mail/google/webhook?token=s3cr3t')).toBeInTheDocument();
    expect(screen.getByTestId('env-GOOGLE_PUBSUB_TOPIC')).toHaveTextContent('set');
    expect(screen.getByTestId('env-GOOGLE_PUBSUB_TOPIC')).toHaveTextContent('projects/ft/topics/mail');
  });

  it('marks Gmail push as optional and unconfigured without a topic', async () => {
    h.setupInfo.mockResolvedValue({
      ...INFO,
      google: { ...INFO.google, pubsub: { configured: false, topic: null, webhookUrl: INFO.google.pubsub.webhookUrl } },
    });
    render(<MailSetupGuide />);
    expect(await screen.findByText(/Real-time push/)).toBeInTheDocument();
    expect(screen.getByTestId('env-GOOGLE_PUBSUB_TOPIC')).toHaveTextContent('not set');
    // Still shown: an admin needs the URL in hand to create the subscription.
    expect(screen.getByText('https://takeoff.example.com/api/mail/google/webhook?token=s3cr3t')).toBeInTheDocument();
  });

  it('notes the generated key file when MAIL_SECRET_KEY is unset', async () => {
    render(<MailSetupGuide />);
    expect(await screen.findByText(/data\/mail\.key/)).toBeInTheDocument();
  });

  it('copies a value when the browser has a clipboard', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    render(<MailSetupGuide />);
    const rows = await screen.findAllByRole('button', { name: /^Copy / });
    fireEvent.click(rows[0]);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith('https://takeoff.example.com/api/mail/oauth/google/callback'));
  });

  it('drops the copy buttons but keeps the text selectable without a clipboard API', async () => {
    setClipboard(undefined);
    render(<MailSetupGuide />);
    expect(await screen.findByText('https://takeoff.example.com/api/mail/oauth/google/callback')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Copy / })).not.toBeInTheDocument();
  });

  it('surfaces a failed load instead of rendering half a guide', async () => {
    h.setupInfo.mockRejectedValue(new Error('Admin access required'));
    render(<MailSetupGuide />);
    expect(await screen.findByText(/Admin access required/)).toBeInTheDocument();
  });
});
