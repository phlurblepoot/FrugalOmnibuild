import React, { useState, useRef, useEffect } from 'react';
import { ArrowLeft, FileText, Loader2, Check, Eye, Hash, Search, ZoomIn, ZoomOut, Maximize, X, AlertTriangle, Sparkles, RefreshCw } from 'lucide-react';
import { createWorker } from 'tesseract.js';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
// @ts-ignore
import pdfWorker from 'pdfjs-dist/legacy/build/pdf.worker.mjs?url';
import { buildOcrCrop, buildRegionCrop, ocrParamsFor, cleanSheetNumber, cleanDescriptionText } from '../utils/pdf';
import { reconcileExtract } from '../utils/extractMatch';
import { findDuplicatePageNumbers, suffixPageNumber, composePageName } from '../utils/sheetNaming';
import { getImageUrl } from '../utils/store';
import { AiScanProgress, getAiStatus, warmupAi, getAiIdleTimeoutMs, transcribeRegion } from '../utils/aiSheets';
import { PdfPagePreview } from './PdfPagePreview';
import { useToast } from './Toast';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorker;

// Pulls embedded text items out of a rectangular region of a PDF page,
// returning each overlapping text-layer string separately. Coordinates are
// scaled into the same 2.0× viewport space the user's selection rectangle
// lives in (the rectangle is stored as 0–100 percentages of the displayed
// image, and our PdfPagePreview renders at scale=2.0). Any text item whose
// bounding box overlaps the region is included in document order. Returns an
// empty array when the region has no embedded text — the caller falls back to
// OCR for image-only content (scanned drawings, vector-art labels that aren't
// real text). These per-item strings are the `rawCandidates` fed to the hybrid
// reconciler (OCR disambiguates which candidate to trust).
async function extractTextItemsFromVectorRegion(
  page: any,
  region: { x: number; y: number; width: number; height: number },
): Promise<string[]> {
  const viewport = page.getViewport({ scale: 2.0 });
  const regionLeft = (region.x / 100) * viewport.width;
  const regionTop = (region.y / 100) * viewport.height;
  const regionRight = regionLeft + (region.width / 100) * viewport.width;
  const regionBottom = regionTop + (region.height / 100) * viewport.height;

  const textContent = await page.getTextContent();
  const matched: string[] = [];
  for (const item of textContent.items as any[]) {
    const str: string = (item.str ?? '').trim();
    if (!str) continue;
    const tx = item.transform?.[4] ?? 0;
    const ty = item.transform?.[5] ?? 0;
    const w = item.width ?? 0;
    // height isn't always populated; fall back to the transform's d component
    // (font size for non-rotated text) which pdf.js always sets.
    const h = item.height || Math.abs(item.transform?.[3] ?? item.transform?.[0] ?? 12);

    // Text baseline lives at (tx, ty) in PDF coords (Y-up). Glyph top is at
    // ty + h. convertToViewportPoint handles page rotation + Y-flip into
    // screen-space coords, so we just take min/max afterwards.
    const [vx0, vy0] = viewport.convertToViewportPoint(tx, ty);
    const [vx1, vy1] = viewport.convertToViewportPoint(tx + w, ty + h);
    const itemLeft = Math.min(vx0, vx1);
    const itemRight = Math.max(vx0, vx1);
    const itemTop = Math.min(vy0, vy1);
    const itemBottom = Math.max(vy0, vy1);

    // Any overlap counts as inside — the user's selection rectangle is loose
    // by nature, and a strict containment test rejects items that protrude a
    // pixel or two beyond the box.
    if (itemRight < regionLeft || itemLeft > regionRight) continue;
    if (itemBottom < regionTop || itemTop > regionBottom) continue;
    matched.push(str);
  }
  return matched;
}

// Render a vector PDF page to a JPEG data URL for OCR. The region crop is taken
// from this full-resolution render so the OCR read is accurate (used by the
// hybrid reconcile alongside the embedded text-layer candidates).
async function renderPdfPageToDataUrl(page: any): Promise<string> {
  const viewport = page.getViewport({ scale: 2.0 });
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(viewport.width);
  canvas.height = Math.round(viewport.height);
  const ctx = canvas.getContext('2d')!;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, viewport } as any).promise;
  const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
  // Drop the canvas backing store explicitly so a multi-page "extract all"
  // doesn't accumulate ~10 MB per page until GC catches up.
  canvas.width = 0;
  canvas.height = 0;
  return dataUrl;
}

// Shared "name pages" UI used by both the new-project upload flow and the
// add-pages-to-existing-project flow. Owns the preview modal, OCR-region
// drawing, and the Tesseract worker pipeline so the two callers don't end up
// with subtly diverging copies (we hit a bug from exactly that — see commit
// b2ce92d). The caller wraps this component in whatever outer container it
// needs (full page vs. nested in a modal) and supplies the storage handles
// for `pendingPages`.

export interface NamingStepPage {
  id: string;
  name: string;
  pageNumber?: string;
  description?: string;
  imageId: string;
  thumbnailId: string;
  imageWidth: number;
  imageHeight: number;
  sourcePdfFileId?: string;
  sourcePdfPageNum?: number;
  extractedText?: string;
  /** Confidence of the manual Extract tool's read for this row (hybrid
   *  raw-text+OCR reconcile, or the AI region-read when that engine is
   *  selected). 'low' means the extract ran but couldn't confidently resolve
   *  a value — distinct from a FAILED AI read (network/model unavailable),
   *  which leaves this field untouched entirely. The review UI flags 'low'
   *  rows as needing a second look. */
  extractConfidence?: 'high' | 'low';
  /** Confidence signal driving the "needs review" badge before (or instead
   *  of) a manual Extract run. 'low' = the page still carries its import-time
   *  placeholder number (e.g. "1", "2") and hasn't been confirmed — either by
   *  editing the field directly (`updateField` bumps this to 'high') or by a
   *  confident extraction. 'high' = user-confirmed or confidently read. */
  detectionConfidence?: 'high' | 'low';
  /** Revision Review match: the durable sheetId this incoming page is a revision
   *  of (reuses that sheet's id + carries its measurements forward on commit).
   *  Empty / undefined = a brand-new sheet (fresh sheetId, starts empty). The
   *  add-pages caller seeds this from page-number auto-match; the user can
   *  change it via the per-row match dropdown. Only meaningful when the review
   *  UI is enabled (existingSheets provided). */
  matchSheetId?: string;
  /** Confidence 0..1 from the local AI read, when the page was AI-named. Drives
   *  the "AI" badge + tooltip in the review grid; absent for OCR/heuristic names. */
  aiConfidence?: number;
}

