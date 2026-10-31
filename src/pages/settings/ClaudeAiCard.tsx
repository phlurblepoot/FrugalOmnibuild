// src/pages/settings/ClaudeAiCard.tsx — Settings › User Preferences › AI Sheet Reading.
//
// Claude reads plan sheets (number, title, matching to existing sheets). An
// admin connects it once for the whole server, with either a long-lived token
// from `claude setup-token` (their Claude Pro/Max plan) or an API key from
// platform.claude.com, and picks the model. The secret goes to the server and
// never comes back: this card only ever sees "Connected … last 4". Everyone
// else sees whether it is connected, plus their own on/off switch.
import React, { useCallback, useEffect, useState } from 'react';
import { KeyRound, Sparkles, Unplug, Zap } from 'lucide-react';
import { Button, Input, Select, StatusPill } from '../../components/ui';
import { useToast } from '../../components/Toast';
import { useConfirm } from '../../components/ConfirmDialog';
import { ClaudeUsagePanel } from './ClaudeUsagePanel';
import {
  getAiStatus, aiAutoNameEnabled, setAiAutoNameEnabled, claudeApi,
  type AiStatus, type ClaudeConnection, type ClaudeSource,
} from '../../utils/aiSheets';

const SOURCE_LABEL: Record<ClaudeSource, string> = {
  token: 'Claude subscription',
  apiKey: 'API key',
  env: 'Set on the container',
  login: 'Signed in on the server',
};

const formatCents = (c: number) => (c >= 1 ? `${c}¢` : `${c.toFixed(1)}¢`);

const Code: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <code className="rounded bg-sunken px-1.5 py-0.5 font-mono text-[0.8em] text-ink">{children}</code>
);

