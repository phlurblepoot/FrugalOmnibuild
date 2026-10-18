// src/pages/project/proposal/buildProposalPdf.ts
// Resolves everything the pure renderer needs from the server (settings,
// letterhead, photo bytes, attachment bytes) and hands it to
// generateProposalPdf. Both the editor's Generate button and its send-time
// re-stamp go through here so the two never drift apart.
import { fetchFileBlob, getSettings, type Proposal } from '../../../utils/store';
import type { Project } from '../../../types';
import { computeRevisionModel } from '../../../utils/planSets';
import { generateProposalPdf, type ProposalGenResult, type TakeoffTotals } from './proposalGenerator';
import { buildLetterhead } from './proposalLetterhead';

export const blobToDataUrl = (blob: Blob): Promise<string> =>
  new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result as string);
    fr.onerror = () => reject(new Error('file read failed'));
    fr.readAsDataURL(blob);
  });

export interface BuildProposalPdfArgs {
  /** The snapshot to render — the editor merges its unsaved draft over the row. */
  proposal: Proposal;
  project: Project;
  takeoffTotals: TakeoffTotals[];
  includeHighlights: boolean;
  /** Stamped in the letterhead instead of the company email (send-time choice). */
  headerEmail?: string;
  onProgress?: (msg: string) => void;
  /** Called once per attachment whose bytes couldn't be read; the render goes on. */
  onSkippedAttachment?: (name: string) => void;
}

export async function buildProposalPdf({
  proposal, project, takeoffTotals, includeHighlights, headerEmail, onProgress, onSkippedAttachment,
}: BuildProposalPdfArgs): Promise<ProposalGenResult> {
  const settings = await getSettings();
  const letterhead = await buildLetterhead(settings, headerEmail);

  // An unreadable photo is dropped silently — it would only ever be a blank
  // cell on the page — while a dropped attachment loses a whole document the
  // estimator deliberately added, so that one is reported.
  const photos: { dataUrl: string; caption: string | null }[] = [];
  for (const p of proposal.photos) {
    try {
      photos.push({ dataUrl: await blobToDataUrl(await fetchFileBlob(p.fileId)), caption: p.caption });
    } catch {
      /* skip */
    }
  }

  const attachments: ArrayBuffer[] = [];
  for (const a of proposal.attachments) {
    try {
      attachments.push(await (await fetchFileBlob(a.fileId)).arrayBuffer());
    } catch {
      onSkippedAttachment?.(a.name ?? 'attachment');
    }
  }

  return generateProposalPdf({
    proposal,
    project,
    takeoffTotals,
    currentPageIds: computeRevisionModel(project, '').currentPageIds,
    letterhead,
    photos,
    attachments,
    includeHighlights,
  }, onProgress);
}