/** One existing logical sheet the incoming pages can be matched against in the
 *  Revision Review step. `pageNumber` is the sheet's CURRENT (living) revision's
 *  page number, used for both the auto-match and the dropdown label. */
export interface ExistingSheet {
  sheetId: string;
  pageNumber: string;
}

export interface PageNamingStepProps {
  pendingPages: NamingStepPage[];
  setPendingPages: (pages: NamingStepPage[]) => void;
  pendingThumbnails: Record<string, string>;

  onConfirm: () => void | Promise<void>;
  confirmLabel?: string;
  confirmIcon?: React.ReactNode;
  isConfirming?: boolean;

  title?: string;
  subtitle?: string;

  /** When provided, enables the add-set "Revision Review" step: a per-row match
   *  dropdown (Revision of {sheet} / New sheet), within-set duplicate blocking
   *  with a one-click Suffix fix, and a "needs review" flag on low-confidence
   *  rows. Omitted by the new-project upload + the rename-existing-pages flow,
   *  which render the simpler naming grid. */
  existingSheets?: ExistingSheet[];
  /** Plan set the incoming pages belong to — scopes the within-set duplicate
   *  check (the same page number across sets is a revision, not a duplicate). */
  planSetId?: string;
  /** When provided, shows an "AI Scan" button that re-runs local AI reading on
   *  every page (used to invoke it manually, e.g. if the model wasn't ready at
   *  upload time). The parent owns the images/status and mutates pendingPages.
   *  The reporter callback receives loading/scanning/done progress updates. */
  onAiScan?: (report: (p: AiScanProgress) => void) => Promise<void>;
}

