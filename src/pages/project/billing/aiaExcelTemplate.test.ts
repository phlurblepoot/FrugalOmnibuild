// src/pages/project/billing/aiaExcelTemplate.test.ts
//
// Template-fill mode: builds a tiny in-memory .xlsx "template", fills it via
// buildAiaWorkbookFromTemplate, and asserts that (a) mapped cells receive the
// expected values (money as cents/100), and (b) an unmapped pre-existing cell
// is PRESERVED — proving the template's content/formatting is not wiped.
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { buildAiaWorkbookFromTemplate, type AiaTemplateMapping, type AiaExportCtx } from './aiaExcel';
import type { AiaG702, AiaG703Row, AiaSovLine, AiaPayApp, AiaSettings } from '../../../utils/store';

const sovLines: AiaSovLine[] = [
  { id: 'sov1', projectId: 'p1', itemNo: '001', description: 'Mobilization', scheduledValueCents: 100000, retainagePercent: null, isChangeOrder: 0, changeOrderId: null, sortOrder: 0, version: 1, createdAt: 0 },
  { id: 'sov2', projectId: 'p1', itemNo: '002', description: 'Framing', scheduledValueCents: 500000, retainagePercent: null, isChangeOrder: 0, changeOrderId: null, sortOrder: 1, version: 1, createdAt: 0 },
];

const g703: AiaG703Row[] = [
  { sovLineId: 'sov1', itemNo: '001', description: 'Mobilization', isChangeOrder: 0, scheduledValueCents: 100000, previousCents: 50000, thisPeriodCents: 50000, storedCents: 0, totalToDateCents: 100000, percentComplete: 100, balanceToFinishCents: 0, retainageCents: 10000 },
  { sovLineId: 'sov2', itemNo: '002', description: 'Framing', isChangeOrder: 0, scheduledValueCents: 500000, previousCents: 100000, thisPeriodCents: 150000, storedCents: 50000, totalToDateCents: 300000, percentComplete: 60, balanceToFinishCents: 200000, retainageCents: 30000 },
];

const g702: AiaG702 = {
  L1originalContractCents: 600000,
  L2changeOrdersCents: 50000,
  L3contractSumToDateCents: 650000,
  L4totalCompletedStoredCents: 400000,
  L5aRetainageWorkCents: 37500,
  L5bRetainageStoredCents: 5000,
  L5retainageCents: 42500,
  L6earnedLessRetainageCents: 357500,
  L7lessPreviousCents: 135000,
  L8currentPaymentDueCents: 222500,
  L9balanceToFinishCents: 292500,
  changeOrders: { additionsCents: 50000, deductionsCents: 0, netCents: 50000 },
  retainage: {
    mode: 'uniform',
    baseWorkPercent: 10,
    cumulativeReleasedPoints: 0,
    releasedThisApp: 0,
    remainingPoints: 10,
    effectiveWorkPercent: 10,
  },
};

const app: AiaPayApp = {
  id: 'app1', projectId: 'p1', number: 3,
  periodTo: '2026-06-30', applicationDate: '2026-07-01',
  retainagePercent: 10, storedRetainagePercent: 10, releasedRetainagePoints: 0,
  status: 'draft', version: 1, createdAt: 0, updatedAt: 0,
};

const aiaSettings: AiaSettings = {
  ownerName: 'Acme Owner', ownerAddress: '1 Owner St',
  architectName: 'Bob Architect', architectAddress: '2 Arch Ave',
  contractDate: '2026-01-01', ownerProjectNumber: 'OWN-1', architectProjectNumber: 'ARC-1',
  contractFor: 'General Construction',
};

const ctx: AiaExportCtx = {
  projectName: 'Test Project',
  company: { name: 'My Co', address: '3 Co Blvd', phone: '555', email: 'a@b.com' },
  aiaSettings, app, sovLines, g702, g703,
};

