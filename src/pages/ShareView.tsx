// src/pages/ShareView.tsx — /share/:shareId, the public page behind a share
// link (no sign-in).
//
//   * One file: shown in ONLYOFFICE's embedded viewer when it can read it
//     (PDFs, Word, Excel…; phones too — Phase 6); otherwise the PDF inline,
//     the image, or a download card. The Download button is always there.
//   * Several documents (Phase 7): a list; each opens the same way (?f=<n>).
//   * Plan pages: a scrolling gallery, as before.
//   * A link that expired, was turned off or never existed says so (Phase 7).
import React, { useCallback, useEffect, useState } from 'react';
import { useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, Ban, Clock, Download, FileQuestion, LinkIcon } from 'lucide-react';
import {
  ShareLinkError, formatBytes, getShareInfo, openShareViewer, type ShareInfo,
} from '../utils/store';
import { OnlyofficeViewer } from '../components/OnlyofficeViewer';
import { MimeIcon } from './documents/MimeIcon';

const PAGE_HEIGHT = 'calc(100dvh - 57px)';
const expiryNote = (expiresAt?: number | null) =>
  expiresAt ? `Link expires ${new Date(expiresAt).toLocaleDateString([], { dateStyle: 'medium' })}` : null;

const PROBLEMS: Record<ShareLinkError['code'], { icon: React.ReactNode; title: string; hint: string }> = {
  expired: { icon: <Clock size={32} className="text-amber-500" />, title: 'This link has expired', hint: 'Ask whoever sent it for a new one.' },
  revoked: { icon: <Ban size={32} className="text-red-500" />, title: 'This link was turned off', hint: 'Whoever shared it stopped sharing. Ask them for a new link if you still need it.' },
  missing: { icon: <FileQuestion size={32} className="text-ink-faint" />, title: "This link doesn't exist", hint: 'Check the address, or ask whoever sent it.' },
  error: { icon: <LinkIcon size={32} className="text-ink-faint" />, title: "This link can't be opened right now", hint: 'Try again in a moment.' },
};

export const ShareView: React.FC = () => {
  const { shareId } = useParams<{ shareId: string }>();
  const [info, setInfo] = useState<ShareInfo | null>(null);
  const [problem, setProblem] = useState<ShareLinkError['code'] | null>(null);

  useEffect(() => {
    if (!shareId) return;
    getShareInfo(shareId)
      .then(setInfo)
      .catch(e => setProblem(e instanceof ShareLinkError ? e.code : 'error'));
  }, [shareId]);

  if (problem) {
    const p = PROBLEMS[problem];
    return (
      <div className="flex min-h-screen items-center justify-center p-6" data-testid="share-problem" data-problem={problem}>
        <div className="max-w-sm space-y-3 text-center">
          <div className="flex justify-center">{p.icon}</div>
          <h1 className="text-lg font-semibold text-ink">{p.title}</h1>
          <p className="text-sm text-ink-soft">{p.hint}</p>
        </div>
      </div>
    );
  }

  if (!info || !shareId) {
    return (
      <div className="flex min-h-screen items-center justify-center">
        <div className="h-8 w-8 animate-spin rounded-full border-4 border-accent-600 border-t-transparent" />
      </div>
    );
  }

  // ── Plan pages ──────────────────────────────────────────────────────────
  if (info.type === 'pages' && info.count) {
    const pages = Array.from({ length: info.count }, (_, i) => i);
    return (
      <div className="flex min-h-screen flex-col">
        <div className="sticky top-0 z-10 flex items-center justify-between glass-panel border-b border-edge px-6 py-3">
          <div>
            <h1 className="truncate font-semibold text-ink">{info.name}</h1>
            <p className="text-xs text-ink-soft">
              {info.count} page{info.count !== 1 ? 's' : ''}{expiryNote(info.expiresAt) ? ` · ${expiryNote(info.expiresAt)}` : ''}
            </p>
          </div>
        </div>
        <div className="mx-auto w-full max-w-5xl flex-1 space-y-8 overflow-y-auto px-4 py-6">
          {pages.map(i => <PageCard key={i} shareId={shareId} index={i} />)}
        </div>
      </div>
    );
  }

  // ── Several documents ───────────────────────────────────────────────────
  if (info.type === 'files') return <SharedFiles shareId={shareId} info={info} />;

  // ── One file ────────────────────────────────────────────────────────────
  const fileUrl = `/api/share/${shareId}`;
  const downloadName = info.type === 'printout' && !info.name.toLowerCase().endsWith('.pdf') ? `${info.name}.pdf` : info.name;
  return (
    <div className="flex min-h-screen flex-col">
      <ShareHeader title={info.name} note={expiryNote(info.expiresAt)} download={{ href: `${fileUrl}?download=1`, name: downloadName }} />
      <FilePreview
        shareId={shareId}
        src={fileUrl}
        download={{ href: `${fileUrl}?download=1`, name: downloadName }}
        name={info.name}
        mime={info.mime ?? (info.type === 'printout' ? 'application/pdf' : '')}
        viewer={!!info.viewer}
      />
    </div>
  );
};

