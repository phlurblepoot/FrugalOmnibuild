import React, { useState, useRef, useEffect } from 'react';
import { useNavigate, Link, useLocation, useSearchParams } from 'react-router-dom';
import { Upload, ArrowLeft, FileText, Loader2, Trash2, Plus, Check } from 'lucide-react';
import { v4 as uuidv4 } from 'uuid';
import { Project, ProjectPage, Customer } from '../types';
import { createProject, saveProject, getProject, saveImage, saveBinaryFile, getCustomers, saveCustomer, DocumentRow } from '../utils/store';
import { loadPdfPagesGenerator } from '../utils/pdf';
import { AddressAutocomplete } from '../components/AddressAutocomplete';
import { UploadFailuresModal, UploadFailure } from '../components/UploadFailuresModal';
import { PageNamingStep } from '../components/PageNamingStep';
import { AddFilesButton } from '../components/documents/AddFilesButton';
import { readSheet, runWithConcurrency, applyReadToPage, aiAutoNameEnabled, warmupAi, getAiIdleTimeoutMs, waitForAiReady, type AiScanProgress } from '../utils/aiSheets';
import { composePageName } from '../utils/sheetNaming';
import { useToast } from '../components/Toast';

interface PendingPage {
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
  searchTextIndexed?: boolean;
  extractedText?: string;
  /** 'low' = the page still carries its import-time placeholder number and
   *  hasn't been confirmed yet (by manual edit or a confident AI read).
   *  The review UI flags 'low' rows as "needs review". */
  detectionConfidence?: 'high' | 'low';
}