// Build a minimal template workbook with some pre-existing content (including a
// cell we never map, to prove it's preserved) and return it as an ArrayBuffer.
async function makeTemplateBuffer(): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook();
  const g702ws = wb.addWorksheet('G702');
  // An untouched, pre-existing cell with content + bold style.
  const preserved = g702ws.getCell('A1');
  preserved.value = 'DO NOT TOUCH';
  preserved.font = { bold: true, size: 12, name: 'Times New Roman' };
  // A target cell for L8.
  g702ws.getCell('F20').value = 0;

  const g703ws = wb.addWorksheet('G703');
  g703ws.getCell('A1').value = 'Continuation header';

  const buf = await wb.xlsx.writeBuffer();
  // exceljs returns a Node Buffer-like; normalize to ArrayBuffer.
  return buf as ArrayBuffer;
}

const mapping: AiaTemplateMapping = {
  g702Sheet: 'G702',
  cells: { L8: 'F20', projectName: 'C3', retainageWorkPct: 'D25', retainageStoredPct: 'D26' },
  g703Sheet: 'G703',
  g703StartRow: 5,
  g703Cols: {
    itemNo: 'A', description: 'B', scheduledValue: 'C', total: 'G', retainage: 'J',
  },
  moneyAsDollars: true,
};

describe('buildAiaWorkbookFromTemplate', () => {
  it('fills mapped G702 cells with money as cents/100', async () => {
    const buf = await makeTemplateBuffer();
    const wb = await buildAiaWorkbookFromTemplate(buf, mapping, ctx);
    const ws = wb.getWorksheet('G702')!;
    // L8 = 222500 cents -> 2225 dollars at F20.
    expect(ws.getCell('F20').value).toBe(2225);
    expect(ws.getCell('C3').value).toBe('Test Project');
  });

  it('maps retainageWorkPct/retainageStoredPct to EFFECTIVE (post-release) rates, not raw app rates', async () => {
    const buf = await makeTemplateBuffer();
    const releasedCtx: AiaExportCtx = {
      ...ctx,
      app: { ...app, retainagePercent: 10, storedRetainagePercent: 10 },
      g702: {
        ...g702,
        retainage: {
          mode: 'uniform',
          baseWorkPercent: 10,
          cumulativeReleasedPoints: 4,
          releasedThisApp: 4,
          remainingPoints: 10,
          effectiveWorkPercent: 6, // 10 - 4
        },
      },
    };
    const wb = await buildAiaWorkbookFromTemplate(buf, mapping, releasedCtx);
    const ws = wb.getWorksheet('G702')!;
    expect(ws.getCell('D25').value).toBe(6); // effective work % (10 - 4 released)
    expect(ws.getCell('D26').value).toBe(6); // effective stored % (10 - 4 released)
  });

  it('a legacy app with zero releases maps its own raw rates unchanged', async () => {
    const buf = await makeTemplateBuffer();
    const legacyCtx: AiaExportCtx = {
      ...ctx,
      app: { ...app, retainagePercent: 8, storedRetainagePercent: 5 },
      g702: {
        ...g702,
        retainage: {
          mode: 'uniform',
          baseWorkPercent: 8,
          cumulativeReleasedPoints: 0,
          releasedThisApp: 0,
          remainingPoints: 8,
          effectiveWorkPercent: 8,
        },
      },
    };
    const wb = await buildAiaWorkbookFromTemplate(buf, mapping, legacyCtx);
    const ws = wb.getWorksheet('G702')!;
    expect(ws.getCell('D25').value).toBe(8);
    expect(ws.getCell('D26').value).toBe(5); // distinct legacy stored rate preserved
  });

  it('writes G703 line rows at the mapped start row + columns', async () => {
    const buf = await makeTemplateBuffer();
    const wb = await buildAiaWorkbookFromTemplate(buf, mapping, ctx);
    const ws = wb.getWorksheet('G703')!;
    // Row 0 -> start row 5; row 1 -> row 6.
    expect(ws.getCell('A5').value).toBe('001');
    expect(ws.getCell('B5').value).toBe('Mobilization');
    expect(ws.getCell('C5').value).toBe(1000); // 100000 cents
    expect(ws.getCell('G5').value).toBe(1000); // total 100000 cents
    expect(ws.getCell('J5').value).toBe(100);  // retainage 10000 cents

    expect(ws.getCell('B6').value).toBe('Framing');
    expect(ws.getCell('C6').value).toBe(5000); // 500000 cents
    expect(ws.getCell('G6').value).toBe(3000); // 300000 cents
  });

  it('preserves unmapped pre-existing template cells and their styles', async () => {
    const buf = await makeTemplateBuffer();
    const wb = await buildAiaWorkbookFromTemplate(buf, mapping, ctx);
    const ws = wb.getWorksheet('G702')!;
    const cell = ws.getCell('A1');
    expect(cell.value).toBe('DO NOT TOUCH');
    expect(cell.font?.bold).toBe(true);
    expect(cell.font?.name).toBe('Times New Roman');
    // The G703 header cell we never mapped is also intact.
    expect(wb.getWorksheet('G703')!.getCell('A1').value).toBe('Continuation header');
  });

  it('skips invalid cell refs without throwing', async () => {
    const buf = await makeTemplateBuffer();
    const badMapping: AiaTemplateMapping = {
      ...mapping,
      cells: { ...mapping.cells, L1: '!!notacell!!' },
    };
    await expect(buildAiaWorkbookFromTemplate(buf, badMapping, ctx)).resolves.toBeDefined();
  });
});