const ShareHeader: React.FC<{
  title: string; note?: string | null; download?: { href: string; name: string }; back?: () => void;
}> = ({ title, note, download, back }) => (
  <div className="flex items-center gap-3 glass-panel border-b border-edge px-4 py-3 sm:px-6">
    {back && (
      <button type="button" onClick={back} aria-label="All files" data-testid="share-back"
        className="flex items-center gap-1 rounded-lg px-2 py-1.5 text-sm text-ink-soft hover:bg-hover hover:text-ink">
        <ArrowLeft size={16} /><span className="hidden sm:inline">All files</span>
      </button>
    )}
    <div className="min-w-0 flex-1">
      <h1 className="truncate font-semibold text-ink">{title}</h1>
      {note && <p className="text-xs text-ink-soft" data-testid="share-expiry-note">{note}</p>}
    </div>
    {download && (
      <a href={download.href} download={download.name}
        className="flex items-center gap-2 rounded-xl bg-accent-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-700">
        <Download size={15} /> Download
      </a>
    )}
  </div>
);

/** One shared file: the viewer when it can, else what the browser shows,
 *  else a download card. */
const FilePreview: React.FC<{
  shareId: string; index?: number; src: string; download: { href: string; name: string }; name: string; mime: string; viewer: boolean;
}> = ({ shareId, index, src, download, name, mime, viewer }) => {
  // The viewer said no after all (e.g. ONLYOFFICE unreachable): the browser's own preview.
  const [viewerFailed, setViewerFailed] = useState(false);
  const loadViewer = useCallback(() => openShareViewer(shareId, {
    device: window.matchMedia('(max-width: 767px)').matches ? 'phone' : 'desktop',
    theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
  }, index), [shareId, index]);

  if (viewer && !viewerFailed) {
    return (
      <OnlyofficeViewer
        load={loadViewer}
        testId="share-viewer"
        className="h-[calc(100dvh-57px)] w-full"
        renderError={() => <ViewerFallback onShow={() => setViewerFailed(true)} />}
      />
    );
  }
  if (mime === 'application/pdf') {
    return (
      <object data={src} type="application/pdf" className="h-full w-full border-0" style={{ minHeight: PAGE_HEIGHT }} aria-label={name}>
        <DownloadCard name={name} download={download} note="Your browser can't preview this PDF inline." />
      </object>
    );
  }
  if (mime.startsWith('image/')) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <img src={src} alt={name} className="max-h-full max-w-full rounded-xl shadow-xl" />
      </div>
    );
  }
  return <DownloadCard name={name} download={download} note="This file can't be previewed here." />;
};

const DownloadCard: React.FC<{ name: string; download: { href: string; name: string }; note: string }> = ({ name, download, note }) => (
  <div className="flex flex-col items-center justify-center gap-4 p-8 text-center" style={{ minHeight: PAGE_HEIGHT }} data-testid="share-download-card">
    <p className="text-ink-soft">{note}</p>
    <a href={download.href} download={download.name}
      className="flex items-center gap-2 rounded-xl bg-accent-600 px-5 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-700">
      <Download size={15} /> Download {name}
    </a>
  </div>
);

