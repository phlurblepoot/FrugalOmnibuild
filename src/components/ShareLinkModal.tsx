// src/components/ShareLinkModal.tsx — sharing (ONLYOFFICE Phase 7). One
// window for everything about a thing's public links:
//   * the links already working for it (a document's own, several-documents
//     links it's in, and links from before expiry existed, which never
//     expire), each with its expiry, who made it, Copy and "Stop sharing";
//   * a new link: pick 7 / 30 (default) / 90 days or never, then Create;
//   * the chosen link's QR code and address to copy, and its expiry, which
//     can be changed.
// "Share page" on a plan page makes its link straight away (createNow) and
// opens here on it.
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Copy, Check, X, Link as LinkIcon, Plus, Ban } from 'lucide-react';
import QRCode from 'qrcode';
import { useToast } from './Toast';
import { useConfirm } from './ConfirmDialog';
import {
  SHARE_EXPIRY_CHOICES, createShareLink, getSettings, listShareLinks, setShareLinkExpiry, shareUrlFor, stopShareLink,
  type ShareExpiry, type ShareLink, type ShareTarget,
} from '../utils/store';

export interface ShareRequest {
  /** Heading, e.g. "Share Scope.docx" or "Share 3 documents". */
  title: string;
  /** What a new link opens. */
  target: ShareTarget;
  /** The name the public page shows. */
  name: string;
  /** Make a link as the window opens (the plan page's Share buttons). */
  createNow?: boolean;
  /** For several documents: their names, listed at the top. */
  fileNames?: string[];
}

type ShareFn = (request: ShareRequest) => void;
const ShareContext = createContext<ShareFn>(() => {});

/** The stored file whose other links are worth listing, if there is one. */
const listedFileId = (t: ShareTarget): string | null => (t.type === 'file' || t.type === 'page' ? t.resourceId : null);

const expiryText = (expiresAt: number | null) => {
  if (expiresAt === null) return 'Never expires';
  return `Expires ${new Date(expiresAt).toLocaleDateString([], { dateStyle: 'medium' })}`;
};

/** Which choice an expiry is closest to, for the per-link selector. */
const closestChoice = (expiresAt: number | null): ShareExpiry => {
  if (expiresAt === null) return null;
  const days = (expiresAt - Date.now()) / 86_400_000;
  return days <= 8 ? 7 : days <= 31 ? 30 : 90;
};

export const ShareProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [request, setRequest] = useState<ShareRequest | null>(null);
  const share = useCallback<ShareFn>(r => setRequest(r), []);
  return (
    <ShareContext.Provider value={share}>
      {children}
      <AnimatePresence>
        {request && <ShareDialog key={JSON.stringify(request.target)} request={request} onClose={() => setRequest(null)} />}
      </AnimatePresence>
    </ShareContext.Provider>
  );
};