export const ClaudeAiCard: React.FC<{ isAdmin: boolean }> = ({ isAdmin }) => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [status, setStatus] = useState<AiStatus | null>(null);
  const [conn, setConn] = useState<ClaudeConnection | null>(null);
  const [autoName, setAutoName] = useState<boolean>(aiAutoNameEnabled());
  const [kind, setKind] = useState<'token' | 'apiKey'>('token');
  const [secret, setSecret] = useState('');
  const [busy, setBusy] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string } | null>(null);
  // Bumped after a call to Claude, so the usage panel shows its new numbers.
  const [usageKey, setUsageKey] = useState(0);

  const refresh = useCallback(async () => {
    setStatus(await getAiStatus(true));
    if (isAdmin) {
      try { setConn(await claudeApi.get()); } catch { /* not admin after all */ }
    }
  }, [isAdmin]);
  useEffect(() => { refresh(); }, [refresh]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    try { await fn(); } catch (err: any) { toast(err?.message ?? 'Failed.', { type: 'error' }); } finally { setBusy(false); }
  };

  const connect = (e: React.FormEvent) => {
    e.preventDefault();
    run(async () => {
      setConn(await claudeApi.connect(kind, secret));
      setSecret('');
      setTestResult(null);
      setStatus(await getAiStatus(true));
      toast('Claude connected. Use Test connection to check it.', { type: 'success' });
    });
  };

  const disconnect = () => run(async () => {
    const ok = await confirm({
      title: 'Disconnect Claude?',
      message: 'The saved token or key is deleted from the server. AI Scan stops working until Claude is connected again; page naming from the PDF text and OCR keeps working.',
      confirmLabel: 'Disconnect',
      tone: 'danger',
    });
    if (!ok) return;
    setConn(await claudeApi.disconnect());
    setTestResult(null);
    setStatus(await getAiStatus(true));
  });

  const test = () => run(async () => {
    setTestResult(null);
    const r = await claudeApi.test();
    if (r.ok) setTestResult({ ok: true, text: `Claude answered (${conn?.models.find(m => m.id === r.model)?.label ?? r.model}).` });
    else setTestResult({ ok: false, text: 'error' in r ? r.error : 'Claude did not answer.' });
    setUsageKey(k => k + 1);
    setStatus(await getAiStatus(true));
  });

  const changeModel = (model: string) => run(async () => {
    setConn(await claudeApi.setModel(model));
    setTestResult(null);
  });

  const available = !!status?.available;
  const ownSecret = conn?.source === 'token' || conn?.source === 'apiKey';
  const showCost = conn?.connected ? conn.source === 'apiKey' || conn.source === 'env' : kind === 'apiKey';
  const modelLabel = conn?.models.find(m => m.id === (conn?.model ?? status?.model))?.label ?? status?.model;

  return (
    <div className="bg-raised rounded-2xl border border-edge shadow-sm overflow-hidden" data-testid="claude-ai-card">
      <div className="p-6 border-b border-edge">
        <h2 className="text-lg font-bold text-ink flex items-center gap-2">
          <Sparkles size={18} /> AI Sheet Reading
        </h2>
        <p className="text-sm text-ink-soft mt-1">
          {available
            ? `Claude reads your plan sheets (${modelLabel}): the sheet number and title, and which existing sheet a new page revises.`
            : isAdmin
            ? 'Connect Claude below to have it read your plan sheets. Until then, page naming uses the PDF’s text and OCR.'
            : 'Claude is not connected. An admin can connect it here. Until then, page naming uses the PDF’s text and OCR.'}
        </p>
        <p className="text-xs text-ink-faint mt-2">
          When Claude reads a page, the page image and the PDF’s text are sent to Anthropic. Nothing is sent until someone clicks AI Scan or picks the AI read engine.
        </p>
        {status?.lastError && (
          <p className="text-xs text-red-600 dark:text-red-400 mt-2" role="alert">Last AI read failed: {status.lastError.message}</p>
        )}
      </div>

      <div className="p-6 space-y-6">
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium text-ink">Enable AI sheet reading</p>
            <p className="text-xs text-ink-soft mt-0.5">
              Prepares page images for Claude when you upload and shows the AI Scan button on the naming screen. Nothing is sent until you click AI Scan.
            </p>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={autoName}
            aria-label="Enable AI sheet reading"
            disabled={!available}
            onClick={() => { const next = !autoName; setAutoName(next); setAiAutoNameEnabled(next); }}
            className={`relative shrink-0 w-12 h-6 rounded-full transition-colors duration-200 focus:outline-none focus:ring-2 focus:ring-accent-500 focus:ring-offset-2 focus:ring-offset-raised disabled:opacity-50 disabled:cursor-not-allowed ${autoName && available ? 'bg-accent-600' : 'bg-edge-strong'}`}
          >
            <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full shadow-sm transition-all ${autoName && available ? 'left-6' : 'left-0.5'}`} />
          </button>
        </div>

        {isAdmin && conn && (
          <div className="space-y-5 border-t border-edge pt-6">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="flex items-center gap-2 min-w-0">
                <p className="text-sm font-semibold text-ink">Claude connection</p>
                {conn.connected
                  ? <StatusPill tone="green">Connected</StatusPill>
                  : <StatusPill tone="slate">Not connected</StatusPill>}
              </div>
              {conn.connected && (
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" disabled={busy} onClick={test}><Zap size={14} /> Test connection</Button>
                  {ownSecret && <Button size="sm" variant="secondary" disabled={busy} onClick={disconnect}><Unplug size={14} /> Disconnect</Button>}
                </div>
              )}
            </div>

            {conn.connected && conn.source && (
              <p className="text-sm text-ink-soft" data-testid="claude-connection-detail">
                {SOURCE_LABEL[conn.source]}{conn.last4 ? <> · ending in <span className="font-mono text-ink">{conn.last4}</span></> : null}
                {conn.source === 'env' && <> · from <Code>CLAUDE_CODE_OAUTH_TOKEN</Code> or <Code>ANTHROPIC_API_KEY</Code>; remove it from the container to disconnect.</>}
                {conn.source === 'login' && <> · stored by <Code>claude login</Code> in the data folder; run <Code>claude logout</Code> in the container to disconnect.</>}
              </p>
            )}
            {testResult && (
              <p className={`text-sm ${testResult.ok ? 'text-green-700 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`} role="status">
                {testResult.text}
              </p>
            )}

            {!conn.connected && (
              <form onSubmit={connect} className="space-y-4">
                <div className="flex flex-wrap gap-2" role="radiogroup" aria-label="How to connect">
                  {([['token', 'Claude subscription (Pro or Max)'], ['apiKey', 'API key']] as const).map(([k, label]) => (
                    <button
                      key={k} type="button" role="radio" aria-checked={kind === k}
                      onClick={() => { setKind(k); setSecret(''); }}
                      className={`rounded-lg border px-3 py-1.5 text-sm transition-colors ${kind === k ? 'border-accent-500 bg-accent-50 text-accent-700 dark:bg-accent-900/30 dark:text-accent-300' : 'border-edge text-ink-soft hover:bg-hover'}`}
                    >{label}</button>
                  ))}
                </div>
                {kind === 'token' ? (
                  <div className="text-sm text-ink-soft space-y-1.5">
                    <p>On any computer with Claude Code installed, run <Code>claude setup-token</Code>, sign in with your Claude account, and paste the token it prints. It lasts a year and uses your plan’s limits. This is for your own private install; for anything shared more widely, use an API key.</p>
                    <p className="text-xs">No other computer? Run it on the server: <Code>docker exec -it &lt;container&gt; claude setup-token</Code> (your container’s name, e.g. plan-takeoff-app). Or sign the server in for good with <Code>docker exec -it &lt;container&gt; claude login</Code>; that sign-in is kept in the data folder and shows up here by itself.</p>
                  </div>
                ) : (
                  <p className="text-sm text-ink-soft">Create a key at <a className="text-accent-600 hover:underline" href="https://platform.claude.com/settings/keys" target="_blank" rel="noreferrer">platform.claude.com</a> and paste it here. Each sheet Claude reads is billed to that account. Use this for anything shared more widely; it is a drop-in switch from a subscription token.</p>
                )}
                <div className="flex flex-col sm:flex-row gap-2">
                  <label htmlFor="claude-secret" className="sr-only">{kind === 'token' ? 'Claude Code token' : 'API key'}</label>
                  <Input
                    id="claude-secret" type="password" autoComplete="off" spellCheck={false}
                    placeholder={kind === 'token' ? 'sk-ant-oat01-…' : 'sk-ant-api03-…'}
                    value={secret} onChange={e => setSecret(e.target.value)}
                    className="font-mono sm:flex-1"
                  />
                  <Button type="submit" disabled={busy || !secret.trim()}><KeyRound size={14} /> Connect</Button>
                </div>
              </form>
            )}

            <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
              <div className="flex-1">
                <label htmlFor="claude-model" className="text-sm font-medium text-ink">Model</label>
                <p className="text-xs text-ink-soft mt-0.5">
                  {showCost
                    ? `With an API key, a sheet costs roughly ${conn.models.map(m => `${formatCents(m.centsPerSheet)} on ${m.label.split(' ')[0]}`).join(', ')}.`
                    : 'With a subscription, reading counts against your plan’s usage limits.'}
                  {' '}Opus reads small print best; Haiku is fastest.
                </p>
              </div>
              <Select id="claude-model" value={conn.model} disabled={busy} onChange={e => changeModel(e.target.value)} className="sm:w-48">
                {conn.models.map(m => <option key={m.id} value={m.id}>{m.label}</option>)}
              </Select>
            </div>

            {conn.connected && (
              <div className="border-t border-edge pt-5">
                <ClaudeUsagePanel source={conn.source} refreshKey={usageKey} />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