/** The viewer couldn't open: switch to the page's own preview straight away. */
const ViewerFallback: React.FC<{ onShow: () => void }> = ({ onShow }) => {
  useEffect(() => { onShow(); }, [onShow]);
  return null;
};

/** Several documents under one link: the list, and one at a time (?f=). */
const SharedFiles: React.FC<{ shareId: string; info: ShareInfo }> = ({ shareId, info }) => {
  const [params, setParams] = useSearchParams();
  const files = info.files ?? [];
  const openIndex = params.get('f') === null ? null : Number(params.get('f'));
  const open = openIndex !== null && files[openIndex] && !files[openIndex].missing ? openIndex : null;
  const go = (i: number | null) => setParams(i === null ? {} : { f: String(i) });
  const src = (i: number) => `/api/share/${shareId}/file/${i}`;

  if (open !== null) {
    const f = files[open];
    const download = { href: `${src(open)}?download=1`, name: f.name };
    return (
      <div className="flex min-h-screen flex-col">
        <ShareHeader title={f.name} note={`${open + 1} of ${files.length} · ${info.name}`} download={download} back={() => go(null)} />
        <FilePreview key={open} shareId={shareId} index={open} src={src(open)} download={download} name={f.name} mime={f.mime} viewer={f.viewer} />
      </div>
    );
  }

  return (
    <div className="flex min-h-screen flex-col">
      <ShareHeader
        title={info.name || `${files.length} documents`}
        note={[`${files.length} document${files.length === 1 ? '' : 's'}`, expiryNote(info.expiresAt)].filter(Boolean).join(' · ')}
      />
      <ul className="mx-auto w-full max-w-2xl flex-1 space-y-2 px-4 py-6" data-testid="share-files">
        {files.map((f, i) => (
          <li key={i} className="flex items-center gap-3 rounded-xl border border-edge bg-raised px-4 py-3" data-testid="share-file-row">
            <MimeIcon mime={f.mime} size={20} />
            {f.missing ? (
              <span className="min-w-0 flex-1 truncate text-sm text-ink-faint">{f.name}</span>
            ) : (
              <button type="button" onClick={() => go(i)} className="min-w-0 flex-1 text-left" data-testid="share-file-open">
                <span className="block truncate text-sm font-medium text-ink hover:underline">{f.name}</span>
                <span className="block text-xs text-ink-faint">{formatBytes(f.size)}</span>
              </button>
            )}
            {!f.missing && (
              <a href={`${src(i)}?download=1`} download={f.name} aria-label={`Download ${f.name}`}
                className="rounded-lg p-2 text-ink-soft hover:bg-hover hover:text-ink">
                <Download size={16} />
              </a>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
};

interface PageCardProps {
  shareId: string;
  index: number;
}

const PageCard: React.FC<PageCardProps> = ({ shareId, index }) => {
  const [meta, setMeta] = useState<{ name: string; pageNumber?: string } | null>(null);

  useEffect(() => {
    // Fetch the page list once from info — but we only get count there, not per-page names.
    // Instead we expose names via a separate lightweight endpoint by passing index.
    fetch(`/api/share/${shareId}/page-info/${index}`)
      .then(r => r.ok ? r.json() : null)
      .then(setMeta)
      .catch(() => setMeta({ name: `Page ${index + 1}` }));
  }, [shareId, index]);

  const imgUrl = `/api/share/${shareId}/image/${index}`;
  const label = meta?.pageNumber
    ? `${meta.pageNumber}${meta.name && meta.name !== meta.pageNumber ? ' — ' + meta.name : ''}`
    : meta?.name ?? `Page ${index + 1}`;

  return (
    <div className="overflow-hidden rounded-2xl border border-edge bg-raised shadow-lg">
      <div className="border-b border-edge bg-sunken px-5 py-3">
        <span className="text-sm font-semibold text-ink-soft">{label}</span>
      </div>
      <div className="flex items-center justify-center bg-sunken p-2">
        <img
          src={imgUrl}
          alt={label}
          className="w-full rounded-xl"
          loading={index < 2 ? 'eager' : 'lazy'}
        />
      </div>
    </div>
  );
};
