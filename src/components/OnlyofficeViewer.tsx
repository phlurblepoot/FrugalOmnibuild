// src/components/OnlyofficeViewer.tsx — ONLYOFFICE as a read-only viewer
// (Phase 6): mail attachments and share links. The server hands over a signed
// view-only config; this loads ONLYOFFICE's api.js from its public address and
// mounts the viewer in the space it's given, with a fallback when it can't.
//
// The editor page (src/pages/DocumentEditor.tsx) does the same for editing,
// with all the editing add-ons; a viewer needs none of them.
import React, { useEffect, useRef, useState } from 'react';
import { loadDocsApi, type DocsEditorInstance } from '../utils/onlyofficeApi';
import { EditorOpenError, type ViewerOpening } from '../utils/store';

let placeholderSeq = 0;

export type ViewerFailure = { message: string; code?: string; status?: number };

export const OnlyofficeViewer: React.FC<{
  /** Asks the server for the signed config. Called once per mount. */
  load: () => Promise<ViewerOpening>;
  /** ONLYOFFICE's own Close button, where the config shows one. */
  onClose?: () => void;
  /** What to show when it can't open (not set up, unsupported, unreachable…). */
  renderError: (failure: ViewerFailure) => React.ReactNode;
  className?: string;
  testId?: string;
}> = ({ load, onClose, renderError, className = '', testId = 'onlyoffice-viewer' }) => {
  const hostRef = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ phase: 'loading' } | { phase: 'ready' } | { phase: 'error'; failure: ViewerFailure }>({ phase: 'loading' });
  const loadRef = useRef(load);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    let cancelled = false;
    let viewer: DocsEditorInstance | null = null;
    const host = hostRef.current;
    (async () => {
      try {
        const opening = await loadRef.current();
        if (cancelled) return;
        try { await loadDocsApi(opening.publicUrl); } catch (e) {
          throw new EditorOpenError(
            `Couldn't load the viewer from ${opening.publicUrl} (${e instanceof Error ? e.message : 'unknown error'}).`, 0, 'script');
        }
        if (cancelled || !host || !window.DocsAPI) return;
        // ONLYOFFICE swaps the placeholder for its iframe: a plain DOM node
        // React never renders.
        const placeholder = document.createElement('div');
        placeholder.id = `oo-viewer-${++placeholderSeq}`;
        host.appendChild(placeholder);
        viewer = new window.DocsAPI.DocEditor(placeholder.id, {
          ...opening.config,
          events: { onRequestClose: () => closeRef.current?.() },
        });
        setState({ phase: 'ready' });
      } catch (e) {
        if (cancelled) return;
        setState({
          phase: 'error',
          failure: e instanceof EditorOpenError
            ? { message: e.message, code: e.code, status: e.status }
            : { message: e instanceof Error ? e.message : "Couldn't open the viewer" },
        });
      }
    })();
    return () => {
      cancelled = true;
      try { viewer?.destroyEditor?.(); } catch { /* already gone */ }
      if (host) host.replaceChildren();
    };
  }, []);

  return (
    <div className={`relative ${className}`} data-testid={testId}>
      <div ref={hostRef} className="absolute inset-0" data-testid={`${testId}-host`} />
      {state.phase === 'loading' && (
        <div className="absolute inset-0 flex items-center justify-center text-sm text-ink-soft" data-testid={`${testId}-loading`}>
          Opening the viewer…
        </div>
      )}
      {state.phase === 'error' && <div className="absolute inset-0 overflow-auto">{renderError(state.failure)}</div>}
    </div>
  );
};
