// src/pages/project/billing/aiaExcel.test.ts
//
// exceljs is a node-oriented library; the workbook builder is pure (no DOM), so
// these tests assert STRUCTURE + the reconciling NUMBERS — not pixel layout.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { buildAiaWorkbook, buildAiaXlsxBlob, exportAiaXlsx, type AiaExportCtx } from './aiaExcel';
import { downloadBlob } from '../../../utils/download';
import type { AiaG702, AiaG703Row, AiaSovLine, AiaPayApp, AiaSettings } from '../../../utils/store';

// The download is the one impure edge of this module; stubbing it keeps the
// build-vs-deliver split observable without touching jsdom's URL plumbing.
vi.mock('../../../utils/download', () => ({ downloadBlob: vi.fn() }));
beforeEach(() => { vi.mocked(downloadBlob).mockReset(); });

// Two SOV lines + one change-order line. Cents chosen so totals reconcile.
const sovLines: AiaSovLine[] = [
  { id: 'sov1', projectId: 'p1', itemNo: '001', description: 'Mobilization', scheduledValueCents: 100000, retainagePercent: null, isChangeOrder: 0, changeOrderId: null, sortOrder: 0, version: 1, createdAt: 0 },
  { id: 'sov2', projectId: 'p1', itemNo: '002', description: 'Framing', scheduledValueCents: 500000, retainagePercent: null, isChangeOrder: 0, changeOrderId: null, sortOrder: 1, version: 1, createdAt: 0 },
  { id: 'sov3', projectId: 'p1', itemNo: 'CO-1', description: 'Extra door', scheduledValueCents: 50000, retainagePercent: null, isChangeOrder: 1, changeOrderId: 'co1', sortOrder: 2, version: 1, createdAt: 0 },
];

const g703: AiaG703Row[] = [
  { sovLineId: 'sov1', itemNo: '001', description: 'Mobilization', isChangeOrder: 0, scheduledValueCents: 100000, previousCents: 50000, thisPeriodCents: 50000, storedCents: 0, totalToDateCents: 100000, percentComplete: 100, balanceToFinishCents: 0, retainageCents: 10000 },
  { sovLineId: 'sov2', itemNo: '002', description: 'Framing', isChangeOrder: 0, scheduledValueCents: 500000, previousCents: 100000, thisPeriodCents: 150000, storedCents: 50000, totalToDateCents: 300000, percentComplete: 60, balanceToFinishCents: 200000, retainageCents: 30000 },
  { sovLineId: 'sov3', itemNo: 'CO-1', description: 'Extra door', isChangeOrder: 1, scheduledValueCents: 50000, previousCents: 0, thisPeriodCents: 25000, storedCents: 0, totalToDateCents: 25000, percentComplete: 50, balanceToFinishCents: 25000, retainageCents: 2500 },
];

// ΣC = 650000 (L3), ΣG = 425000 (L4), ΣRet = 42500 (L5).
const g702: AiaG702 = {
  L1originalContractCents: 600000,
  L2changeOrdersCents: 50000,
  L3contractSumToDateCents: 650000,
  L4totalCompletedStoredCents: 425000,
  L5aRetainageWorkCents: 37500,
  L5bRetainageStoredCents: 5000,
  L5retainageCents: 42500,
  L6earnedLessRetainageCents: 382500,
  L7lessPreviousCents: 135000,
  L8currentPaymentDueCents: 247500,
  L9balanceToFinishCents: 267500,
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
  contractor: 'GC Builders Inc',
  company: { name: 'My Co', address: '3 Co Blvd', phone: '555', email: 'a@b.com' },
  aiaSettings, app, sovLines, g702, g703,
};

// The stub ctx has 2 contract lines + 1 change-order line. Contract items start
// at row 11, so the dynamic anchors are:
const N = 2; // contract lines
const M = 1; // change-order lines
const CONTRACT_START = 11;
const CONTRACT_TOTAL_ROW = CONTRACT_START + N;          // 13
const CO_LABEL_ROW = CONTRACT_TOTAL_ROW + 2;            // 15
const CO_HEADER_TOP = CO_LABEL_ROW + 2;                 // 17
const CO_START = CO_HEADER_TOP + 4;                     // 21
const CO_TOTAL_ROW = CO_START + M;                      // 22
const GRAND_ROW = CO_TOTAL_ROW + 1;                     // 23