export const PageNamingStep: React.FC<PageNamingStepProps> = ({
  pendingPages,
  setPendingPages,
  pendingThumbnails,
  onConfirm,
  confirmLabel = 'Finish',
  confirmIcon,
  isConfirming = false,
  title = 'Name Pages',
  subtitle = 'Review and rename the imported pages.',
  existingSheets,
  planSetId,
  onAiScan,
}) => {
  const { toast } = useToast();
  // ── Internal UI state — none of this leaks to the parent ─────────────────
  const [aiScanning, setAiScanning] = useState(false);
  const [aiScanProgress, setAiScanProgress] = useState<AiScanProgress | null>(null);
  const [previewPageId, setPreviewPageId] = useState<string | null>(null);
  const [previewImageSrc, setPreviewImageSrc] = useState<string | null>(null);
  const [extractionType, setExtractionType] = useState<'pageNumber' | 'description' | null>(null);
  const [extractionRect, setExtractionRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [selectionStart, setSelectionStart] = useState<{ x: number; y: number } | null>(null);
  const [interactionMode, setInteractionMode] = useState<'draw' | 'move' | 'resize-nw' | 'resize-ne' | 'resize-sw' | 'resize-se' | null>(null);
  const [initialRect, setInitialRect] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  const [isExtracting, setIsExtracting] = useState(false);
  // Per-page extract confidence from the hybrid reconcile (raw text + OCR),
  // keyed by page id. 'low' rows are flagged for review in Task 7's UI.
  const [extractConfidence, setExtractConfidence] = useState<Record<string, 'high' | 'low'>>({});
  // Extract tool engine: 'text' is the existing hybrid raw-text+OCR reconcile;
  // 'ai' sends the cropped region to the local vision model instead. Disabled
  // in the UI until the AI status check below confirms it's available.
  const [extractEngine, setExtractEngine] = useState<'text' | 'ai'>('text');
  const [aiEngineAvailable, setAiEngineAvailable] = useState(false);
  // Lightweight progress for "Extract All Pages" — both engines update it, but
  // it matters most for the AI engine where each page costs a model inference.
  const [extractProgress, setExtractProgress] = useState<{ done: number; total: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [panOffset, setPanOffset] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState<{ x: number; y: number } | null>(null);

  const imageContainerRef = useRef<HTMLDivElement>(null);

  // ── Field editing ─────────────────────────────────────────────────────────
  // Updates one field on one page, auto-syncing the displayed name from
  // pageNumber + description. Identical logic was previously inlined in both
  // callers — now lives here so they can't drift.
  // Review mode is active only when the caller supplies the existing sheets to
  // match against (the add-set flow). The new-project upload + rename flows
  // leave it off and render the plain naming grid.
  const reviewMode = !!existingSheets;

  // Auto-match an incoming page number against an existing sheet's CURRENT page
  // number (case-insensitive). Returns that sheet's durable sheetId, or '' for
  // "New sheet" when nothing matches.
  const autoMatch = (pageNumber: string): string => {
    const n = (pageNumber || '').trim().toLowerCase();
    if (!n || !existingSheets) return '';
    const hit = existingSheets.find(s => (s.pageNumber || '').trim().toLowerCase() === n);
    return hit ? hit.sheetId : '';
  };

  const updateField = (id: string, field: keyof NamingStepPage, value: string) => {
    setPendingPages(pendingPages.map(p => {
      if (p.id !== id) return p;
      const updated: NamingStepPage = { ...p, [field]: value } as NamingStepPage;
      if (field === 'pageNumber' || field === 'description') {
        const num = field === 'pageNumber' ? value : (p.pageNumber || '');
        const desc = field === 'description' ? value : (p.description || '');
        updated.name = composePageName(num, desc, p.name);
        // A manual edit is the user confirming this row — clear the "needs
        // review" signal so the amber badge doesn't linger on a row they've
        // already looked at.
        updated.detectionConfidence = 'high';
      }
      // Editing the page number re-runs the match (the duplicate check is derived
      // live from pendingPages, so it recomputes automatically on render).
      if (reviewMode && field === 'pageNumber') {
        updated.matchSheetId = autoMatch(value);
      }
      return updated;
    }));
  };

  // Re-run the page-number auto-match for EVERY page against its CURRENT page
  // number. Useful after correcting numbers (e.g. via AI Scan): the initial
  // auto-match ran on the original, often-wrong numbers, so matches go stale.
  const rematchAll = () => {
    setPendingPages(pendingPages.map(p => ({ ...p, matchSheetId: autoMatch(p.pageNumber || '') })));
    toast('Re-matched pages to sheets by their current page number.', { type: 'success' });
  };

  // Explicit match-dropdown change: '' = New sheet, otherwise a target sheetId.
  const setMatch = (id: string, sheetId: string) => {
    setPendingPages(pendingPages.map(p => (p.id === id ? { ...p, matchSheetId: sheetId } : p)));
  };

  // Apply a free " (n)" suffix to one row's page number, scoped to the page
  // numbers already taken within this in-progress set (so the new value can't
  // collide with another incoming row either).
  const handleSuffixRow = (id: string) => {
    const row = pendingPages.find(p => p.id === id);
    if (!row) return;
    const base = (row.pageNumber || '').trim();
    if (!base) return;
    const taken = new Set(
      pendingPages
        .filter(p => p.id !== id && p.pageNumber?.trim())
        .map(p => p.pageNumber!.trim().toLowerCase()),
    );
    updateField(id, 'pageNumber', suffixPageNumber(base, taken));
  };

  // ── Review-step derived state ─────────────────────────────────────────────
  // Within-set duplicate page numbers (blank exempt) block Commit until fixed.
  const duplicateIds = reviewMode
    ? new Set(findDuplicatePageNumbers(pendingPages.map(p => ({ id: p.id, planSetId, pageNumber: p.pageNumber }))))
    : new Set<string>();
  const hasDuplicates = duplicateIds.size > 0;
  // A row "needs review" when its best available confidence signal is low — the
  // live Extract result if the user ran it, else the import-time detection.
  const rowNeedsReview = (p: NamingStepPage): boolean => {
    const c = extractConfidence[p.id] ?? p.extractConfidence ?? p.detectionConfidence;
    return c === 'low';
  };
  // Needs-review is a signal for every naming flow, not just the add-set
  // review step — a fresh upload's placeholder page numbers ("1", "2", …)
  // are just as unconfirmed as a low-confidence AI/OCR read.
  const needsReviewCount = pendingPages.filter(rowNeedsReview).length;

  // One-time auto-match seed: when the review step opens, preselect "Revision of
  // {sheet}" for any incoming page whose number matches an existing sheet's
  // current page number. Pages whose match hasn't been resolved yet carry an
  // undefined matchSheetId; once seeded it's an explicit '' (New sheet) or a
  // sheetId, so the user's later edits are never overwritten.
  useEffect(() => {
    if (!reviewMode) return;
    const unseeded = pendingPages.filter(p => p.matchSheetId === undefined);
    if (unseeded.length === 0) return;
    setPendingPages(
      pendingPages.map(p => (p.matchSheetId === undefined ? { ...p, matchSheetId: autoMatch(p.pageNumber || '') } : p)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reviewMode, pendingPages]);

  // Check AI availability each time the preview modal opens — the toggle
  // should reflect the current server state, not a stale check from earlier
  // in the session (the model may have been loaded/unloaded meanwhile).
  useEffect(() => {
    if (!previewPageId) return;
    getAiStatus().then(s => setAiEngineAvailable(!!s.available)).catch(() => setAiEngineAvailable(false));
  }, [previewPageId]);

  const closePreview = () => {
    setPreviewPageId(null);
    setExtractionRect(null);
    setExtractionType(null);
    setIsSelecting(false);
    setInteractionMode(null);
    setZoom(1);
    setPanOffset({ x: 0, y: 0 });
  };

  // ── Extraction ────────────────────────────────────────────────────────────
  // Hybrid reconcile, per page: ALWAYS gather BOTH the embedded text-layer
  // candidates (the individual overlapping strings in the region) AND an OCR
  // read of the same region crop, then reconcile them via `reconcileExtract`:
  //   • Raw candidates carry the exact characters CAD wrote ("A5.0" not the OCR
  //     misread "AS.0"); OCR disambiguates which candidate the region actually
  //     contains and supplies the value when there's no embedded text at all
  //     (scanned drawings, vector-art labels, legacy raster pages with no
  //     source PDF — rawCandidates = [], reconcile falls back to OCR).
  //   • The reconcile returns a confidence: 'high' when raw + OCR agree (or a
  //     single obvious raw candidate), 'low' when it had to lean on OCR alone.
  //     We store the confidence per page so Task 7's review UI can flag it.
  // For vector pages we render the page to a full-resolution JPEG on demand so
  // the OCR crop is sharp — fixes "extract all pages" producing gibberish on
  // non-previewed pages, which were previously cropped from the 400px thumbnail.
  const handleExtractText = async (applyToAll: boolean) => {
    if (!previewPageId || !extractionRect || !extractionType) return;
    const previewedPage = pendingPages.find(p => p.id === previewPageId);
    if (!previewedPage) return;

    const mode = extractionType;
    const region = { ...extractionRect };
    const cleanValue = (t: string) =>
      mode === 'pageNumber' ? cleanSheetNumber(t) : cleanDescriptionText(t);

    setIsExtracting(true);

    // Cache PDF proxies + per-page render data URLs so a multi-page extract
    // doesn't reload the same file (or re-render the same page) repeatedly.
    const proxyCache = new Map<string, any>();
    const renderCache = new Map<string, string>(); // key: `${fileId}#${pageNum}`
    const getProxy = async (fileId: string) => {
      let p = proxyCache.get(fileId);
      if (!p) {
        p = await pdfjsLib.getDocument({ url: getImageUrl(fileId) }).promise;
        proxyCache.set(fileId, p);
      }
      return p;
    };

    // Lazy Tesseract worker: many extracts hit the vector path and never
    // need this, so we don't pay the worker-startup tax up front.
    let worker: Awaited<ReturnType<typeof createWorker>> | null = null;
    const getWorker = async () => {
      if (worker) return worker;
      worker = await createWorker('eng', 1, {
        langPath: 'https://tessdata.projectnaptha.com/4.0.0_best',
      });
      await worker.setParameters(ocrParamsFor(mode));
      return worker;
    };

    // Accumulate confidence updates so a multi-page "extract all" writes state once.
    const confidenceUpdates: Record<string, 'high' | 'low'> = {};

    // Resolve a single full-resolution image source for a page: cached
    // source-PDF render → loaded preview src → stored image → thumbnail.
    // Shared by the Text/OCR reconcile path AND the AI region-read path so
    // the two engines never diverge on which pixels they're reading.
    const getPageRenderSrc = async (p: NamingStepPage): Promise<string> => {
      if (p.sourcePdfFileId && p.sourcePdfPageNum) {
        try {
          const proxy = await getProxy(p.sourcePdfFileId);
          const pdfPage = await proxy.getPage(p.sourcePdfPageNum);
          const cacheKey = `${p.sourcePdfFileId}#${p.sourcePdfPageNum}`;
          let rendered = renderCache.get(cacheKey);
          if (!rendered) {
            rendered = await renderPdfPageToDataUrl(pdfPage);
            renderCache.set(cacheKey, rendered);
          }
          return rendered;
        } catch (err) {
          console.warn('Source PDF render failed; falling back to stored image', err);
        }
      }
      return (
        p.id === previewPageId && previewImageSrc
          ? previewImageSrc
          : p.imageId
          ? getImageUrl(p.imageId)
          : pendingThumbnails[p.thumbnailId]
      ) || '';
    };

    try {
      // Resolved once per extract run rather than per page — the setting is
      // static for the duration of the run, and "extract all" over dozens of
      // pages shouldn't pay a settings round-trip for each one.
      const aiIdleTimeoutMs = extractEngine === 'ai' ? await getAiIdleTimeoutMs() : undefined;

      // Always gather BOTH raw text-layer candidates AND an OCR read, then
      // reconcile. Returns the cleaned value + a confidence flag for the row.
      // When the AI engine is selected, skip straight to a vision-model read
      // of the same region crop instead. `failed: true` marks a read that
      // came back null (network error, model unavailable, timeout) or threw —
      // distinct from "the model read the crop and found nothing" — so
      // callers leave the row's existing value/match/confidence untouched
      // instead of overwriting them with a blank.
      const recognizePage = async (p: NamingStepPage): Promise<{ value: string; confidence: 'high' | 'low'; failed?: true }> => {
        if (extractEngine === 'ai') {
          try {
            const src = await getPageRenderSrc(p);
            const crop = await buildRegionCrop(src, region);
            const result = await transcribeRegion({
              imageBase64: crop,
              mode: mode === 'pageNumber' ? 'number' : 'description',
              idleTimeoutMs: aiIdleTimeoutMs,
            });
            if (!result) return { value: '', confidence: 'low', failed: true };
            const cleaned = cleanValue(result.text ?? '');
            return { value: cleaned, confidence: (result.confidence >= 0.5 && cleaned) ? 'high' : 'low' };
          } catch (err) {
            console.warn('AI region read failed', err);
            return { value: '', confidence: 'low', failed: true };
          }
        }

        let rawCandidates: string[] = [];
        // Vector page: pull the per-item embedded strings as raw candidates.
        if (p.sourcePdfFileId && p.sourcePdfPageNum) {
          try {
            const proxy = await getProxy(p.sourcePdfFileId);
            const pdfPage = await proxy.getPage(p.sourcePdfPageNum);
            rawCandidates = await extractTextItemsFromVectorRegion(pdfPage, region);
          } catch (err) {
            console.warn('Vector text extract failed', err);
          }
        }

        let ocrText = '';
        try {
          const srcUrl = await getPageRenderSrc(p);
          if (srcUrl) {
            const cropUrl = await buildOcrCrop(srcUrl, region);
            const w = await getWorker();
            const { data: { text } } = await w.recognize(cropUrl);
            ocrText = text || '';
          }
        } catch (err) {
          console.warn('OCR failed', err);
        }

        const { value, confidence } = reconcileExtract({ rawCandidates, ocrText });
        return { value: cleanValue(value), confidence };
      };

      if (applyToAll) {
        const updated = [...pendingPages];
        setExtractProgress({ done: 0, total: updated.length });
        let failCount = 0;
        for (let i = 0; i < updated.length; i++) {
          const result = await recognizePage(updated[i]);
          if (result.failed) {
            // Leave this row exactly as it was — old value, old matchSheetId
            // (recomputed below from the unchanged page number), old
            // extractConfidence — rather than silently blanking it.
            failCount++;
            setExtractProgress({ done: i + 1, total: updated.length });
            continue;
          }
          const { value, confidence } = result;
          const num = mode === 'pageNumber' ? value : (updated[i].pageNumber || '');
          const desc = mode === 'description' ? value : (updated[i].description || '');
          updated[i] = {
            ...updated[i],
            [mode]: value,
            extractConfidence: confidence,
            name: composePageName(num, desc, updated[i].name),
          };
          confidenceUpdates[updated[i].id] = confidence;
          setExtractProgress({ done: i + 1, total: updated.length });
        }
        // Extracted page numbers can change which existing sheet a row
        // matches — recompute in the same state update (same logic
        // updateField/rematchAll use) so matchSheetId doesn't go stale.
        // Failed rows keep their original (unchanged) page number, so
        // re-running autoMatch on them is a no-op that reproduces their
        // existing match rather than resetting it.
        if (reviewMode && mode === 'pageNumber') {
          for (let i = 0; i < updated.length; i++) {
            updated[i] = { ...updated[i], matchSheetId: autoMatch(updated[i].pageNumber || '') };
          }
        }
        setPendingPages(updated);
        if (failCount > 0) {
          toast(`AI could not read ${failCount} of ${updated.length} page(s)`, {
            type: failCount === updated.length ? 'error' : 'warning',
          });
        }
      } else {
        const result = await recognizePage(previewedPage);
        if (result.failed) {
          toast('AI read failed — is the AI model available?', { type: 'error' });
        } else {
          updateField(previewPageId, mode, result.value);
          confidenceUpdates[previewPageId] = result.confidence;
        }
      }

      if (Object.keys(confidenceUpdates).length) {
        setExtractConfidence(prev => ({ ...prev, ...confidenceUpdates }));
      }

      setExtractionRect(null);
      setExtractionType(null);
    } catch (error) {
      console.error('Extraction error:', error);
      toast('Failed to extract text. Please try again.', { type: 'error' });
    } finally {
      if (worker) {
        try { await worker.terminate(); } catch { /* noop */ }
      }
      for (const p of proxyCache.values()) {
        try { await p.destroy(); } catch { /* noop */ }
      }
      setIsExtracting(false);
      setExtractProgress(null);
    }
  };

  // ── Preview-modal pointer handling ────────────────────────────────────────
  // Coordinates inside the image container are normalised to 0–100 (percentages
  // of the displayed image bounds) so the resulting rect is independent of
  // zoom + pan and feeds straight into buildOcrCrop.
  const handleImageMouseDown = (e: React.MouseEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (zoom > 1 && !extractionType) {
      setIsPanning(true);
      setPanStart({ x: e.clientX - panOffset.x, y: e.clientY - panOffset.y });
      return;
    }
    if (!extractionType) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;
    setIsSelecting(true);
    setInteractionMode('draw');
    setSelectionStart({ x, y });
    setExtractionRect({ x, y, width: 0, height: 0 });
  };

  const handleImageMouseMove = (e: React.MouseEvent) => {
    if (isPanning && panStart) {
      setPanOffset({ x: e.clientX - panStart.x, y: e.clientY - panStart.y });
      return;
    }
    if (!isSelecting || !selectionStart || !imageContainerRef.current) return;
    const rect = imageContainerRef.current.getBoundingClientRect();
    const x = ((e.clientX - rect.left) / rect.width) * 100;
    const y = ((e.clientY - rect.top) / rect.height) * 100;

    if (interactionMode === 'draw') {
      const minX = Math.min(selectionStart.x, x);
      const minY = Math.min(selectionStart.y, y);
      const width = Math.abs(x - selectionStart.x);
      const height = Math.abs(y - selectionStart.y);
      setExtractionRect({ x: minX, y: minY, width, height });
    } else if (interactionMode === 'move' && initialRect) {
      const dx = (e.clientX - selectionStart.x) / rect.width * 100;
      const dy = (e.clientY - selectionStart.y) / rect.height * 100;
      setExtractionRect({
        x: Math.max(0, Math.min(100 - initialRect.width, initialRect.x + dx)),
        y: Math.max(0, Math.min(100 - initialRect.height, initialRect.y + dy)),
        width: initialRect.width,
        height: initialRect.height,
      });
    }
  };

  const handleImageMouseUp = () => {
    setIsSelecting(false);
    setIsPanning(false);
    setInteractionMode(null);
    setPanStart(null);
  };

  const handleZoomIn = () => setZoom(z => Math.min(5, z + 0.5));
  const handleZoomOut = () => {
    setZoom(z => {
      const next = Math.max(1, z - 0.5);
      if (next === 1) setPanOffset({ x: 0, y: 0 });
      return next;
    });
  };
  const handleResetZoom = () => {
    setZoom(1);
    setPanOffset({ x: 0, y: 0 });
  };

  const previewPage = previewPageId ? pendingPages.find(p => p.id === previewPageId) : null;
  const isAreaSelected = !!(extractionRect && extractionRect.width > 0 && extractionRect.height > 0);

  // ── Render ────────────────────────────────────────────────────────────────
  return (
    <>
      <div className="bg-raised rounded-2xl shadow-sm border border-edge overflow-hidden">
        <div className="p-4 sm:p-8 border-b border-edge flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4">
          <div>
            <h1 className="text-xl sm:text-2xl font-bold text-ink">{title}</h1>
            <p className="text-sm text-ink-soft mt-1">{subtitle}</p>
          </div>
          <div className="w-full sm:w-auto flex flex-col items-stretch sm:items-end gap-1.5">
            <div className="w-full sm:w-auto flex items-center gap-2">
              {reviewMode && (
                <button
                  type="button"
                  onClick={rematchAll}
                  disabled={aiScanning || isConfirming}
                  title="Re-check each page's revision match against its current page number"
                  className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl font-medium text-ink bg-sunken border border-edge hover:bg-hover disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                >
                  <RefreshCw size={18} /> Re-match by page #
                </button>
              )}
              {onAiScan && (
                <div className="flex flex-col items-end gap-1">
                  <button
                    type="button"
                    onClick={async () => {
                      setAiScanning(true);
                      setAiScanProgress(null);
                      try { await onAiScan(setAiScanProgress); }
                      finally { setAiScanning(false); setAiScanProgress(null); }
                    }}
                    disabled={aiScanning || isConfirming}
                    title="Read every page's number and description with the local AI"
                    className="flex items-center justify-center gap-2 px-4 py-3 rounded-xl font-medium text-accent-700 dark:text-accent-300 bg-accent-50 dark:bg-accent-900/30 border border-accent-200 dark:border-accent-800 hover:bg-accent-100 dark:hover:bg-accent-900/50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    {aiScanning ? <><Loader2 size={18} className="animate-spin" /> Scanning…</> : <><Sparkles size={18} /> AI Scan</>}
                  </button>
                  {aiScanning && aiScanProgress && (
                    <div className="text-xs text-ink-soft flex items-center gap-1.5 min-w-0">
                      {aiScanProgress.phase === 'loading' ? (
                        <>
                          <Loader2 size={12} className="animate-spin shrink-0" />
                          <span>Loading model…</span>
                          <span className="text-ink-faint">(first run ~30s)</span>
                        </>
                      ) : aiScanProgress.phase === 'scanning' && aiScanProgress.total !== undefined ? (
                        <>
                          <div className="w-24 h-1.5 bg-sunken rounded-full overflow-hidden">
                            <div
                              className="h-full bg-accent-500 rounded-full transition-all"
                              style={{ width: `${Math.round(((aiScanProgress.done ?? 0) / aiScanProgress.total) * 100)}%` }}
                            />
                          </div>
                          <span>{aiScanProgress.done ?? 0}/{aiScanProgress.total}</span>
                        </>
                      ) : null}
                    </div>
                  )}
                </div>
              )}
              <button
                onClick={onConfirm}
                disabled={isConfirming || hasDuplicates || aiScanning}
                className="w-full sm:w-auto flex items-center justify-center gap-2 px-6 py-3 rounded-xl font-medium text-white bg-accent-600 hover:bg-accent-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
              >
                {isConfirming ? (
                  <><Loader2 size={18} className="animate-spin" /> Saving...</>
                ) : (
                  <>{confirmIcon ?? <Check size={18} />} {confirmLabel}{needsReviewCount > 0 ? ` (${needsReviewCount} need review)` : ''}</>
                )}
              </button>
            </div>
            {reviewMode && hasDuplicates && (
              <p className="text-[11px] font-semibold text-red-600 dark:text-red-400 flex items-center gap-1">
                <AlertTriangle size={12} /> Resolve duplicate page numbers to continue
              </p>
            )}
            {!hasDuplicates && needsReviewCount > 0 && (
              <p className="text-[11px] text-amber-600 dark:text-amber-400 flex items-center gap-1">
                <AlertTriangle size={12} /> {needsReviewCount} row{needsReviewCount === 1 ? '' : 's'} flagged — double-check before committing
              </p>
            )}
          </div>
        </div>

        <div className="p-4 sm:p-8">
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 sm:gap-6">
            {pendingPages.map((page, index) => {
              // Look up under thumbnailId first (new uploads + the
              // add-pages-to-existing-project flow), then fall back to
              // imageId (the "rename existing pages" flow keys the dict
              // by the page's imageId because that's the stable ID it
              // already had on the project).
              const thumbSrc =
                pendingThumbnails[page.thumbnailId] || pendingThumbnails[page.imageId];
              const isDuplicate = duplicateIds.has(page.id);
              const needsReview = rowNeedsReview(page);
              const borderClass = isDuplicate
                ? 'border-red-400 dark:border-red-500'
                : needsReview
                ? 'border-amber-300 dark:border-amber-500/60'
                : 'border-edge';
              return (
              <div
                key={page.id}
                className={`bg-raised rounded-2xl border-2 ${borderClass} overflow-hidden flex flex-col shadow-sm hover:shadow-md transition-all duration-300`}
              >
                <div
                  className="h-48 bg-sunken relative flex-shrink-0 border-b border-edge cursor-pointer overflow-hidden group"
                  onClick={() => setPreviewPageId(page.id)}
                >
                  {thumbSrc ? (
                    <img
                      src={thumbSrc}
                      alt={`Page ${index + 1}`}
                      className="w-full h-full object-contain transition-transform duration-500 group-hover:scale-110"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-ink-faint">
                      <Loader2 size={32} className="animate-spin" />
                    </div>
                  )}

                  <div className="absolute inset-0 bg-accent-600/0 group-hover:bg-accent-600/40 transition-all duration-300 flex flex-col items-center justify-center gap-3">
                    <div className="w-12 h-12 rounded-full bg-white/20 backdrop-blur-md flex items-center justify-center text-white opacity-0 group-hover:opacity-100 scale-50 group-hover:scale-100 transition-all duration-300">
                      <Eye size={24} />
                    </div>
                    <span className="text-white text-[10px] font-black uppercase tracking-[0.2em] opacity-0 group-hover:opacity-100 transition-all duration-300 translate-y-2 group-hover:translate-y-0">
                      Click to Preview
                    </span>
                  </div>

                  <div className="absolute top-3 left-3 bg-white/90 backdrop-blur-md text-accent-600 text-[10px] font-black px-2.5 py-1.5 rounded-lg shadow-sm border border-accent-100">
                    PAGE {index + 1}
                  </div>
                  {page.aiConfidence !== undefined && (
                    <div
                      className="absolute bottom-3 left-3 bg-accent-600/90 backdrop-blur-md text-white text-[10px] font-black px-2.5 py-1.5 rounded-lg shadow-sm"
                      title={`Named by AI (${Math.round(page.aiConfidence * 100)}% confidence)`}
                    >
                      AI {Math.round(page.aiConfidence * 100)}%
                    </div>
                  )}
                  {needsReview && (
                    <div className="absolute top-3 right-3 bg-amber-500/90 backdrop-blur-md text-white text-[10px] font-black px-2.5 py-1.5 rounded-lg shadow-sm flex items-center gap-1">
                      <AlertTriangle size={11} /> NEEDS REVIEW
                    </div>
                  )}
                </div>

                <div className="p-5 space-y-5">
                  <div className="space-y-2">
                    <div className="flex items-center justify-between px-1">
                      <label className="text-[10px] font-black text-ink-faint uppercase tracking-widest">Page Number</label>
                      {page.pageNumber && !needsReview && <Check size={12} className="text-green-500" />}
                    </div>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-ink-faint">
                        <Hash size={14} />
                      </div>
                      <input
                        type="text"
                        value={page.pageNumber || ''}
                        onChange={(e) => updateField(page.id, 'pageNumber', e.target.value)}
                        className={`w-full pl-10 pr-4 py-3 rounded-xl border-2 bg-sunken focus:bg-raised focus:ring-4 focus:ring-accent-500/10 outline-none transition-all text-sm font-bold text-ink placeholder:text-ink-faint placeholder:font-normal ${
                          isDuplicate
                            ? 'border-red-400 focus:border-red-500 dark:border-red-500'
                            : 'border-edge focus:border-accent-500'
                        }`}
                        placeholder="e.g. A-101"
                      />
                    </div>
                    {reviewMode && isDuplicate && (
                      <div className="flex items-center justify-between gap-2 px-1">
                        <p className="text-[11px] font-semibold text-red-600 dark:text-red-400 flex items-center gap-1">
                          <AlertTriangle size={11} /> Duplicate in this set
                        </p>
                        <button
                          type="button"
                          onClick={() => handleSuffixRow(page.id)}
                          className="text-[11px] font-bold text-accent-600 dark:text-accent-400 hover:underline"
                        >
                          Suffix
                        </button>
                      </div>
                    )}
                  </div>

                  {reviewMode && (
                    <div className="space-y-2">
                      <div className="flex items-center justify-between px-1">
                        <label className="text-[10px] font-black text-ink-faint uppercase tracking-widest">Match</label>
                      </div>
                      <select
                        value={page.matchSheetId || ''}
                        onChange={(e) => setMatch(page.id, e.target.value)}
                        className="w-full px-3 py-2.5 rounded-xl border-2 border-edge bg-sunken focus:bg-raised focus:border-accent-500 focus:ring-4 focus:ring-accent-500/10 outline-none transition-all text-sm font-medium text-ink"
                      >
                        <option value="">New sheet</option>
                        {(existingSheets || []).map(s => (
                          <option key={s.sheetId} value={s.sheetId}>
                            Revision of {s.pageNumber || '(untitled sheet)'}
                          </option>
                        ))}
                      </select>
                      {page.matchSheetId ? (
                        <p className="text-[11px] text-amber-600 dark:text-amber-400 px-1">
                          Carries the current measurements + scale forward; the prior revision becomes read-only.
                        </p>
                      ) : (
                        <p className="text-[11px] text-ink-faint px-1">
                          Starts as a brand-new, empty sheet.
                        </p>
                      )}
                    </div>
                  )}

                  <div className="space-y-2">
                    <div className="flex items-center justify-between px-1">
                      <label className="text-[10px] font-black text-ink-faint uppercase tracking-widest">Description</label>
                      {page.description && <Check size={12} className="text-green-500" />}
                    </div>
                    <div className="relative">
                      <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none text-ink-faint">
                        <FileText size={14} />
                      </div>
                      <input
                        type="text"
                        value={page.description || ''}
                        onChange={(e) => updateField(page.id, 'description', e.target.value)}
                        className="w-full pl-10 pr-4 py-3 rounded-xl border-2 border-edge bg-sunken focus:bg-raised focus:border-accent-500 focus:ring-4 focus:ring-accent-500/10 outline-none transition-all text-sm text-ink placeholder:text-ink-faint"
                        placeholder="e.g. Floor Plan"
                      />
                    </div>
                  </div>
                </div>
              </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Preview modal ────────────────────────────────────────────────── */}
      {previewPageId && previewPage && (
        <div className="fixed inset-0 bg-black/70 backdrop-blur-sm z-50 flex items-center justify-center p-2 sm:p-4">
          <div className="bg-raised rounded-none sm:rounded-2xl shadow-2xl w-full max-w-5xl h-full flex flex-col overflow-hidden">
            <div className="p-3 sm:p-4 border-b border-edge flex justify-between items-center bg-sunken gap-2">
              <div className="flex items-center gap-2 sm:gap-4 min-w-0">
                <button onClick={closePreview} className="p-2 hover:bg-hover rounded-full transition-colors flex-shrink-0">
                  <ArrowLeft size={20} />
                </button>
                <h3 className="font-bold text-ink truncate">Page Preview &amp; Extraction</h3>
              </div>
              <div className="flex items-center gap-1 sm:gap-2">
                <div className="flex items-center bg-raised border border-edge rounded-lg p-1">
                  <button onClick={handleZoomOut} className="p-1.5 hover:bg-hover rounded text-ink-soft transition-colors" title="Zoom Out">
                    <ZoomOut size={16} />
                  </button>
                  <span className="text-xs font-bold text-ink-soft w-10 sm:w-12 text-center">{Math.round(zoom * 100)}%</span>
                  <button onClick={handleZoomIn} className="p-1.5 hover:bg-hover rounded text-ink-soft transition-colors" title="Zoom In">
                    <ZoomIn size={16} />
                  </button>
                  <button onClick={handleResetZoom} className="p-1.5 hover:bg-hover rounded text-ink-soft transition-colors ml-1 border-l border-edge" title="Reset Zoom">
                    <Maximize size={16} />
                  </button>
                </div>
                <button
                  onClick={() => setExtractionType('pageNumber')}
                  className={`px-2 sm:px-4 py-2 rounded-lg text-[11px] sm:text-sm font-bold transition-all ${
                    extractionType === 'pageNumber'
                      ? 'bg-accent-600 text-white shadow-md'
                      : 'bg-raised text-ink-soft border border-edge hover:border-accent-300'
                  }`}
                >
                  Extract Number
                </button>
                <button
                  onClick={() => setExtractionType('description')}
                  className={`px-2 sm:px-4 py-2 rounded-lg text-[11px] sm:text-sm font-bold transition-all ${
                    extractionType === 'description'
                      ? 'bg-accent-600 text-white shadow-md'
                      : 'bg-raised text-ink-soft border border-edge hover:border-accent-300'
                  }`}
                >
                  Extract Description
                </button>
                <div className="w-px h-6 bg-sunken mx-1 sm:mx-2" />
                <button onClick={closePreview} className="p-2 text-ink-faint hover:text-ink transition-colors">
                  <X size={22} />
                </button>
              </div>
            </div>

            {extractionType && (
              <div className="px-3 sm:px-4 py-2 border-b border-edge bg-sunken flex items-center gap-2 text-xs">
                <span className="text-ink-faint">Engine:</span>
                <button
                  type="button"
                  onClick={() => setExtractEngine('text')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all ${
                    extractEngine === 'text'
                      ? 'bg-accent-600 text-white shadow-md'
                      : 'bg-raised text-ink-soft border border-edge hover:border-accent-300'
                  }`}
                >
                  Text/OCR
                </button>
                <button
                  type="button"
                  disabled={!aiEngineAvailable}
                  title={aiEngineAvailable ? 'Read the selected region with the local AI model' : 'AI model not available on this server'}
                  onClick={async () => { setExtractEngine('ai'); warmupAi(await getAiIdleTimeoutMs()); }}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold transition-all disabled:opacity-40 disabled:cursor-not-allowed ${
                    extractEngine === 'ai'
                      ? 'bg-accent-600 text-white shadow-md'
                      : 'bg-raised text-ink-soft border border-edge hover:border-accent-300'
                  }`}
                >
                  AI read
                </button>
              </div>
            )}

            {/* Mobile note (Phase 8): the OCR region-select drag below uses
                mouse events only (onMouseDown/Move/Up), so the rectangular
                crop is desktop / tablet-mouse only. Phones are read-only for
                the takeoff workflow and this is a secondary import affordance,
                so touch/pointer support is intentionally out of scope here. */}
            <div
              className={`flex-grow overflow-hidden relative bg-slate-800 flex items-center justify-center ${
                extractionType ? 'cursor-crosshair' : zoom > 1 ? (isPanning ? 'cursor-grabbing' : 'cursor-grab') : 'cursor-default'
              }`}
              onMouseMove={handleImageMouseMove}
              onMouseUp={handleImageMouseUp}
              onMouseLeave={handleImageMouseUp}
            >
              <div
                ref={imageContainerRef}
                className="relative transition-transform duration-200 ease-out"
                style={{
                  transform: `translate(${panOffset.x}px, ${panOffset.y}px) scale(${zoom})`,
                  transformOrigin: 'center center',
                }}
                onMouseDown={handleImageMouseDown}
              >
                <PdfPagePreview
                  sourcePdfUrl={previewPage.sourcePdfFileId ? getImageUrl(previewPage.sourcePdfFileId) : undefined}
                  sourcePdfPageNum={previewPage.sourcePdfPageNum}
                  fallbackUrl={previewPage.imageId
                    ? getImageUrl(previewPage.imageId)
                    : pendingThumbnails[previewPage.thumbnailId]}
                  alt="Preview"
                  className="max-w-full max-h-[80vh] object-contain select-none shadow-2xl"
                  onLoadedSrc={setPreviewImageSrc}
                />
                {extractionRect && (
                  <div
                    className="absolute border-accent-500 bg-accent-500/10 pointer-events-none"
                    style={{
                      left: `${extractionRect.x}%`,
                      top: `${extractionRect.y}%`,
                      width: `${extractionRect.width}%`,
                      height: `${extractionRect.height}%`,
                      borderStyle: 'solid',
                      borderWidth: `${1 / zoom}px`,
                    }}
                  />
                )}
              </div>
            </div>

            <div className="p-4 sm:p-6 border-t border-edge bg-sunken flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
              <div className="flex items-center gap-2 text-sm text-ink-soft">
                <div className={`w-2 h-2 rounded-full ${isAreaSelected ? 'bg-green-500' : 'bg-edge-strong'}`} />
                {isAreaSelected
                  ? `Area selected. Ready to extract${extractionType === 'pageNumber' ? ' page number' : extractionType === 'description' ? ' description' : ''}.`
                  : extractionType
                  ? `Draw a box around the ${extractionType === 'pageNumber' ? 'page number' : 'description'} to extract.`
                  : 'Select Extract Number or Extract Description, then draw a box.'}
              </div>
              <div className="flex items-center gap-2 sm:gap-3 flex-wrap">
                {extractProgress && (
                  <span className="text-xs font-medium text-ink-soft">
                    Extracting… {extractProgress.done}/{extractProgress.total}
                  </span>
                )}
                <button
                  onClick={() => setExtractionRect(null)}
                  disabled={!extractionRect || isExtracting}
                  className="px-4 py-2 text-sm font-medium text-ink-soft hover:bg-hover rounded-lg transition-colors disabled:opacity-50 disabled:hover:bg-transparent"
                >
                  Clear Selection
                </button>
                <button
                  onClick={() => handleExtractText(false)}
                  disabled={!isAreaSelected || !extractionType || isExtracting}
                  className="px-4 sm:px-6 py-2 bg-ink text-raised rounded-lg text-sm font-bold hover:opacity-90 transition-all flex items-center gap-2 disabled:opacity-50"
                >
                  {isExtracting ? <Loader2 size={16} className="animate-spin" /> : <Search size={16} />}
                  Extract Current
                </button>
                <button
                  onClick={() => handleExtractText(true)}
                  disabled={!isAreaSelected || !extractionType || isExtracting}
                  className="px-4 sm:px-6 py-2 bg-accent-600 text-white rounded-lg text-sm font-bold hover:bg-accent-700 transition-all flex items-center gap-2 shadow-lg shadow-accent-200 disabled:opacity-50"
                >
                  {isExtracting ? <Loader2 size={16} className="animate-spin" /> : <Check size={16} />}
                  Extract All Pages
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </>
  );
};
