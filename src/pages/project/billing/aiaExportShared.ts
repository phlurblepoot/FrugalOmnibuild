// src/pages/project/billing/aiaExportShared.ts
// Shared assembly for AIA G702/G703 exports: resolves everything an export
// needs that isn't the pay app itself (project, settings, logo, admin
// template), plus a pure builder for the zero-charge "blank SOV" export used
// before any pay application exists.
import {
  AiaG702, AiaG703Row, AiaPayApp, AiaSettings, AiaSovLine,
  getAiaSettings, getFile, getProject, getSettings, getSov, resolveRetainageMode, lineTypeOf,
} from '../../../utils/store';
import type { Project } from '../../../types';
import type { AiaTemplateMapping } from './aiaExcel';

export interface AiaExportEnv {
  project: Project | null;
  settings: Record<string, string>;
  aiaSettings: AiaSettings;
  sovLines: AiaSovLine[];
  company: { name: string; address?: string; phone?: string; email?: string; logoDataUrl?: string };
  template?: { templateBuf: ArrayBuffer; mapping: AiaTemplateMapping };
  // True when a template is configured but failed to load/parse (caller toasts;
  // export falls back to the built-in recreation).
  templateLoadFailed: boolean;
}

export async function resolveAiaExportEnv(projectId: string): Promise<AiaExportEnv> {
  const [project, settings, aiaSettings, sovLines] = await Promise.all([
    getProject(projectId),
    getSettings(),
    getAiaSettings(projectId),
    getSov(projectId),
  ]);

  // Resolve logo to a data URL the same way Invoice/Proposal exports do.
  let logoDataUrl: string | undefined;
  const logoUrl = settings.logoUrl;
  if (logoUrl) {
    if (logoUrl.startsWith('data:')) {
      logoDataUrl = logoUrl;
    } else {
      try {
        const resp = await fetch(logoUrl);
        const blob = await resp.blob();
        logoDataUrl = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(blob);
        });
      } catch { /* skip logo on fetch error */ }
    }
  }

  // Resolve an admin-configured template (best-effort: fall back to the
  // recreation on any load/parse error so export always works).
  let template: { templateBuf: ArrayBuffer; mapping: AiaTemplateMapping } | undefined;
  let templateLoadFailed = false;
  const templateFileId = settings.aiaTemplateFileId;
  if (templateFileId) {
    try {
      const dataUrl = await getFile(templateFileId);
      if (!dataUrl) throw new Error('template file missing');
      const buf = await (await fetch(dataUrl)).arrayBuffer();
      const mapping = JSON.parse(settings.aiaTemplateMapping || '{}') as AiaTemplateMapping;
      template = { templateBuf: buf, mapping };
    } catch {
      templateLoadFailed = true;
      template = undefined;
    }
  }

  return {
    project,
    settings,
    aiaSettings,
    sovLines,
    company: {
      name: settings.companyName || settings.appName,
      address: settings.companyAddress,
      phone: settings.companyPhone,
      email: settings.companyEmail,
      logoDataUrl,
    },
    template,
    templateLoadFailed,
  };
}

// Pure. A synthetic zero pay app over the SOV: every billing column $0,
// balance-to-finish = scheduled value — the pre-project "here is the SOV for
// approval" document. number 0 renders as a blank Application No.
export function buildBlankSovContext(
  sovLines: AiaSovLine[],
  aiaSettings: AiaSettings,
  projectId: string,
): { app: AiaPayApp; g703: AiaG703Row[]; g702: AiaG702 } {
  const g703: AiaG703Row[] = [...sovLines]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.createdAt - b.createdAt)
    .map(l => ({
      sovLineId: l.id, itemNo: l.itemNo, description: l.description,
      isChangeOrder: l.isChangeOrder, lineType: lineTypeOf(l), scheduledValueCents: l.scheduledValueCents,
      previousCents: 0, thisPeriodCents: 0, storedCents: 0,
      totalToDateCents: 0, percentComplete: 0,
      balanceToFinishCents: l.scheduledValueCents, retainageCents: 0,
    }));
  const L1 = g703.filter(r => !r.isChangeOrder && lineTypeOf(r) === 'item').reduce((a, r) => a + r.scheduledValueCents, 0);
  const co = g703.filter(r => r.isChangeOrder);
  const additions = co.filter(r => r.scheduledValueCents > 0).reduce((a, r) => a + r.scheduledValueCents, 0);
  const deductions = co.filter(r => r.scheduledValueCents < 0).reduce((a, r) => a + r.scheduledValueCents, 0);
  const L2 = additions + deductions;
  const L3 = L1 + L2;
  const retainagePercent = aiaSettings.retainagePercent ?? 10;
  const app: AiaPayApp = {
    id: 'sov-preview', projectId, number: 0, periodTo: null, applicationDate: null,
    retainagePercent,
    storedRetainagePercent: aiaSettings.storedRetainagePercent ?? retainagePercent,
    releasedRetainagePoints: 0,
    status: 'draft', version: 1, createdAt: 0, updatedAt: 0,
  };
  // No pay app exists yet, so nothing has been released: base rate applies
  // in full, mirroring the server's synthesized retainage block for a fresh app.
  const mode = resolveRetainageMode(aiaSettings.retainageMode, sovLines);
  const g702: AiaG702 = {
    L1originalContractCents: L1,
    L2changeOrdersCents: L2,
    L3contractSumToDateCents: L3,
    L4totalCompletedStoredCents: 0,
    L5aRetainageWorkCents: 0,
    L5bRetainageStoredCents: 0,
    L5retainageCents: 0,
    L6earnedLessRetainageCents: 0,
    L7lessPreviousCents: 0,
    L8currentPaymentDueCents: 0,
    L9balanceToFinishCents: L3,
    changeOrders: { additionsCents: additions, deductionsCents: deductions, netCents: L2 },
    retainage: {
      mode,
      baseWorkPercent: retainagePercent,
      cumulativeReleasedPoints: 0,
      releasedThisApp: 0,
      remainingPoints: retainagePercent,
      effectiveWorkPercent: mode === 'perLine' ? null : retainagePercent,
    },
  };
  return { app, g703, g702 };
}