// exceljs keeps manual page breaks on the sheet but leaves them out of its types.
const rowBreakIds = (ws: object) => ((ws as { rowBreaks?: { id: number }[] }).rowBreaks ?? []).map(b => b.id);

describe('buildAiaWorkbookFromTemplate — print layout', () => {
  const withCo: AiaExportCtx = {
    ...ctx,
    g703: [...g703, { sovLineId: 'sov3', itemNo: 'CO-1', description: 'Extra door', isChangeOrder: 1, scheduledValueCents: 50000, previousCents: 0, thisPeriodCents: 0, storedCents: 0, totalToDateCents: 0, percentComplete: 0, balanceToFinishCents: 50000, retainageCents: 0 }],
  };

  it('puts the G702 on one landscape page and fits the G703 to the width, keeping the template paper and margins', async () => {
    const tpl = new ExcelJS.Workbook();
    const a = tpl.addWorksheet('G702');
    a.pageSetup = { ...a.pageSetup, paperSize: 5 as unknown as ExcelJS.PaperSize, margins: { left: 1, right: 1, top: 1, bottom: 1, header: 0.5, footer: 0.5 } };
    tpl.addWorksheet('G703');
    const wb = await buildAiaWorkbookFromTemplate(await tpl.xlsx.writeBuffer() as ArrayBuffer, mapping, withCo);
    expect(wb.getWorksheet('G702')!.pageSetup).toMatchObject({ orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1, paperSize: 5, margins: { left: 1 } });
    expect(wb.getWorksheet('G703')!.pageSetup).toMatchObject({ orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 });
  });

  it('starts the change orders on a new page (rows from the mapped start row)', async () => {
    const wb = await buildAiaWorkbookFromTemplate(await makeTemplateBuffer(), mapping, withCo);
    // Start row 5: two contract lines on 5-6, the first change order on 7.
    expect(rowBreakIds(wb.getWorksheet('G703')!)).toEqual([6]);
    const none = await buildAiaWorkbookFromTemplate(await makeTemplateBuffer(), mapping, ctx);
    expect(rowBreakIds(none.getWorksheet('G703')!)).toEqual([]);
  });

  it('a one-sheet template gets the G703 rules', async () => {
    const tpl = new ExcelJS.Workbook();
    tpl.addWorksheet('AIA');
    const wb = await buildAiaWorkbookFromTemplate(await tpl.xlsx.writeBuffer() as ArrayBuffer, { ...mapping, g702Sheet: 'AIA', g703Sheet: 'AIA' }, withCo);
    expect(wb.getWorksheet('AIA')!.pageSetup).toMatchObject({ fitToWidth: 1, fitToHeight: 0 });
  });
});