// exceljs stores a formula cell as { formula, result? }; extract the formula.
const formulaOf = (cell: unknown): string | undefined =>
  cell && typeof cell === 'object' && 'formula' in (cell as Record<string, unknown>)
    ? String((cell as { formula: string }).formula)
    : undefined;

describe('buildAiaWorkbook', () => {
  it('creates a workbook with sheets G702 then G703 (G702 first)', async () => {
    const wb = await buildAiaWorkbook(ctx);
    expect(wb.getWorksheet('G702')).toBeDefined();
    expect(wb.getWorksheet('G703')).toBeDefined();
    expect(wb.worksheets.map((w) => w.name)).toEqual(['G702', 'G703']);
  });

  it('G703 contract TOTALS row sits at 11 + N (dynamic) with SUM formulas', async () => {
    const wb = await buildAiaWorkbook(ctx);
    const ws = wb.getWorksheet('G703')!;

    expect(ws.getCell(`B${CONTRACT_TOTAL_ROW}`).value).toBe('TOTALS');
    expect(formulaOf(ws.getCell(`C${CONTRACT_TOTAL_ROW}`).value))
      .toBe(`SUM(C${CONTRACT_START}:C${CONTRACT_TOTAL_ROW - 1})`);
    expect(formulaOf(ws.getCell(`G${CONTRACT_TOTAL_ROW}`).value))
      .toBe(`SUM(G${CONTRACT_START}:G${CONTRACT_TOTAL_ROW - 1})`);
  });

  it('G703 change-order TOTALS + GRAND TOTAL rows sit at the expected dynamic positions', async () => {
    const wb = await buildAiaWorkbook(ctx);
    const ws = wb.getWorksheet('G703')!;

    expect(ws.getCell(`B${CO_LABEL_ROW}`).value).toBe('Change Orders');
    expect(ws.getCell(`B${CO_TOTAL_ROW}`).value).toBe('TOTALS');
    expect(formulaOf(ws.getCell(`C${CO_TOTAL_ROW}`).value))
      .toBe(`SUM(C${CO_START}:C${CO_TOTAL_ROW - 1})`);

    expect(ws.getCell(`B${GRAND_ROW}`).value).toBe('GRAND TOTAL');
    expect(formulaOf(ws.getCell(`C${GRAND_ROW}`).value))
      .toBe(`C${CONTRACT_TOTAL_ROW}+C${CO_TOTAL_ROW}`);
  });

  it('G703 item rows hold cents/100 inputs and live G/H/I/J formulas', async () => {
    const wb = await buildAiaWorkbook(ctx);
    const ws = wb.getWorksheet('G703')!;

    // First contract line = g703[0] (Mobilization).
    expect(ws.getCell(`B${CONTRACT_START}`).value).toBe('Mobilization');
    expect(ws.getCell(`C${CONTRACT_START}`).value).toBe(g703[0].scheduledValueCents / 100);
    expect(ws.getCell(`D${CONTRACT_START}`).value).toBe(g703[0].previousCents / 100);
    expect(ws.getCell(`E${CONTRACT_START}`).value).toBe(g703[0].thisPeriodCents / 100);
    expect(ws.getCell(`F${CONTRACT_START}`).value).toBe(g703[0].storedCents / 100);
    expect(formulaOf(ws.getCell(`G${CONTRACT_START}`).value))
      .toBe(`D${CONTRACT_START}+E${CONTRACT_START}+F${CONTRACT_START}`);
    expect(formulaOf(ws.getCell(`J${CONTRACT_START}`).value))
      .toBe(`SUM(D${CONTRACT_START}:E${CONTRACT_START})*'G702'!$G$22`);

    // The CO line input sits at CO_START.
    expect(ws.getCell(`B${CO_START}`).value).toBe('Extra door');
    expect(ws.getCell(`C${CO_START}`).value).toBe(g703[2].scheduledValueCents / 100);
  });

  it('G702 carries the inputs and anchors its 9 lines to the dynamic G703 rows', async () => {
    const wb = await buildAiaWorkbook(ctx);
    const ws = wb.getWorksheet('G702')!;

    // Inputs.
    expect(ws.getCell('D6').value).toBe(ctx.contractor);      // G.C. = project contractor
    expect(ws.getCell('B3').value).toBe(ctx.aiaSettings.ownerName); // owner (when entered)
    expect(ws.getCell('B7').value).toBe(ctx.company.name);    // FROM = our company
    expect(ws.getCell('D3').value).toBe(ctx.projectName);     // project
    expect(ws.getCell('H3').value).toBe(app.number);          // application #
    expect(ws.getCell('H6').value).toBe(app.periodTo);        // period to
    expect(ws.getCell('G22').value).toBeCloseTo(app.retainagePercent / 100, 4); // rate

    // Line 1 (ORIGINAL CONTRACT SUM) references the dynamic contract TOTALS C cell.
    expect(formulaOf(ws.getCell('H14').value)).toBe(`'G703'!C${CONTRACT_TOTAL_ROW}`);
    // Line 4 references contract + CO TOTALS G cells.
    expect(formulaOf(ws.getCell('H20').value))
      .toBe(`'G703'!G${CONTRACT_TOTAL_ROW}+'G703'!G${CO_TOTAL_ROW}`);
    // Line 5 (retainage) references contract + CO TOTALS J cells.
    expect(formulaOf(ws.getCell('H22').value))
      .toBe(`'G703'!J${CONTRACT_TOTAL_ROW}+'G703'!J${CO_TOTAL_ROW}`);
  });

  it('leaves the Application No blank for a zero-numbered (blank SOV) app', async () => {
    const wb = await buildAiaWorkbook({ ...ctx, app: { ...ctx.app, number: 0 } });
    const g702 = wb.getWorksheet('G702')!;
    expect(g702.getCell('H3').value).toBe('');
  });

  it('guards H-column % formulas with IFERROR to prevent #DIV/0! on zero sections', async () => {
    // Blank SOV export: no change-order lines, zero CO sums in g702.
    const blankCtx: AiaExportCtx = {
      ...ctx,
      g703: g703.filter((row) => !row.isChangeOrder), // contract only, no COs
      g702: {
        ...ctx.g702,
        changeOrders: { additionsCents: 0, deductionsCents: 0, netCents: 0 },
      },
    };

    const wb = await buildAiaWorkbook(blankCtx);
    const ws = wb.getWorksheet('G703')!;

    // With zero CO lines, the CO TOTALS row will divide by zero (empty section).
    // CO layout: contract section rows 11-12 (2 items), TOTALS 13, then
    // CO-label 15, CO-header 17, CO-start 21, CO-totals (0 items) 21.
    const coZeroTotalRow = CO_START; // when no CO items, TOTALS sits at CO_START

    // Item-row H formula should contain IFERROR.
    const itemFormula = formulaOf(ws.getCell(`H${CONTRACT_START}`).value);
    expect(itemFormula).toContain('IFERROR');
    expect(itemFormula).toContain(`G${CONTRACT_START}/C${CONTRACT_START}`);

    // CO TOTALS-row H formula should also contain IFERROR (protects against C=0).
    const coTotalFormula = formulaOf(ws.getCell(`H${coZeroTotalRow}`).value);
    expect(coTotalFormula).toContain('IFERROR');
  });

  it('uniform mode writes the EFFECTIVE (post-release) rate to G22, not the raw app rate', async () => {
    // Base rate is 10, but 4 points were already released before/at this app.
    const releasedCtx: AiaExportCtx = {
      ...ctx,
      g702: {
        ...ctx.g702,
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

    const wb = await buildAiaWorkbook(releasedCtx);
    const ws = wb.getWorksheet('G702')!;

    expect(ws.getCell('G22').value).toBeCloseTo(0.06, 4);
    expect(ws.getCell('G22').value).not.toBeCloseTo(releasedCtx.app.retainagePercent / 100, 4);
    // Formula structure is untouched in uniform mode.
    expect(formulaOf(ws.getCell('H22').value))
      .toBe(`'G703'!J${CONTRACT_TOTAL_ROW}+'G703'!J${CO_TOTAL_ROW}`);
  });

  it('uniform mode keeps the legacy back-derived Line 7 formula when nothing has been released', async () => {
    const wb = await buildAiaWorkbook(ctx); // cumulativeReleasedPoints: 0
    const ws = wb.getWorksheet('G702')!;
    expect(formulaOf(ws.getCell('H26').value))
      .toBe(`'G703'!D${GRAND_ROW}-('G703'!D${GRAND_ROW}*'G702'!G22)`);
  });

  it('uniform mode with a release writes Line 7 as a literal so Line 8 still pays out the released retainage', async () => {
    // Mirrors the server fixture: one $100,000 line at 50%, base retainage 15,
    // 5 points released on this application.
    //   app #1: retainage 15% of 5,000,000 → L6 = 4,250,000
    //   app #2: effective 10%            → L6 = 4,500,000, L7 = 4,250,000
    //   L8 = 250,000 cents = $2,500 (exactly the 5 released points)
    // The legacy formula would back-derive L7 as D_grand − D_grand*G22 =
    // 50,000 − 5,000 = 45,000 — i.e. equal to L6, exporting L8 as $0 on the
    // one application that actually releases the money.
    const releaseG703: AiaG703Row[] = [
      {
        sovLineId: 'sov1', itemNo: '001', description: 'Line 1', isChangeOrder: 0,
        scheduledValueCents: 10000000, previousCents: 5000000, thisPeriodCents: 0,
        storedCents: 0, totalToDateCents: 5000000, percentComplete: 50,
        balanceToFinishCents: 5000000, retainageCents: 500000,
      },
    ];
    const releaseCtx: AiaExportCtx = {
      ...ctx,
      sovLines: [sovLines[0]],
      g703: releaseG703,
      g702: {
        L1originalContractCents: 10000000,
        L2changeOrdersCents: 0,
        L3contractSumToDateCents: 10000000,
        L4totalCompletedStoredCents: 5000000,
        L5aRetainageWorkCents: 500000,
        L5bRetainageStoredCents: 0,
        L5retainageCents: 500000,
        L6earnedLessRetainageCents: 4500000,
        L7lessPreviousCents: 4250000,
        L8currentPaymentDueCents: 250000,
        L9balanceToFinishCents: 5500000,
        changeOrders: { additionsCents: 0, deductionsCents: 0, netCents: 0 },
        retainage: {
          mode: 'uniform',
          baseWorkPercent: 15,
          cumulativeReleasedPoints: 5,
          releasedThisApp: 5,
          remainingPoints: 15,
          effectiveWorkPercent: 10, // 15 − 5
        },
      },
      app: { ...ctx.app, retainagePercent: 15, storedRetainagePercent: 15, releasedRetainagePoints: 5 },
    };

    const wb = await buildAiaWorkbook(releaseCtx);
    const g702ws = wb.getWorksheet('G702')!;
    const g703ws = wb.getWorksheet('G703')!;

    // One contract line, zero change orders → G703 anchors shift:
    // items 11, TOTALS 12, CO label 14, CO letters 15, CO header 16-19,
    // CO TOTALS (empty section) 20, GRAND TOTAL 21.
    const ONE_LINE_GRAND = 21;

    // Line 7 is the server's literal (prior application's Line 6), in dollars,
    // with H26 a trivial formula over it — NOT the G22 back-derivation.
    expect(g702ws.getCell('G26').value).toBe(42500);            // 4,250,000 cents
    expect(g702ws.getCell('G26').value).toBe(releaseCtx.g702.L7lessPreviousCents / 100);
    expect(formulaOf(g702ws.getCell('H26').value)).toBe('G26');
    expect(formulaOf(g702ws.getCell('H26').value)).not.toContain('G22');

    // Line 8 = H24 − H26, and H24 (Line 6) = G703 GRAND G − GRAND J.
    expect(formulaOf(g702ws.getCell('H28').value)).toBe('H24-H26');
    expect(formulaOf(g702ws.getCell('H24').value))
      .toBe(`'G703'!G${ONE_LINE_GRAND}-'G703'!J${ONE_LINE_GRAND}`);

    // Evaluate those inputs from the literal cells the sheet actually carries.
    const d = Number(g703ws.getCell(`D${CONTRACT_START}`).value);
    const e = Number(g703ws.getCell(`E${CONTRACT_START}`).value);
    const f = Number(g703ws.getCell(`F${CONTRACT_START}`).value);
    const rate = Number(g702ws.getCell('G22').value);
    expect(d).toBe(50000);          // previous applications, dollars
    expect(rate).toBeCloseTo(0.10, 4); // EFFECTIVE rate, not the base 15%

    const grandG = d + e + f;                 // 50,000
    const grandJ = (d + e) * rate;            // 5,000
    const L6 = grandG - grandJ;               // 45,000 — what H24 evaluates to
    const L7 = Number(g702ws.getCell('G26').value);
    expect(L6 - L7).toBeCloseTo(2500, 2);     // $2,500 released — matches the server
    expect(L6 - L7).toBeCloseTo(releaseCtx.g702.L8currentPaymentDueCents / 100, 2);

    // The legacy back-derivation on the same sheet would have paid nothing.
    const legacyL7 = grandG - grandG * rate;  // 45,000 == L6
    expect(L6 - legacyL7).toBeCloseTo(0, 2);
  });

  it('perLine mode writes 5a/5b as numeric literals from ctx.g702 and per-row G703 retainage as literals', async () => {
    const perLineCtx: AiaExportCtx = {
      ...ctx,
      g702: {
        ...ctx.g702,
        retainage: {
          mode: 'perLine',
          baseWorkPercent: 10,
          cumulativeReleasedPoints: 0,
          releasedThisApp: 0,
          remainingPoints: 10,
          effectiveWorkPercent: null,
        },
      },
    };

    const wb = await buildAiaWorkbook(perLineCtx);
    const g702ws = wb.getWorksheet('G702')!;
    const g703ws = wb.getWorksheet('G703')!;

    // 5a/5b are numeric literals equal to ctx.g702.L5a/L5b (dollars).
    expect(g702ws.getCell('F22').value).toBe(perLineCtx.g702.L5aRetainageWorkCents / 100);
    expect(g702ws.getCell('G22').value).toBe(perLineCtx.g702.L5bRetainageStoredCents / 100);
    // Line 5 total is a formula summing the two literals (no G703 cross-sheet SUM).
    expect(formulaOf(g702ws.getCell('H22').value)).toBe('F22+G22');

    // Line 7 (less previous certificates) no longer multiplies by G22 — it's
    // a literal from ctx.g702 referenced by a trivial formula.
    expect(g702ws.getCell('G26').value).toBe(perLineCtx.g702.L7lessPreviousCents / 100);
    expect(formulaOf(g702ws.getCell('H26').value)).toBe('G26');

    // G703 per-row J cells are literals equal to each row's retainageCents.
    expect(g703ws.getCell(`J${CONTRACT_START}`).value).toBe(g703[0].retainageCents / 100);
    expect(formulaOf(g703ws.getCell(`J${CONTRACT_START}`).value)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Build vs. download split (spec
// docs/superpowers/specs/2026-08-29-document-actions-rollout-design.md).
// DocumentActionsBar owns delivery now, so it needs the BYTES — the workbook
// builder must be reachable without a browser download firing as a side
// effect. `exportAiaXlsx` stays as the "just save it to disk" caller (the
// blank-SOV export on the Schedule of Values still uses it).

describe('buildAiaXlsxBlob / exportAiaXlsx', () => {
  it('buildAiaXlsxBlob returns xlsx bytes and downloads nothing', async () => {
    const blob = await buildAiaXlsxBlob(ctx);

    expect(blob).toBeInstanceOf(Blob);
    expect(blob.type).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    // A real workbook: .xlsx is a zip, so the bytes start with "PK".
    const head = new Uint8Array(await blob.arrayBuffer()).slice(0, 2);
    expect(Array.from(head)).toEqual([0x50, 0x4b]);
    expect(downloadBlob).not.toHaveBeenCalled();
  });

  it('exportAiaXlsx still hands the workbook to the browser, with the default name', async () => {
    await exportAiaXlsx(ctx);

    expect(downloadBlob).toHaveBeenCalledTimes(1);
    const [blob, name] = vi.mocked(downloadBlob).mock.calls[0];
    expect(blob).toBeInstanceOf(Blob);
    expect(name).toBe('AIA-Test_Project-App3.xlsx');
  });

  it('exportAiaXlsx persists before it downloads, and honours an explicit filename', async () => {
    const order: string[] = [];
    vi.mocked(downloadBlob).mockImplementation(() => { order.push('download'); });
    const persist = vi.fn(async (_blob: Blob) => { order.push('persist'); });

    await exportAiaXlsx(ctx, undefined, 'Blank-SOV.xlsx', persist);

    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist.mock.calls[0][0]).toBeInstanceOf(Blob);
    expect(order).toEqual(['persist', 'download']);
    expect(vi.mocked(downloadBlob).mock.calls[0][1]).toBe('Blank-SOV.xlsx');
  });
});

describe('header and blank rows (spec 2026-09-11)', () => {
  // item, header, item, blank, then a CO — the header/blank sit INSIDE the
  // contract block, so every anchor moves by 2 and every item formula must
  // still point at its own row.
  const header: AiaG703Row = { sovLineId: 'h1', itemNo: null, description: 'Interior', isChangeOrder: 0, lineType: 'header', scheduledValueCents: 0, previousCents: 0, thisPeriodCents: 0, storedCents: 0, totalToDateCents: 0, percentComplete: 0, balanceToFinishCents: 0, retainageCents: 0 };
  const blank: AiaG703Row = { ...header, sovLineId: 'b1', description: '', lineType: 'blank' };
  const mixed: AiaExportCtx = { ...ctx, g703: [g703[0], header, g703[1], blank, g703[2]] };

  it('writes a header as a bold description with no money/formula cells, and a blank as an empty row', async () => {
    const wb = await buildAiaWorkbook(mixed);
    const ws = wb.getWorksheet('G703')!;
    const headerRow = 12; // contractStart 11 + 1
    expect(ws.getCell(`B${headerRow}`).value).toBe('Interior');
    expect(ws.getCell(`B${headerRow}`).font?.bold).toBe(true);
    for (const col of ['C', 'D', 'E', 'F', 'G', 'H', 'I', 'J']) {
      expect(formulaOf(ws.getCell(`${col}${headerRow}`).value)).toBeUndefined();
      expect(ws.getCell(`${col}${headerRow}`).value ?? '').toBe('');
    }
    const blankRow = 14;
    for (const col of ['A', 'B', 'C', 'G', 'J']) expect(ws.getCell(`${col}${blankRow}`).value ?? '').toBe('');
  });

  it('keeps item formulas on their own rows and moves the totals/CO/grand anchors by the two extra rows', async () => {
    const wb = await buildAiaWorkbook(mixed);
    const ws = wb.getWorksheet('G703')!;
    expect(formulaOf(ws.getCell('G13').value)).toBe('D13+E13+F13'); // Framing now on row 13
    const contractTotalRow = CONTRACT_TOTAL_ROW + 2;
    expect(ws.getCell(`B${contractTotalRow}`).value).toBe('TOTALS');
    expect(formulaOf(ws.getCell(`C${contractTotalRow}`).value)).toBe(`SUM(C11:C${contractTotalRow - 1})`);
    expect(ws.getCell(`B${GRAND_ROW + 2}`).value).toBe('GRAND TOTAL');
    // G702 line 5 ("TOTAL EARNED LESS RETAINAGE") is written by buildG702 as
    // 'G703'!G<grand>-'G703'!J<grand> — it must point at the MOVED grand row.
    const g702ws = wb.getWorksheet('G702')!;
    let found = false;
    g702ws.eachRow(row => row.eachCell(cell => {
      const f = formulaOf(cell.value);
      if (f === `'G703'!G${GRAND_ROW + 2}-'G703'!J${GRAND_ROW + 2}`) found = true;
    }));
    expect(found).toBe(true);
  });
});

// The owner's PDF rules (2026-09-26): landscape, every column fitted to the page
// width, the G702 on one page, the G703 over as many pages as it needs with
// the change orders starting on a new page. "Make PDF" prints from these.
// exceljs keeps manual page breaks on the sheet but leaves them out of its types.
const rowBreakIds = (ws: object) => ((ws as { rowBreaks?: { id: number }[] }).rowBreaks ?? []).map(b => b.id);

describe('print layout', () => {
  it('G702: landscape Letter, all on one page', async () => {
    const ws = (await buildAiaWorkbook(ctx)).getWorksheet('G702')!;
    expect(ws.pageSetup).toMatchObject({ orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 1, paperSize: 1 });
  });

  it('G703: landscape, fitted to width, as tall as it needs, change orders on a new page', async () => {
    const ws = (await buildAiaWorkbook(ctx)).getWorksheet('G703')!;
    expect(ws.pageSetup).toMatchObject({ orientation: 'landscape', fitToPage: true, fitToWidth: 1, fitToHeight: 0 });
    expect(rowBreakIds(ws)).toEqual([CO_LABEL_ROW - 1]);
  });

  it('writes those settings into the file', async () => {
    const { default: JSZip } = await import('jszip');
    const blob = await buildAiaXlsxBlob(ctx);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    const sheets = await Promise.all(['xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml'].map(p => zip.file(p)!.async('string')));
    const [g702xml, g703xml] = sheets;
    for (const xml of sheets) {
      expect(xml).toContain('fitToPage="1"');
      expect(xml).toMatch(/<pageSetup[^>]*orientation="landscape"/);
    }
    expect(g702xml).toMatch(/<pageSetup[^>]*fitToHeight="1"/);
    expect(g703xml).toMatch(/<pageSetup[^>]*fitToHeight="0"/);
    expect(g703xml).toMatch(new RegExp(`<rowBreaks[^>]*>\\s*<brk id="${CO_LABEL_ROW - 1}"[^>]*man="1"`));
  });
});
