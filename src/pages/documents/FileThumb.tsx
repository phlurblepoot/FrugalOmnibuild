// src/pages/documents/FileThumb.tsx — a small picture of a file in the
// Documents list (ONLYOFFICE Phase 4), falling back to the type icon:
//
//   * Documents: page one. The server makes these with ONLYOFFICE in the
//     background, so the first ask may answer "not ready yet" (202): this
//     waits and asks again a few times before settling for the icon.
//     Remembered for the session per file version, so a list refresh or a
//     remount doesn't ask again.
//   * Photos: the photo shrunk (/api/images/:id/thumb), a plain <img> the
//     browser caches.
//
// Loaded only once the row scrolls into view.
import React, { useEffect, useRef, useState } from 'react';
import { getAuthHeaders, getImageThumbUrl } from '../../utils/store';
import { officeFormatOf } from '../../utils/officeFormats';
import { hasPhotoThumbnail } from '../../utils/photoFormats';
import { MimeIcon } from './MimeIcon';

interface ThumbRow { id: string; mime: string; name: string | null; versionNumber: number; createdAt: number }

const RETRY_MS = 4000;
const MAX_TRIES = 6;

/** url = a blob: URL of the PNG; null = none (use the icon). */
const known = new Map<string, string | null>();
const inFlight = new Map<string, Promise<string | null>>();
const versionKey = (row: ThumbRow) => `${row.id}:${row.versionNumber}:${row.createdAt}`;

/** Test hook: forget everything remembered. */
export const resetThumbnailCache = () => { known.clear(); inFlight.clear(); };

async function fetchThumbnail(row: ThumbRow, sleep: (ms: number) => Promise<void>): Promise<string | null> {
  const url = `/api/onlyoffice/thumbnail/${encodeURIComponent(row.id)}?v=${row.versionNumber}-${row.createdAt}`;
  for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
    let res: Response;
    try { res = await fetch(url, { headers: { ...getAuthHeaders() } }); } catch { return null; }
    if (res.status === 200) {
      try { return URL.createObjectURL(await res.blob()); } catch { return null; }
    }
    if (res.status !== 202) return null;
    await sleep(RETRY_MS);
  }
  return null;
}

/** The thumbnail for a row, once it is (or has been) visible. */
export function useThumbnail(row: ThumbRow, visible: boolean, sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))): string | null {
  const eligible = !!officeFormatOf(row);
  const key = versionKey(row);
  const [url, setUrl] = useState<string | null>(() => known.get(key) ?? null);
  useEffect(() => {
    if (!eligible || !visible) return;
    if (known.has(key)) { setUrl(known.get(key) ?? null); return; }
    let live = true;
    let pending = inFlight.get(key);
    if (!pending) {
      pending = fetchThumbnail(row, sleep).then(u => { known.set(key, u); inFlight.delete(key); return u; });
      inFlight.set(key, pending);
    }
    void pending.then(u => { if (live) setUrl(u); });
    return () => { live = false; };
    // row fields are captured through `key`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, eligible, visible]);
  return eligible ? url : null;
}

/** Whether an element has come into view (true straight away where the
 *  browser can't tell). */
function useSeen<T extends Element>(): [React.RefObject<T | null>, boolean] {
  const ref = useRef<T | null>(null);
  const [seen, setSeen] = useState(() => typeof IntersectionObserver === 'undefined');
  useEffect(() => {
    if (seen || !ref.current || typeof IntersectionObserver === 'undefined') return;
    const io = new IntersectionObserver(entries => {
      if (entries.some(e => e.isIntersecting)) { setSeen(true); io.disconnect(); }
    }, { rootMargin: '200px' });
    io.observe(ref.current);
    return () => io.disconnect();
  }, [seen]);
  return [ref, seen];
}

/** A photo's shrunk picture, versioned so new content isn't hidden by the
 *  browser's cache; null when the row isn't a photo the server can shrink. */
export const photoThumbUrl = (row: ThumbRow): string | null =>
  hasPhotoThumbnail(row) ? getImageThumbUrl(row.id, `${row.versionNumber}-${row.createdAt}`) : null;

/** A row's thumbnail, or its type icon. `box` sizes the thumbnail frame. */
export const FileThumb: React.FC<{ row: ThumbRow; box?: string; iconSize?: number }> = ({
  row, box = 'h-9 w-7', iconSize = 15,
}) => {
  const [ref, seen] = useSeen<HTMLSpanElement>();
  const officeUrl = useThumbnail(row, seen);
  const photoUrl = photoThumbUrl(row);
  const [photoFailed, setPhotoFailed] = useState<string | null>(null);
  const url = officeUrl ?? (seen && photoUrl && photoFailed !== photoUrl ? photoUrl : null);
  if (!url) {
    return <span ref={ref} className="inline-flex shrink-0"><MimeIcon mime={row.mime} size={iconSize} /></span>;
  }
  if (url === photoUrl) {
    // A photo fills its frame, cropped, like the photo tiles elsewhere.
    return (
      <span ref={ref} className={`inline-flex shrink-0 overflow-hidden rounded-sm border border-edge bg-sunken ${box}`} data-testid="file-thumb">
        <img src={url} alt="" loading="lazy" className="h-full w-full object-cover" onError={() => setPhotoFailed(url)} />
      </span>
    );
  }
  return (
    <span ref={ref} className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-sm border border-edge bg-white ${box}`} data-testid="file-thumb">
      <img src={url} alt="" className="max-h-full max-w-full object-contain" />
    </span>
  );
};
