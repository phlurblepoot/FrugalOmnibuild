// src/pages/documents/DocumentHoverPreview.tsx
// Cursor-following preview card for a hovered Documents row
// (docs/superpowers/specs/2026-08-17-document-previews-design.md §Components).
// Portal-rendered so it escapes the table's overflow container, and
// pointer-events-none so it can never sit between the cursor and the row it's
// describing.
//
// The card is mounted the moment a row is hovered but does NOTHING for
// HOVER_DELAY_MS — no fetch, no pdf.js work, no visible card. Skimming the
// pointer down a list therefore costs zero network. DocumentsTable only
// renders this on pointers that actually hover (matchMedia '(hover: hover)'),
// so touch devices never reach any of it.
import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DocumentRow, formatBytes } from '../../utils/store';
import { CustomDocType, kindLabel } from './docTypes';
import { MimeIcon } from './MimeIcon';
import { useThumbnail } from './FileThumb';
import { HOVER_PDF_SIZE_CAP, Thumb, getPreviewThumb, makeGenerationGuard, previewKindFor } from './previewEngine';
import { hoverCardPosition } from './previewPosition';

// Continuous hover required before any work happens (spec: "~350ms").
export const HOVER_DELAY_MS = 350;

const CARD_WIDTH = 220;

export const DocumentHoverPreview: React.FC<{
  row: DocumentRow;
  /** Pointer position when the row was entered — used until the first move. */
  startX: number;
  startY: number;
  customTypes: CustomDocType[];
  /** Asks the owner to unmount the card (scroll / right-click / press). */
  onHide: () => void;
  /**
   * Stacking context for the portalled card. Defaults to the Documents-page
   * value; a caller that renders the card inside a Modal (overlay z-[250])
   * must pass something higher or the card is painted behind the modal.
   */
  zIndexClass?: string;
}> = ({ row, startX, startY, customTypes, onHide, zIndexClass = 'z-[240]' }) => {
  const [cursor, setCursor] = useState({ x: startX, y: startY });
  const [shown, setShown] = useState(false);
  const [thumb, setThumb] = useState<Thumb | null>(null);
  const [size, setSize] = useState({ width: CARD_WIDTH, height: 0 });
  const cardRef = useRef<HTMLDivElement>(null);

  // One guard for the component's whole lifetime: every hover session (row
  // change, and the cleanup that runs on unmount) takes a fresh ticket, so a
  // thumb that resolves after the pointer has moved on fails isCurrent() and
  // is dropped instead of flashing under a different row's cursor.
  const guardRef = useRef(makeGenerationGuard());

  useEffect(() => {
    const guard = guardRef.current;
    const gen = guard.next();
    setShown(false);
    setThumb(null);
    const timer = setTimeout(() => {
      if (!guard.isCurrent(gen)) return;
      setShown(true);
      getPreviewThumb(row, { forHover: true })
        .then(res => { if (guard.isCurrent(gen)) setThumb(res); })
        .catch(() => { if (guard.isCurrent(gen)) setThumb({ kind: 'icon' }); });
    }, HOVER_DELAY_MS);
    return () => {
      clearTimeout(timer);
      // Invalidates this session's ticket — covers both "pointer moved to
      // another row" (this effect re-runs) and unmount.
      guard.next();
    };
  }, [row.id, row.versionNumber]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onMove = (e: MouseEvent) => setCursor({ x: e.clientX, y: e.clientY });
    window.addEventListener('mousemove', onMove);
    return () => window.removeEventListener('mousemove', onMove);
  }, []);

  // Anything that changes what's under the cursor kills the card. Mouse-leave
  // is handled by the row itself (it unmounts us); these are the cases the row
  // never sees. Capture phase so a scroll inside any container counts.
  //
  // MOUSEDOWN, not click, for the press case. A checkbox's `checked` is
  // toggled by the browser BEFORE the click event is dispatched, so a
  // capture-phase click listener that schedules a React render runs while the
  // DOM is already toggled: the render flushes in the microtask checkpoint
  // between listeners and re-applies the controlled `checked={false}`, so
  // React's own onChange plugin — which reads the toggled value later, at the
  // root — sees no change and swallows the click. Users saw checkboxes in the
  // file picker needing 1-3 clicks. mousedown fires before the toggle, so the
  // render lands first and onChange sees the change (proved by
  // e2e/file-picker.spec.ts, which fails on `click`).
  useEffect(() => {
    window.addEventListener('scroll', onHide, true);
    window.addEventListener('contextmenu', onHide, true);
    window.addEventListener('mousedown', onHide, true);
    return () => {
      window.removeEventListener('scroll', onHide, true);
      window.removeEventListener('contextmenu', onHide, true);
      window.removeEventListener('mousedown', onHide, true);
    };
  }, [onHide]);

  // Measure after paint and only when it actually changed, so position can be
  // computed during render (no extra render per mousemove).
  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    setSize(prev => (
      Math.abs(prev.width - rect.width) < 1 && Math.abs(prev.height - rect.height) < 1
        ? prev
        : { width: rect.width, height: rect.height }
    ));
  });

  // Word, Excel and the like: page one as ONLYOFFICE rendered it (Phase 4).
  const officeThumb = useThumbnail(row, thumb !== null && thumb.kind !== 'image' && thumb.kind !== 'canvas');

  if (!shown) return null;

  const { left, top } = hoverCardPosition(
    cursor,
    size,
    { width: window.innerWidth, height: window.innerHeight },
  );

  // Only a hover-capped pdf gets the "Open to preview" hint — a spreadsheet or
  // an unknown type has no bigger preview to promise.
  const capped = previewKindFor(row.mime) === 'pdf' && row.size > HOVER_PDF_SIZE_CAP;

  return createPortal(
    <div
      ref={cardRef}
      data-testid="doc-hover-preview"
      className={`pointer-events-none fixed ${zIndexClass} w-[220px] overflow-hidden rounded-xl border border-edge bg-raised shadow-xl`}
      style={{ left, top }}
    >
      <div className="flex min-h-[110px] items-center justify-center bg-sunken p-2">
        {thumb === null ? (
          <div className="h-[94px] w-full animate-pulse rounded-md bg-edge/60" />
        ) : thumb.kind === 'image' ? (
          <img src={thumb.url} alt="" className="max-h-40 w-full object-contain" />
        ) : thumb.kind === 'canvas' ? (
          <img src={thumb.dataUrl} alt="" className="max-h-40 w-full object-contain" />
        ) : officeThumb ? (
          <img src={officeThumb} alt="" className="max-h-40 w-full bg-white object-contain" data-testid="hover-office-thumb" />
        ) : (
          <div className="flex flex-col items-center gap-1 py-4 text-ink-faint">
            <MimeIcon mime={row.mime} size={28} className="text-ink-faint" />
            {capped && <span className="text-[11px]">Open to preview</span>}
          </div>
        )}
      </div>
      <div className="border-t border-edge px-2.5 py-1.5">
        <p className="truncate text-xs font-medium text-ink">{row.name ?? row.id}</p>
        <p className="truncate text-[11px] text-ink-faint">
          {formatBytes(row.size)} · {kindLabel(row.kind, customTypes)}
        </p>
      </div>
    </div>,
    document.body,
  );
};