const ShareDialog: React.FC<{ request: ShareRequest; onClose: () => void }> = ({ request, onClose }) => {
  const { toast } = useToast();
  const confirm = useConfirm();
  const [host, setHost] = useState<string | null>(null);
  const [links, setLinks] = useState<ShareLink[] | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [newExpiry, setNewExpiry] = useState<ShareExpiry>(30);
  const [busy, setBusy] = useState(false);
  const [qr, setQr] = useState('');
  const [copied, setCopied] = useState<string | null>(null);

  const url = (id: string) => shareUrlFor(id, host);
  const fileId = listedFileId(request.target);

  const create = useCallback(async (days: ShareExpiry) => {
    setBusy(true);
    try {
      const made = await createShareLink(request.target, request.name, days);
      const link: ShareLink = {
        id: made.id, type: request.target.type, name: request.name, createdAt: Date.now(), expiresAt: made.expiresAt,
        createdBy: null, createdByName: null, fileCount: request.target.type === 'files' ? request.target.fileIds.length : 1,
      };
      setLinks(prev => [link, ...(prev ?? []).filter(l => l.id !== link.id)]);
      setSelected(made.id);
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : "Couldn't create the link", { type: 'error' });
    } finally {
      setBusy(false);
    }
  }, [request, toast]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const settings = await getSettings().catch(() => ({} as Record<string, string>));
      if (cancelled) return;
      setHost(settings.publicHost || null);
      const existing = fileId ? await listShareLinks(fileId).catch(() => [] as ShareLink[]) : [];
      if (cancelled) return;
      // Keep a link made while these loaded (Create clicked straight away).
      setLinks(prev => [...(prev ?? []), ...existing.filter(e => !prev?.some(p => p.id === e.id))]);
      if (request.createNow) await create(30);
    })();
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => { cancelled = true; window.removeEventListener('keydown', onKey); };
    // Once per request (the dialog is keyed on it).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    setQr('');
    if (!selected) return;
    let cancelled = false;
    QRCode.toDataURL(url(selected), { width: 200, margin: 1 })
      .then(d => { if (!cancelled) setQr(d); })
      .catch(() => { /* the QR code is a nice-to-have; the link works without it */ });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, host]);

  const copy = async (id: string) => {
    try {
      await navigator.clipboard.writeText(url(id));
      setCopied(id);
      toast('Link copied to clipboard', { type: 'success' });
      setTimeout(() => setCopied(c => (c === id ? null : c)), 2000);
    } catch {
      toast('Press Ctrl/Cmd+C to copy the selected link', { type: 'info' });
    }
  };

  const changeExpiry = async (id: string, days: ShareExpiry) => {
    try {
      const { expiresAt } = await setShareLinkExpiry(id, days);
      setLinks(prev => (prev ?? []).map(l => (l.id === id ? { ...l, expiresAt } : l)));
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : "Couldn't change the expiry", { type: 'error' });
    }
  };

  const stop = async (link: ShareLink) => {
    const ok = await confirm({
      title: 'Stop sharing?',
      message: link.fileCount > 1
        ? `This link opens ${link.fileCount} documents; it stops working for all of them. Anyone who opens it is told it was turned off.`
        : 'The link stops working. Anyone who opens it is told it was turned off.',
      confirmLabel: 'Stop sharing',
      tone: 'danger',
    });
    if (!ok) return;
    try {
      await stopShareLink(link.id);
      setLinks(prev => (prev ?? []).filter(l => l.id !== link.id));
      if (selected === link.id) setSelected(null);
      toast('Link turned off', { type: 'success' });
    } catch (e) {
      toast(e instanceof Error && e.message ? e.message : "Couldn't stop sharing", { type: 'error' });
    }
  };

  const current = links?.find(l => l.id === selected) ?? null;

  return (
    <motion.div
      className="fixed inset-0 z-[300] flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm"
      initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
      role="dialog" aria-modal="true" aria-label="Share"
    >
      <motion.div
        className="flex max-h-[calc(100dvh-2rem)] w-full max-w-md flex-col overflow-hidden rounded-2xl border border-edge bg-raised shadow-xl"
        initial={{ opacity: 0, scale: 0.95, y: 12 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.95, y: 12 }}
        transition={{ duration: 0.18 }}
        onClick={e => e.stopPropagation()}
        data-testid="share-dialog"
      >
        <div className="flex items-center justify-between border-b border-edge px-5 py-4">
          <h2 className="flex min-w-0 items-center gap-2 text-lg font-bold text-ink">
            <LinkIcon size={18} className="shrink-0 text-accent-600" />
            <span className="truncate">{request.title}</span>
          </h2>
          <button onClick={onClose} aria-label="Close" className="rounded-lg p-1.5 text-ink-faint transition-all hover:bg-hover hover:text-ink">
            <X size={18} />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4">
          {request.fileNames && request.fileNames.length > 1 && (
            <p className="text-xs text-ink-soft" data-testid="share-file-names">
              One link to {request.fileNames.length} documents: {request.fileNames.join(', ')}
            </p>
          )}

          {current && (
            <div className="flex flex-col items-center gap-3 rounded-xl border border-edge bg-sunken p-4" data-testid="share-current">
              <div className="flex h-40 w-40 items-center justify-center rounded-xl border border-edge bg-white p-2">
                {qr
                  ? <img src={qr} alt="QR code linking to the shared page" className="h-full w-full" />
                  : <div className="h-6 w-6 animate-spin rounded-full border-b-2 border-accent-600" />}
              </div>
              <div className="flex w-full items-center gap-2">
                <input
                  readOnly value={url(current.id)} onFocus={e => e.currentTarget.select()} aria-label="Share URL"
                  className="min-w-0 flex-1 truncate rounded-xl border border-edge-strong bg-raised px-3 py-2 font-mono text-sm text-ink"
                />
                <button
                  onClick={() => void copy(current.id)} data-testid="share-copy"
                  className="flex shrink-0 items-center gap-1.5 rounded-xl bg-accent-600 px-3 py-2 text-sm font-medium text-white transition-all hover:bg-accent-700"
                >
                  {copied === current.id ? <Check size={16} /> : <Copy size={16} />}
                  {copied === current.id ? 'Copied' : 'Copy'}
                </button>
              </div>
              <div className="flex w-full flex-wrap items-center justify-between gap-2 text-xs text-ink-soft">
                <span data-testid="share-current-expiry">{expiryText(current.expiresAt)}</span>
                <label className="flex items-center gap-1.5">
                  Lasts
                  <select
                    aria-label="Change how long this link lasts"
                    className="rounded-md border border-edge bg-raised px-1.5 py-0.5 text-xs text-ink"
                    value={String(closestChoice(current.expiresAt))}
                    onChange={e => void changeExpiry(current.id, e.target.value === 'null' ? null : Number(e.target.value) as ShareExpiry)}
                  >
                    {SHARE_EXPIRY_CHOICES.map(c => <option key={String(c.days)} value={String(c.days)}>{c.days === null ? 'Never expires' : `${c.label} from now`}</option>)}
                  </select>
                </label>
              </div>
            </div>
          )}

          <div>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-ink-faint">New link</p>
            <div className="flex flex-wrap items-center gap-2">
              <div className="flex rounded-lg border border-edge p-0.5" role="radiogroup" aria-label="How long the new link lasts">
                {SHARE_EXPIRY_CHOICES.map(c => (
                  <button
                    key={String(c.days)} type="button" role="radio" aria-checked={newExpiry === c.days}
                    data-testid={`share-expiry-${c.days ?? 'never'}`}
                    onClick={() => setNewExpiry(c.days)}
                    className={`rounded-md px-2 py-1 text-xs font-medium transition-colors ${newExpiry === c.days ? 'bg-accent-600 text-white' : 'text-ink-soft hover:bg-hover'}`}
                  >
                    {c.label}
                  </button>
                ))}
              </div>
              <button
                type="button" disabled={busy} onClick={() => void create(newExpiry)} data-testid="share-create"
                className="ml-auto flex items-center gap-1.5 rounded-lg border border-edge px-3 py-1.5 text-sm font-medium text-ink hover:bg-hover disabled:opacity-50"
              >
                <Plus size={14} /> Create link
              </button>
            </div>
          </div>

          {fileId && (
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wider text-ink-faint">Links that work now</p>
              {links === null ? (
                <p className="text-sm text-ink-soft">Loading…</p>
              ) : links.length === 0 ? (
                <p className="text-sm text-ink-soft" data-testid="share-links-empty">Not shared yet.</p>
              ) : (
                <ul className="space-y-1.5" data-testid="share-links">
                  {links.map(l => (
                    <li
                      key={l.id} data-testid="share-link-row"
                      className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 text-xs ${l.id === selected ? 'border-accent-500 bg-accent-50/50 dark:bg-accent-900/10' : 'border-edge'}`}
                    >
                      <button type="button" onClick={() => setSelected(l.id)} className="min-w-0 flex-1 text-left" title="Show this link">
                        <span className="block truncate font-mono text-ink">{url(l.id).replace(/^https?:\/\//, '')}</span>
                        <span className="block text-ink-faint">
                          {expiryText(l.expiresAt)}
                          {l.fileCount > 1 ? ` · with ${l.fileCount - 1} other document${l.fileCount > 2 ? 's' : ''}` : ''}
                          {l.createdByName ? ` · by ${l.createdByName}` : ''}
                        </span>
                      </button>
                      <button type="button" onClick={() => void copy(l.id)} aria-label="Copy link" className="rounded-md p-1 text-ink-soft hover:bg-hover hover:text-ink">
                        {copied === l.id ? <Check size={14} /> : <Copy size={14} />}
                      </button>
                      <button
                        type="button" onClick={() => void stop(l)} data-testid="share-stop"
                        className="flex items-center gap-1 rounded-md px-1.5 py-1 text-red-600 hover:bg-red-50 dark:text-red-400 dark:hover:bg-red-900/20"
                      >
                        <Ban size={12} /> Stop sharing
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          )}
          {!fileId && current && (
            <button type="button" onClick={() => void stop(current)} data-testid="share-stop"
              className="flex items-center gap-1 text-xs text-red-600 hover:underline dark:text-red-400">
              <Ban size={12} /> Stop sharing this link
            </button>
          )}
        </div>
      </motion.div>
    </motion.div>
  );
};

/** Opens the share window: `share({ title, target, name, createNow? })`. */
export const useShare = () => useContext(ShareContext);