export const NewProject: React.FC = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { toast } = useToast();
  const [step, setStep] = useState<'details' | 'name_pages'>('details');
  const [name, setName] = useState(location.state?.initialName || '');
  const [contractor, setContractor] = useState(location.state?.initialContractor || '');
  const [customerId, setCustomerId] = useState<string | undefined>(undefined);
  const [address, setAddress] = useState(location.state?.initialAddress || '');
  const [bidDueDate, setBidDueDate] = useState('');
  const [planSetName, setPlanSetName] = useState('Initial Set');
  const [planSetDate, setPlanSetDate] = useState(new Date().toISOString().split('T')[0]);
  const [files, setFiles] = useState<File[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState({ status: '', current: 0, total: 0, currentFile: 0, totalFiles: 0 });
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [projectId, setProjectId] = useState<string | null>(null);
  const [planSetId, setPlanSetId] = useState<string | null>(null);
  const [pendingPages, setPendingPages] = useState<PendingPage[]>([]);
  const [pageThumbnails, setPageThumbnails] = useState<Record<string, string>>({});
  // Transient medium-res per-page images for AI reading (kept so the manual
  // "AI Scan" button can re-run reads without re-rendering the PDF).
  const [aiImages, setAiImages] = useState<Record<string, string>>({});

  // Manual "AI Scan" — load the model on demand, then read every page.
  const handleAiScan = async (report: (p: AiScanProgress) => void) => {
    report({ phase: 'loading' });
    const idleMs = await getAiIdleTimeoutMs();
    await warmupAi(idleMs);
    const ready = await waitForAiReady(() => report({ phase: 'loading' }));
    if (!ready) {
      toast('AI model unavailable.', { type: 'error' });
      return;
    }
    const pages = pendingPages;
    let count = 0;
    report({ phase: 'scanning', done: 0, total: pages.length });
    const reads = await runWithConcurrency(
      pages.map(pg => async () => {
        const result = await readSheet({
          imageId: aiImages[pg.id] ? undefined : (pg.imageId || undefined),
          imageBase64: aiImages[pg.id] || (pg.imageId ? undefined : pageThumbnails[pg.thumbnailId]),
          embeddedText: pg.extractedText,
          idleTimeoutMs: idleMs,
        });
        count++;
        report({ phase: 'scanning', done: count, total: pages.length });
        return result;
      }),
      3,
    );
    setPendingPages(pages.map((pg, i) => (reads[i] ? applyReadToPage(pg, reads[i]!) : pg)));
    const hits = reads.filter(Boolean).length;
    toast(`AI read ${hits} of ${pages.length} page${pages.length === 1 ? '' : 's'}.`, { type: hits ? 'success' : 'error' });
    report({ phase: 'done' });
  };
  const [customers, setCustomers] = useState<Customer[]>([]);
  const [showNewCustomer, setShowNewCustomer] = useState(false);
  const [newCustomerName, setNewCustomerName] = useState('');
  const [addingCustomer, setAddingCustomer] = useState(false);

  // Upload-failures modal: opened when one or more pages didn't import. Holds
  // the source File objects so the user can retry the missing pages in place.
  const [uploadFailures, setUploadFailures] = useState<UploadFailure[]>([]);
  const [uploadFilesByName, setUploadFilesByName] = useState<Map<string, File>>(new Map());
  const [uploadTotals, setUploadTotals] = useState({ processed: 0, expected: 0 });
  const [showUploadFailuresModal, setShowUploadFailuresModal] = useState(false);
  const [isRetryingUpload, setIsRetryingUpload] = useState(false);
  const [retryProgress, setRetryProgress] = useState({ status: '', current: 0, total: 0, fileName: '' });

  useEffect(() => {
    getCustomers()
      .then((list: Customer[]) => {
        setCustomers(list);
        // Coming from a customer's pane ([+ Project]) — preselect it once the
        // dropdown has something to match against.
        const preselectId = searchParams.get('customerId');
        if (preselectId) {
          const found = list.find(c => c.id === preselectId);
          if (found) {
            setCustomerId(found.id);
            setContractor(found.name);
          }
        }
      })
      .catch(err => console.error('Failed to fetch customers:', err));
  }, [searchParams]);

  const handleAddNewCustomer = async () => {
    const trimmed = newCustomerName.trim();
    if (!trimmed) return;
    setAddingCustomer(true);
    try {
      const created: Customer = await saveCustomer({ name: trimmed, emails: {} });
      setCustomers(prev => [...prev, created].sort((a, b) => a.name.localeCompare(b.name)));
      setCustomerId(created.id);
      setContractor(created.name);
      setNewCustomerName('');
      setShowNewCustomer(false);
    } catch (err) {
      toast('Failed to create customer. Please try again.', { type: 'error' });
    } finally {
      setAddingCustomer(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFiles = Array.from(e.target.files || []);
    if (selectedFiles.length > 0) {
      setFiles(prev => [...prev, ...selectedFiles]);
      if (!name) {
        setName(selectedFiles[0].name.replace('.pdf', ''));
      }
    }
  };

  // Same landing spot as handleFileChange, for a plan set that is already
  // filed under Documents — no download-then-re-upload round trip.
  const addPickedDocuments = (picked: { row: DocumentRow; blob: Blob }[]) => {
    const picks = picked.map(p => new File([p.blob], p.row.name ?? 'plan.pdf', { type: 'application/pdf' }));
    if (picks.length === 0) return;
    setFiles(prev => [...prev, ...picks]);
    setName(prev => prev || picks[0].name.replace(/\.pdf$/i, ''));
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.stopPropagation();
    if (isProcessing) return;
    const dropped = Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf');
    if (dropped.length > 0) {
      setFiles(prev => [...prev, ...dropped]);
      if (!name) {
        setName(dropped[0].name.replace('.pdf', ''));
      }
    }
  };

  const removeFile = (indexToRemove: number) => {
    setFiles(files.filter((_, index) => index !== indexToRemove));
  };

  const handleProcessFiles = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name) return;

    setIsProcessing(true);
    try {
      const newProjectId = uuidv4();
      const newPlanSetId = uuidv4();
      setProjectId(newProjectId);
      setPlanSetId(newPlanSetId);

      let parsedBidDueDate = null;
      if (bidDueDate) {
        const [year, month, day] = bidDueDate.split('-').map(Number);
        parsedBidDueDate = new Date(year, month - 1, day).getTime();
      }

      const project: Project = {
        id: newProjectId,
        name,
        createdAt: Date.now(),
        contractor: contractor || undefined,
        customerId: customerId || undefined,
        address: address || undefined,
        bidDueDate: parsedBidDueDate,
        planSets: [
          {
            id: newPlanSetId,
            name: planSetName || 'Initial Set',
            date: planSetDate,
            createdAt: Date.now(),
          }
        ],
        pages: [],
        takeoffs: [],
      };

      await createProject(project);

      // No plan pages were added — create the empty project (with its plan set)
      // and go straight to it. Pages can be added later from the project.
      if (files.length === 0) {
        navigate(`/project/${newProjectId}`);
        return;
      }

      const extractedPages: PendingPage[] = [];
      const thumbnails: Record<string, string> = {};
      // Transient per-page medium-res images for AI reading (not stored). Only
      // rendered when the local model is available + auto-naming is on.
      const aiImages: Record<string, string> = {};
      // Render the AI image whenever auto-naming is on (independent of whether
      // the model is up right now) so the manual "AI Scan" button always has a
      // good image to send later. The auto pass additionally requires readiness.
      const aiWanted = aiAutoNameEnabled();
      const failures: Array<{ fileName: string; pageNum: number | null; reason: string }> = [];
      let totalExpected = 0;
      let totalProcessed = 0;
      let globalPageNum = 1;

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        setProgress(prev => ({ ...prev, currentFile: i + 1, totalFiles: files.length }));

        // Upload the raw PDF once per file. The File is streamed directly to
        // the server — we never materialize a base64 dataUrl in the browser,
        // which previously OOM'd Chrome for plan-set–sized PDFs. Every
        // ProjectPage extracted from this file points at this single
        // sourcePdfFileId, so the canvas can render pages on demand and
        // printouts can copy the original vectors.
        let sourcePdfFileId: string | undefined;
        const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
        if (isPdf) {
          try {
            setProgress(prev => ({ ...prev, status: 'uploading source PDF', current: 0, total: 0 }));
            const pdfBlob = file.type === 'application/pdf' ? file : new Blob([file], { type: 'application/pdf' });
            // plan-source is multi-instance (a set is often several PDFs), so this
            // never versions a sibling — each upload keeps its own row.
            sourcePdfFileId = (await saveBinaryFile(uuidv4(), pdfBlob, {
              projectId: newProjectId, kind: 'plan-source', name: file.name,
              sourceType: 'plan-set', sourceId: newPlanSetId,
            })).fileId;
          } catch (pdfErr) {
            console.warn(`Failed to upload source PDF for ${file.name} — falling back to raster only`, pdfErr);
            sourcePdfFileId = undefined;
          }
        }

        let fileExpected = 0;
        let fileYielded = 0;

        try {
          // When we already have the source PDF stored, the per-page raster is
          // unnecessary — skip it entirely. Without a source PDF (storage error or
          // a non-PDF source) we fall back to the legacy raster path.
          const generator = loadPdfPagesGenerator(file, (status, current, total) => {
            if (total > 0) fileExpected = total;
            setProgress(prev => ({ ...prev, status, current, total }));
          }, undefined, { includeFullPageRaster: !sourcePdfFileId, includeAiImage: aiWanted });

          for await (const pageData of generator) {
            fileYielded++;

            if (pageData.error) {
              failures.push({ fileName: file.name, pageNum: pageData.pageNum, reason: pageData.error });
              continue;
            }

            setProgress(prev => ({ ...prev, status: 'uploading', current: pageData.pageNum, total: prev.total }));

            try {
              const thumbnailId = uuidv4();
              await saveImage(thumbnailId, pageData.thumbnailDataUrl, { kind: 'plan', projectId: newProjectId });

              // Legacy raster path: only used when we couldn't store the source PDF.
              let imageId = '';
              if (!sourcePdfFileId && pageData.dataUrl) {
                imageId = uuidv4();
                await saveImage(imageId, pageData.dataUrl, { kind: 'plan', projectId: newProjectId });
              }
              // Thumbnails are keyed by `thumbnailId` (always set) so the naming
              // UI can look them up uniformly for vector and legacy pages.
              thumbnails[thumbnailId] = pageData.thumbnailDataUrl;

              // Placeholder numbering: pages arrive named 1, 2, 3, … (this is a
              // brand-new project, so the target plan set starts empty); all
              // real naming happens in the naming modal (extract tools / AI).
              // Sequence spans every file in the batch via globalPageNum.
              const placeholder = String(globalPageNum);
              const newPage: PendingPage = {
                id: uuidv4(),
                name: composePageName(placeholder, ''),
                pageNumber: placeholder,
                description: '',
                imageId,
                thumbnailId,
                imageWidth: pageData.width,
                imageHeight: pageData.height,
                sourcePdfFileId,
                sourcePdfPageNum: sourcePdfFileId ? pageData.pageNum : undefined,
                searchTextIndexed: !!sourcePdfFileId,
                extractedText: pageData.extractedText,
                detectionConfidence: 'low' as const,
              };

              extractedPages.push(newPage);
              if (pageData.aiImageDataUrl) aiImages[newPage.id] = pageData.aiImageDataUrl;

              project.pages.push({
                id: newPage.id,
                name: newPage.name,
                pageNumber: newPage.pageNumber,
                description: newPage.description,
                imageId: newPage.imageId,
                thumbnailId: newPage.thumbnailId,
                imageWidth: newPage.imageWidth,
                imageHeight: newPage.imageHeight,
                sourcePdfFileId,
                sourcePdfPageNum: sourcePdfFileId ? pageData.pageNum : undefined,
                searchTextIndexed: !!sourcePdfFileId,
                extractedText: newPage.extractedText,
                measurements: [],
                scaleConfig: null,
                planSetId: newPlanSetId,
              });

              totalProcessed++;

              if (globalPageNum % 5 === 0) {
                try { await saveProject(project); } catch (saveErr) {
                  console.warn('Periodic saveProject failed', saveErr);
                }
              }

              globalPageNum++;
            } catch (perPageErr) {
              console.warn(`Save failed for ${file.name} page ${pageData.pageNum}`, perPageErr);
              failures.push({
                fileName: file.name,
                pageNum: pageData.pageNum,
                reason: String((perPageErr as any)?.message || perPageErr),
              });
            }
          }
        } catch (genErr) {
          console.error(`PDF processing aborted for ${file.name}`, genErr);
          failures.push({
            fileName: file.name,
            pageNum: null,
            reason: `Processing aborted: ${String((genErr as any)?.message || genErr)}`,
          });
        }

        totalExpected += fileExpected;

        // Account for pages the generator never reached (e.g. iteration aborted mid-file).
        if (fileExpected > fileYielded) {
          for (let p = fileYielded + 1; p <= fileExpected; p++) {
            failures.push({
              fileName: file.name,
              pageNum: p,
              reason: 'Page was never reached during processing',
            });
          }
        }

        try {
          await saveProject(project);
        } catch (saveErr) {
          console.warn('End-of-file saveProject failed', saveErr);
          failures.push({
            fileName: file.name,
            pageNum: null,
            reason: `Could not save project after processing ${file.name}: ${String((saveErr as any)?.message || saveErr)}`,
          });
        }
      }

      // Final verification — surface any losses to the user so silent skips can't happen.
      const hasFailures = failures.length > 0 || totalProcessed !== totalExpected;
      if (hasFailures) {
        // Keep the source File objects around so the user can retry from the
        // failures modal without having to re-pick the files.
        const filesByName = new Map<string, File>();
        for (const f of files) filesByName.set(f.name, f);
        setUploadFilesByName(filesByName);
        setUploadFailures(failures);
        setUploadTotals({ processed: totalProcessed, expected: totalExpected });
        setShowUploadFailuresModal(true);
      }

      if (totalProcessed === 0) {
        // Nothing to name — stay on the upload step. Modal (if any) still shows.
        setIsProcessing(false);
        return;
      }

      setPendingPages(extractedPages);
      setPageThumbnails(thumbnails);
      setAiImages(aiImages);
      setStep('name_pages');
    } catch (error) {
      console.error('Error processing PDFs:', error);
      toast('Failed to process PDF. Please try another file.', { type: 'error' });
    } finally {
      setIsProcessing(false);
    }
  };

  // Retry every entry in the current failures list. Page-level failures get
  // re-rendered with the page-num filter; file-level failures (whole PDF
  // didn't open) get the entire file retried. Successfully recovered pages
  // are appended to pendingPages so they show up alongside the originals.
  const handleRetryFailedPages = async () => {
    if (!projectId || !planSetId || uploadFailures.length === 0) return;
    setIsRetryingUpload(true);
    setRetryProgress({ status: '', current: 0, total: 0, fileName: '' });

    try {
      const project = await getProject(projectId);
      if (!project) throw new Error('Project not found');

      // Group failures by file. allPages=true means we lost the whole file
      // up front and need to re-render every page.
      const byFile = new Map<string, { pageNums: number[]; allPages: boolean }>();
      for (const f of uploadFailures) {
        const entry = byFile.get(f.fileName) ?? { pageNums: [], allPages: false };
        if (f.pageNum == null) entry.allPages = true;
        else entry.pageNums.push(f.pageNum);
        byFile.set(f.fileName, entry);
      }

      const remainingFailures: UploadFailure[] = [];
      const newPendingPages: typeof pendingPages = [];
      const newThumbnails: Record<string, string> = {};
      let newlyProcessed = 0;
      let nextPageNum = (project.pages.length || 0) + 1;

      for (const [fileName, info] of byFile) {
        const file = uploadFilesByName.get(fileName);
        if (!file) {
          if (info.allPages) {
            remainingFailures.push({ fileName, pageNum: null, reason: 'Source file no longer available for retry' });
          }
          for (const p of info.pageNums) {
            remainingFailures.push({ fileName, pageNum: p, reason: 'Source file no longer available for retry' });
          }
          continue;
        }

        // Re-upload the source PDF for this retry. Retries are rare and storage
        // is cheap; pages from any successful run that already have a source
        // PDF stored will continue using their own — only newly recovered pages
        // here will point at this fresh one.
        let sourcePdfFileId: string | undefined;
        const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
        if (isPdf) {
          try {
            const pdfBlob = file.type === 'application/pdf' ? file : new Blob([file], { type: 'application/pdf' });
            sourcePdfFileId = (await saveBinaryFile(uuidv4(), pdfBlob, {
              projectId, kind: 'plan-source', name: file.name,
              sourceType: 'plan-set', sourceId: planSetId,
            })).fileId;
          } catch (pdfErr) {
            console.warn(`Retry: source PDF upload failed for ${fileName}`, pdfErr);
            sourcePdfFileId = undefined;
          }
        }

        const pageNumsArg = info.allPages ? undefined : info.pageNums;
        const requestedCount = info.allPages ? 0 : info.pageNums.length;
        const succeeded = new Set<number>();
        let yielded = 0;
        let expectedFromGenerator = 0;

        try {
          const generator = loadPdfPagesGenerator(file, (status, current, total) => {
            if (info.allPages && total > 0) expectedFromGenerator = total;
            setRetryProgress({
              status,
              current,
              total: info.allPages ? total : requestedCount,
              fileName,
            });
          }, pageNumsArg, { includeFullPageRaster: !sourcePdfFileId });

          for await (const pageData of generator) {
            yielded++;

            if (pageData.error) {
              remainingFailures.push({ fileName, pageNum: pageData.pageNum, reason: pageData.error });
              continue;
            }

            try {
              const thumbnailId = uuidv4();
              await saveImage(thumbnailId, pageData.thumbnailDataUrl, { kind: 'plan', projectId: projectId ?? undefined });

              let imageId = '';
              if (!sourcePdfFileId && pageData.dataUrl) {
                imageId = uuidv4();
                await saveImage(imageId, pageData.dataUrl, { kind: 'plan', projectId: projectId ?? undefined });
              }
              newThumbnails[thumbnailId] = pageData.thumbnailDataUrl;

              // Placeholder numbering continues from the count of pages already
              // in the target plan set (nextPageNum already tracks that —
              // initialized from project.pages.length and incremented per page
              // recovered, matching how the main run numbers pages).
              const placeholder = String(nextPageNum);
              const newPage: PendingPage = {
                id: uuidv4(),
                name: composePageName(placeholder, ''),
                pageNumber: placeholder,
                description: '',
                imageId,
                thumbnailId,
                imageWidth: pageData.width,
                imageHeight: pageData.height,
                sourcePdfFileId,
                sourcePdfPageNum: sourcePdfFileId ? pageData.pageNum : undefined,
                searchTextIndexed: !!sourcePdfFileId,
                extractedText: pageData.extractedText,
                detectionConfidence: 'low' as const,
              };

              newPendingPages.push(newPage);
              project.pages.push({
                id: newPage.id,
                name: newPage.name,
                pageNumber: newPage.pageNumber,
                description: newPage.description,
                imageId: newPage.imageId,
                thumbnailId: newPage.thumbnailId,
                imageWidth: newPage.imageWidth,
                imageHeight: newPage.imageHeight,
                sourcePdfFileId,
                sourcePdfPageNum: sourcePdfFileId ? pageData.pageNum : undefined,
                searchTextIndexed: !!sourcePdfFileId,
                extractedText: newPage.extractedText,
                measurements: [],
                scaleConfig: null,
                planSetId,
              });

              nextPageNum++;
              newlyProcessed++;
              succeeded.add(pageData.pageNum);
            } catch (saveErr) {
              remainingFailures.push({
                fileName,
                pageNum: pageData.pageNum,
                reason: String((saveErr as any)?.message || saveErr),
              });
            }
          }
        } catch (genErr) {
          remainingFailures.push({
            fileName,
            pageNum: null,
            reason: `Retry aborted: ${String((genErr as any)?.message || genErr)}`,
          });
          if (!info.allPages) {
            for (const p of info.pageNums) {
              if (!succeeded.has(p)) {
                remainingFailures.push({ fileName, pageNum: p, reason: 'Page was never reached during retry' });
              }
            }
          }
          continue;
        }

        if (!info.allPages) {
          for (const p of info.pageNums) {
            const alreadyRecorded = remainingFailures.some(f => f.fileName === fileName && f.pageNum === p);
            if (!succeeded.has(p) && !alreadyRecorded) {
              remainingFailures.push({ fileName, pageNum: p, reason: 'Page was not produced during retry' });
            }
          }
        } else if (expectedFromGenerator > yielded) {
          for (let p = yielded + 1; p <= expectedFromGenerator; p++) {
            remainingFailures.push({ fileName, pageNum: p, reason: 'Page was never reached during retry' });
          }
        }
      }

      try {
        await saveProject(project);
      } catch (saveErr) {
        remainingFailures.push({
          fileName: '(project save)',
          pageNum: null,
          reason: `Could not save retried pages: ${String((saveErr as any)?.message || saveErr)}`,
        });
      }

      // Merge new pages and thumbnails into the UI lists and advance to
      // name_pages if we hadn't already (e.g. all original pages failed).
      if (newPendingPages.length > 0) {
        setPendingPages(prev => [...prev, ...newPendingPages]);
        setPageThumbnails(prev => ({ ...prev, ...newThumbnails }));
        if (step !== 'name_pages') setStep('name_pages');
      }

      setUploadFailures(remainingFailures);
      setUploadTotals(prev => ({ processed: prev.processed + newlyProcessed, expected: prev.expected }));

      if (remainingFailures.length === 0) {
        setShowUploadFailuresModal(false);
      }
    } catch (err) {
      console.error('Retry failed', err);
      toast(`Retry failed: ${(err as any)?.message || err}`, { type: 'error' });
    } finally {
      setIsRetryingUpload(false);
      setRetryProgress({ status: '', current: 0, total: 0, fileName: '' });
    }
  };

  const handleSaveChanges = async () => {
    if (!projectId || !planSetId) return;
    
    setIsProcessing(true);
    try {
      const project = await getProject(projectId);
      if (!project) throw new Error('Project not found');

      // Update names/numbers on the existing server-side pages in place. We
      // never rebuild project.pages from pendingPages — if pendingPages is
      // somehow shorter (e.g. a stale closure), any unmatched server-side
      // pages would be silently dropped on save.
      const updatedServerPages = [...project.pages];
      pendingPages.forEach(p => {
        const idx = updatedServerPages.findIndex(pp => pp.id === p.id);
        // Prefer the vector-source pointers that the server-side page already
        // carries (set at upload time) — they live on the project, not on the
        // PendingPage in state, so a rebuild from `p` alone would drop them.
        // Fall back to what PendingPage has in case anything reaches this path
        // before the server save lands.
        const existing = idx !== -1 ? updatedServerPages[idx] : undefined;
        const merged: ProjectPage = {
          id: p.id,
          name: composePageName(p.pageNumber, p.description, p.name),
          pageNumber: p.pageNumber,
          description: p.description,
          imageId: p.imageId,
          thumbnailId: p.thumbnailId,
          imageWidth: p.imageWidth,
          imageHeight: p.imageHeight,
          sourcePdfFileId: existing?.sourcePdfFileId ?? p.sourcePdfFileId,
          sourcePdfPageNum: existing?.sourcePdfPageNum ?? p.sourcePdfPageNum,
          searchTextIndexed: existing?.searchTextIndexed ?? !!(existing?.sourcePdfFileId ?? p.sourcePdfFileId),
          extractedText: p.extractedText,
          measurements: existing?.measurements ?? [],
          scaleConfig: existing?.scaleConfig ?? null,
          planSetId,
        };
        if (idx !== -1) updatedServerPages[idx] = merged;
        else updatedServerPages.push(merged);
      });

      project.pages = updatedServerPages;

      await saveProject(project);

      navigate(`/project/${projectId}/takeoff`);
    } catch (error) {
      console.error('Error saving project:', error);
      toast('Failed to save project.', { type: 'error' });
    } finally {
      setIsProcessing(false);
    }
  };

  if (step === 'name_pages') {
    return (
      <div className="p-4 sm:p-8 font-sans">
        <div className="max-w-4xl mx-auto">
          <button
            onClick={() => setStep('details')}
            className="inline-flex items-center gap-2 text-ink-soft hover:text-ink mb-6 transition-colors font-medium"
          >
            <ArrowLeft size={18} />
            Back to Details
          </button>

          <PageNamingStep
            pendingPages={pendingPages}
            setPendingPages={setPendingPages}
            pendingThumbnails={pageThumbnails}
            onConfirm={handleSaveChanges}
            isConfirming={isProcessing}
            title="Name Pages"
            subtitle="Review and rename the imported pages before creating the project."
            onAiScan={handleAiScan}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="p-4 sm:p-8 font-sans">
      <div className="max-w-2xl mx-auto">
        <Link to="/projects" className="inline-flex items-center gap-2 text-ink-soft hover:text-ink mb-6 transition-colors font-medium">
          <ArrowLeft size={18} />
          Back to Projects
        </Link>
        
        <div className="bg-raised rounded-2xl shadow-sm border border-edge overflow-hidden">
          <div className="p-6 sm:p-8 border-b border-edge">
            <h1 className="text-xl sm:text-2xl font-bold text-ink">New Project</h1>
            <p className="text-sm sm:text-base text-ink-soft mt-1">Add blueprint PDFs now, or create the project and add pages later</p>
          </div>

          <form onSubmit={handleProcessFiles} className="p-6 sm:p-8">
            <div className="space-y-6">
              <div>
                <label htmlFor="name" className="block text-sm font-medium text-ink mb-2">
                  Project Name
                </label>
                <input
                  type="text"
                  id="name"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-4 py-3 rounded-xl border border-edge-strong focus:ring-2 focus:ring-accent-500 focus:border-accent-500 outline-none transition-all text-ink placeholder:text-ink-faint"
                  placeholder="e.g. Main Floor Plan"
                  required
                  disabled={isProcessing}
                />
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label htmlFor="customerId" className="block text-sm font-medium text-ink mb-2">
                    Customer (Optional)
                  </label>
                  <select
                    id="customerId"
                    value={customerId ?? ''}
                    onChange={e => {
                      const val = e.target.value;
                      if (val === '__new__') {
                        setShowNewCustomer(true);
                        setCustomerId(undefined);
                        setContractor('');
                      } else {
                        setShowNewCustomer(false);
                        setCustomerId(val || undefined);
                        const found = customers.find(c => c.id === val);
                        setContractor(found ? found.name : '');
                      }
                    }}
                    disabled={isProcessing}
                    className="w-full px-4 py-3 rounded-xl border border-edge-strong focus:ring-2 focus:ring-accent-500 focus:border-accent-500 outline-none transition-all text-ink placeholder:text-ink-faint bg-raised"
                  >
                    <option value="">— None —</option>
                    {customers.map(c => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                    <option value="__new__">＋ New customer…</option>
                  </select>
                  {showNewCustomer && (
                    <div className="mt-2 flex gap-2">
                      <input
                        type="text"
                        value={newCustomerName}
                        onChange={e => setNewCustomerName(e.target.value)}
                        onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleAddNewCustomer(); } }}
                        placeholder="Customer name"
                        disabled={addingCustomer || isProcessing}
                        className="flex-1 px-3 py-2 rounded-lg border border-edge-strong focus:ring-2 focus:ring-accent-500 focus:border-accent-500 outline-none transition-all text-ink placeholder:text-ink-faint text-sm"
                        autoFocus
                      />
                      <button
                        type="button"
                        onClick={handleAddNewCustomer}
                        disabled={!newCustomerName.trim() || addingCustomer || isProcessing}
                        className="px-3 py-2 rounded-lg text-sm font-medium text-white bg-accent-600 hover:bg-accent-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                      >
                        {addingCustomer ? <Loader2 size={14} className="animate-spin" /> : <Check size={14} />}
                      </button>
                    </div>
                  )}
                </div>
                <div>
                  <label htmlFor="address" className="block text-sm font-medium text-ink mb-2">
                    Address (Optional)
                  </label>
                  <AddressAutocomplete
                    value={address}
                    onChange={setAddress}
                    placeholder="e.g. 123 Main St, City, State"
                    disabled={isProcessing}
                  />
                </div>
                <div>
                  <label htmlFor="bidDueDate" className="block text-sm font-medium text-ink mb-2">
                    Bid Due Date (Optional)
                  </label>
                  <input
                    type="date"
                    id="bidDueDate"
                    value={bidDueDate}
                    onChange={(e) => setBidDueDate(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl border border-edge-strong focus:ring-2 focus:ring-accent-500 focus:border-accent-500 outline-none transition-all text-ink placeholder:text-ink-faint"
                    disabled={isProcessing}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                  <label htmlFor="planSetName" className="block text-sm font-medium text-ink mb-2">
                    Plan Set Name
                  </label>
                  <input
                    type="text"
                    id="planSetName"
                    value={planSetName}
                    onChange={(e) => setPlanSetName(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl border border-edge-strong focus:ring-2 focus:ring-accent-500 focus:border-accent-500 outline-none transition-all text-ink placeholder:text-ink-faint"
                    placeholder="e.g. Initial Set"
                    required
                    disabled={isProcessing}
                  />
                </div>

                <div>
                  <label htmlFor="planSetDate" className="block text-sm font-medium text-ink mb-2">
                    Plan Set Date
                  </label>
                  <input
                    type="date"
                    id="planSetDate"
                    value={planSetDate}
                    onChange={(e) => setPlanSetDate(e.target.value)}
                    className="w-full px-4 py-3 rounded-xl border border-edge-strong focus:ring-2 focus:ring-accent-500 focus:border-accent-500 outline-none transition-all text-ink placeholder:text-ink-faint"
                    required
                    disabled={isProcessing}
                  />
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-ink mb-2">
                  Blueprint PDFs (Optional)
                </label>
                <div
                  className={`border-2 border-dashed rounded-xl p-8 text-center transition-colors ${
                    files.length > 0 ? 'border-accent-300 bg-accent-50' : 'border-edge-strong hover:border-accent-400 bg-sunken hover:bg-hover cursor-pointer'
                  }`}
                  onClick={() => !isProcessing && files.length === 0 && fileInputRef.current?.click()}
                  onDragOver={e => { e.preventDefault(); e.stopPropagation(); }}
                  onDragEnter={e => { e.preventDefault(); e.stopPropagation(); }}
                  onDrop={handleDrop}
                >
                  {files.length > 0 ? (
                    <div className="flex flex-col items-center w-full">
                      <div className="w-full max-w-md space-y-3 mb-4">
                        {files.map((file, index) => (
                          <div key={`${file.name}-${index}`} className="flex items-center justify-between bg-raised p-3 rounded-lg border border-accent-200 shadow-sm">
                            <div className="flex items-center gap-3 overflow-hidden">
                              <FileText size={20} className="text-accent-500 shrink-0" />
                              <div className="text-left overflow-hidden">
                                <p className="text-sm font-medium text-ink truncate" title={file.name}>{file.name}</p>
                                <p className="text-xs text-ink-soft">{(file.size / 1024 / 1024).toFixed(2)} MB</p>
                              </div>
                            </div>
                            {!isProcessing && (
                              <button 
                                type="button" 
                                onClick={(e) => { e.stopPropagation(); removeFile(index); }}
                                className="p-1.5 text-ink-faint hover:text-red-500 hover:bg-red-50 rounded-md transition-colors shrink-0"
                                title="Remove file"
                              >
                                <Trash2 size={16} />
                              </button>
                            )}
                          </div>
                        ))}
                      </div>
                      {!isProcessing && (
                        <button 
                          type="button" 
                          onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                          className="mt-2 text-sm text-accent-600 hover:text-accent-700 font-medium flex items-center gap-1"
                        >
                          <Plus size={16} /> Add more PDFs
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center">
                      <Upload size={48} className="text-ink-faint mb-3" />
                      <p className="text-sm font-medium text-ink">Click to upload PDFs</p>
                      <p className="text-xs text-ink-soft mt-1">or drag and drop</p>
                    </div>
                  )}
                </div>
                <input
                  type="file"
                  ref={fileInputRef}
                  onChange={handleFileChange}
                  accept="application/pdf"
                  className="hidden"
                  multiple
                  disabled={isProcessing}
                />
                <div className="mt-2 flex justify-center">
                  <AddFilesButton
                    label="Choose from documents"
                    accept="pdf"
                    size="sm"
                    returnBlobs
                    disabled={isProcessing}
                    onPickBlobs={addPickedDocuments}
                  />
                </div>
              </div>
            </div>

            {isProcessing && files.length > 0 && (
              <div className="mt-6 rounded-xl border border-edge bg-sunken p-4">
                <div className="mb-2 flex items-center justify-between gap-3 text-sm font-medium text-ink">
                  <span className="flex items-center gap-2 truncate">
                    <Loader2 size={15} className="shrink-0 animate-spin text-accent-600" />
                    {progress.status
                      ? progress.status.charAt(0).toUpperCase() + progress.status.slice(1)
                      : 'Processing…'}
                  </span>
                  {progress.total > 0 && (
                    <span className="shrink-0 tabular-nums text-ink-soft">
                      {progress.current}/{progress.total}
                    </span>
                  )}
                </div>
                <div className="relative h-2 w-full overflow-hidden rounded-full bg-sunken">
                  {progress.total > 0 ? (
                    <div
                      className="h-full rounded-full bg-accent-600 transition-[width] duration-300"
                      style={{ width: `${Math.min(100, Math.round((progress.current / progress.total) * 100))}%` }}
                    />
                  ) : (
                    <div className="progress-indeterminate breathing absolute inset-y-0 rounded-full bg-accent-600" />
                  )}
                </div>
                {progress.totalFiles > 1 && (
                  <p className="mt-2 text-xs text-ink-soft">
                    File {progress.currentFile} of {progress.totalFiles}
                  </p>
                )}
              </div>
            )}

            <div className="mt-8 pt-6 border-t border-edge flex flex-wrap justify-end gap-3">
              <Link
                to="/projects"
                className="px-6 py-3 rounded-xl font-medium text-ink-soft hover:bg-sunken transition-colors"
              >
                Cancel
              </Link>
              <button
                type="submit"
                disabled={!name || isProcessing}
                className="flex items-center gap-2 px-6 py-3 rounded-xl font-medium text-white bg-accent-600 hover:bg-accent-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors shadow-sm"
              >
                {isProcessing ? (
                  <>
                    <Loader2 size={18} className="animate-spin" />
                    {files.length === 0 ? 'Creating…' : 'Processing…'}
                  </>
                ) : (
                  files.length === 0 ? 'Create Project' : 'Next Step'
                )}
              </button>
            </div>
          </form>
        </div>
      </div>

      <UploadFailuresModal
        open={showUploadFailuresModal}
        failures={uploadFailures}
        totalProcessed={uploadTotals.processed}
        totalExpected={uploadTotals.expected}
        isRetrying={isRetryingUpload}
        retryStatus={retryProgress.status}
        retryCurrent={retryProgress.current}
        retryTotal={retryProgress.total}
        retryFileName={retryProgress.fileName}
        canRetry={uploadFilesByName.size > 0}
        onRetry={handleRetryFailedPages}
        onClose={() => setShowUploadFailuresModal(false)}
      />
    </div>
  );
};
