// src/pages/AttachmentViewer.tsx — /tools/view?message=…&att=…&name=…: a
// Word, Excel or PowerPoint mail attachment in the ONLYOFFICE viewer (Phase 6),
// opened in its own tab from the attachment chip. Read only; nothing is
// stored. Save to Documents stays in the mail view.
//
// When the viewer can't open it (ONLYOFFICE not set up or unreachable) the
// attachment is still one tap away as a download.
import React, { useCallback } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useIsPresent } from 'motion/react';
import { AlertTriangle, Download } from 'lucide-react';
import { Button } from '../components/ui';
import { OnlyofficeViewer, type ViewerFailure } from '../components/OnlyofficeViewer';
import { useTheme } from '../context/ThemeContext';
import { openAttachmentViewer } from '../utils/store';
import { mailApi } from '../utils/mailApi';

// The mobile top bar sits above every page on phones (AppShell).
const FULL_HEIGHT = 'h-[calc(100dvh-3.5rem-env(safe-area-inset-top))] md:h-dvh';

export const AttachmentViewer: React.FC = () => {
  const [params] = useSearchParams();
  const present = useIsPresent();
  const messageId = params.get('message') || '';
  const attId = params.get('att') || '';
  const name = params.get('name') || 'attachment';
  const { mode } = useTheme();
  const navigate = useNavigate();

  const load = useCallback(() => openAttachmentViewer(messageId, attId, {
    device: window.matchMedia('(max-width: 767px)').matches ? 'phone' : 'desktop',
    theme: mode === 'dark' ? 'dark' : 'light',
    // Read once: the viewer takes its theme when it starts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [messageId, attId]);

  // Opened in its own tab: Close closes it; otherwise back to mail.
  const close = useCallback(() => {
    if (window.history.length > 1) navigate(-1);
    else { window.close(); navigate('/mail'); }
  }, [navigate]);

  // See DocumentEditor: the outgoing copy of a route transition renders nothing.
  if (!present) return null;
  if (!messageId || !attId) {
    return <Unavailable name={name} failure={{ message: 'This link is missing the attachment it should open.' }} download={null} />;
  }
  const download = mailApi.attachmentUrl(messageId, attId);
  return (
    <OnlyofficeViewer
      key={`${messageId}|${attId}`}
      load={load}
      onClose={close}
      className={`${FULL_HEIGHT} bg-sunken`}
      testId="attachment-viewer"
      renderError={failure => <Unavailable name={name} failure={failure} download={download} />}
    />
  );
};

const Unavailable: React.FC<{ name: string; failure: ViewerFailure; download: string | null }> = ({ name, failure, download }) => (
  <div className="mx-auto flex max-w-lg flex-col items-center gap-3 px-6 py-16 text-center" data-testid="attachment-viewer-error">
    <AlertTriangle size={28} className="text-amber-500" />
    <h1 className="text-lg font-semibold text-ink">Can't show {name} here</h1>
    <p className="text-sm text-ink-soft">{failure.message}</p>
    {download && (
      <a href={download} download={name}>
        <Button size="sm"><Download size={14} /> Download it instead</Button>
      </a>
    )}
  </div>
);
