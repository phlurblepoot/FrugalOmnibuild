// Generated files for the demo company: a two-sheet plan set (PDF), sheet
// thumbnails, a logo, site photos, simple document PDFs and a spreadsheet.
// Everything is drawn here from scratch, so the demo never contains a real plan
// or a real photo. Used only by e2e/readme/demo-data.ts.
import { PDFDocument, StandardFonts, rgb, type PDFFont } from 'pdf-lib';
import ExcelJS from 'exceljs';
import sharp from 'sharp';

// ---------------------------------------------------------------------------
// Plan geometry. One unit on the plan is a foot; the canvas works in "image
// pixels", which are twice the PDF's points (the app renders PDFs at 2x).
// ---------------------------------------------------------------------------

export const SHEET_W_PT = 1296; // 18 in
export const SHEET_H_PT = 864; // 12 in
export const IMAGE_W = SHEET_W_PT * 2;
export const IMAGE_H = SHEET_H_PT * 2;
/** Image pixels per foot of the drawn building. */
export const PX_PER_FT = 40;
/** Where the building's top-left corner sits on the sheet, in image pixels. */
const ORIGIN_PX = { x: 220, y: 170 };

/** Image-pixel position of a point given in feet from the building's top-left. */
export function planPoint(ftX: number, ftY: number): { x: number; y: number } {
  return { x: ORIGIN_PX.x + ftX * PX_PER_FT, y: ORIGIN_PX.y + ftY * PX_PER_FT };
}

export interface Room { name: string; x: number; y: number; w: number; h: number }

/** The floor plan, in feet. Rooms tile a 48 x 32 ft rectangle exactly. */
export const ROOMS: Room[] = [
  { name: 'Living Room', x: 0, y: 0, w: 20, h: 18 },
  { name: 'Kitchen', x: 20, y: 0, w: 14, h: 14 },
  { name: 'Dining', x: 34, y: 0, w: 14, h: 14 },
  { name: 'Hall', x: 20, y: 14, w: 28, h: 4 },
  { name: 'Bedroom 1', x: 0, y: 18, w: 16, h: 14 },
  { name: 'Bath', x: 16, y: 18, w: 10, h: 14 },
  { name: 'Bedroom 2', x: 26, y: 18, w: 12, h: 14 },
  { name: 'Bedroom 3', x: 38, y: 18, w: 10, h: 14 },
];
export const HOUSE = { w: 48, h: 32 };

/** Elevation sheet, in feet: ground line at the bottom of the walls. */
export const ELEV = { w: 48, wallH: 10, roofH: 6, groundPx: 1180 };
export const ELEV_WINDOWS = [
  { x: 5, y: 3.5, w: 5, h: 4.5 },
  { x: 14, y: 3.5, w: 5, h: 4.5 },
  { x: 29, y: 3.5, w: 5, h: 4.5 },
  { x: 38, y: 3.5, w: 5, h: 4.5 },
];
export const ELEV_DOOR = { x: 22, y: 0, w: 3.5, h: 7 };

/** Image-pixel position of an elevation point (feet right of the left wall, feet above ground). */
export function elevPoint(ftX: number, ftUp: number): { x: number; y: number } {
  return { x: ORIGIN_PX.x + ftX * PX_PER_FT, y: ELEV.groundPx - ftUp * PX_PER_FT };
}

// ---------------------------------------------------------------------------
// A tiny shape list that renders to both a PDF page and an SVG (for the
// thumbnail). Coordinates are PDF points measured from the top-left.
// ---------------------------------------------------------------------------

type Shape =
  | { t: 'rect'; x: number; y: number; w: number; h: number; stroke?: string; fill?: string; lw?: number }
  | { t: 'line'; x1: number; y1: number; x2: number; y2: number; stroke?: string; lw?: number; dash?: boolean }
  | { t: 'poly'; pts: [number, number][]; stroke?: string; fill?: string; lw?: number }
  | { t: 'text'; x: number; y: number; size: number; text: string; bold?: boolean; color?: string; anchor?: 'start' | 'middle' };

const INK = '#1f2937';
const PAPER = '#fdfdfb';
const GREY = '#6b7280';
const WALL = '#111827';

/** Image pixels to points. */
const pt = (px: number) => px / 2;

function titleBlock(sheetNo: string, sheetTitle: string): Shape[] {
  const y0 = SHEET_H_PT - 96;
  const s: Shape[] = [
    { t: 'rect', x: 24, y: 24, w: SHEET_W_PT - 48, h: SHEET_H_PT - 48, stroke: INK, lw: 1.5 },
    { t: 'rect', x: 24, y: y0, w: SHEET_W_PT - 48, h: 72, stroke: INK, lw: 1 },
    { t: 'line', x1: 640, y1: y0, x2: 640, y2: y0 + 72, stroke: INK, lw: 1 },
    { t: 'line', x1: 960, y1: y0, x2: 960, y2: y0 + 72, stroke: INK, lw: 1 },
    { t: 'text', x: 40, y: y0 + 22, size: 11, text: 'PROJECT', color: GREY },
    { t: 'text', x: 40, y: y0 + 50, size: 26, text: 'EXAMPLE RESIDENCE', bold: true, color: INK },
    { t: 'text', x: 656, y: y0 + 22, size: 11, text: 'SHEET TITLE', color: GREY },
    { t: 'text', x: 656, y: y0 + 50, size: 20, text: sheetTitle.toUpperCase(), bold: true, color: INK },
    { t: 'text', x: 976, y: y0 + 22, size: 11, text: 'SHEET NO.', color: GREY },
    { t: 'text', x: 976, y: y0 + 58, size: 36, text: sheetNo, bold: true, color: INK },
    { t: 'text', x: 1100, y: y0 + 22, size: 11, text: 'DRAWN FOR', color: GREY },
    { t: 'text', x: 1100, y: y0 + 40, size: 12, text: 'Harbor View Builders', color: INK },
    { t: 'text', x: 1100, y: y0 + 56, size: 12, text: '123 Example St, Riverton', color: INK },
  ];
  return s;
}

function floorPlanShapes(): Shape[] {
  const ox = pt(ORIGIN_PX.x), oy = pt(ORIGIN_PX.y);
  const ft = PX_PER_FT / 2; // points per foot
  const s: Shape[] = [{ t: 'rect', x: 0, y: 0, w: SHEET_W_PT, h: SHEET_H_PT, fill: PAPER }];
  // Interior partitions (rooms), then the heavy exterior wall.
  for (const r of ROOMS) {
    s.push({ t: 'rect', x: ox + r.x * ft, y: oy + r.y * ft, w: r.w * ft, h: r.h * ft, stroke: WALL, lw: 2 });
    s.push({ t: 'text', x: ox + r.x * ft + 8, y: oy + r.y * ft + 20, size: 14, text: r.name, color: INK });
    s.push({ t: 'text', x: ox + r.x * ft + 8, y: oy + r.y * ft + 34, size: 10, text: `${r.w}' x ${r.h}'`, color: GREY });
  }
  s.push({ t: 'rect', x: ox, y: oy, w: HOUSE.w * ft, h: HOUSE.h * ft, stroke: WALL, lw: 6 });
  // Door openings drawn as gaps in white with a swing line.
  const gaps: [number, number, number, number][] = [
    [8, 0, 3, 0], // front door (top wall)
    [20, 6, 0, 3], // living to kitchen
    [10, 18, 3, 0], // living to bedroom 1
    [16, 24, 0, 3], // bedroom 1 to bath
    [32, 18, 3, 0], // hall to bedroom 2
    [42, 18, 3, 0], // hall to bedroom 3
  ];
  for (const [gx, gy, gw, gh] of gaps) {
    const w = gw ? gw * ft : 7;
    const h = gh ? gh * ft : 7;
    s.push({ t: 'rect', x: ox + gx * ft - (gw ? 0 : 3.5), y: oy + gy * ft - (gh ? 0 : 3.5), w, h, fill: PAPER });
  }
  // Windows on the outer wall.
  for (const [wx, wy, ww, wh] of [[4, 0, 6, 0], [24, 0, 6, 0], [38, 0, 6, 0], [4, 32, 6, 0], [30, 32, 6, 0], [40, 32, 5, 0], [0, 6, 0, 6], [48, 5, 0, 5]] as const) {
    const w = ww ? ww * ft : 8;
    const h = wh ? wh * ft : 8;
    s.push({ t: 'rect', x: ox + wx * ft - (ww ? 0 : 4), y: oy + wy * ft - (wh ? 0 : 4), w, h, fill: '#dbeafe', stroke: INK, lw: 1 });
  }
  // Overall dimension strings.
  s.push({ t: 'line', x1: ox, y1: oy - 22, x2: ox + HOUSE.w * ft, y2: oy - 22, stroke: GREY, lw: 1 });
  s.push({ t: 'text', x: ox + (HOUSE.w * ft) / 2, y: oy - 28, size: 13, text: `${HOUSE.w}'-0"`, anchor: 'middle', color: GREY });
  s.push({ t: 'line', x1: ox + HOUSE.w * ft + 22, y1: oy, x2: ox + HOUSE.w * ft + 22, y2: oy + HOUSE.h * ft, stroke: GREY, lw: 1 });
  s.push({ t: 'text', x: ox + HOUSE.w * ft + 30, y: oy + (HOUSE.h * ft) / 2, size: 13, text: `${HOUSE.h}'-0"`, color: GREY });
  s.push({ t: 'text', x: ox, y: oy + HOUSE.h * ft + 34, size: 14, text: 'FLOOR PLAN   SCALE: 1/4" = 1\'-0"', bold: true, color: INK });
  return [...s, ...titleBlock('A-101', 'Floor Plan')];
}

function elevationShapes(): Shape[] {
  const ox = pt(ORIGIN_PX.x);
  const ft = PX_PER_FT / 2;
  const ground = pt(ELEV.groundPx);
  const s: Shape[] = [{ t: 'rect', x: 0, y: 0, w: SHEET_W_PT, h: SHEET_H_PT, fill: PAPER }];
  const wallTop = ground - ELEV.wallH * ft;
  s.push({ t: 'line', x1: ox - 60, y1: ground, x2: ox + ELEV.w * ft + 60, y2: ground, stroke: WALL, lw: 3 });
  s.push({ t: 'rect', x: ox, y: wallTop, w: ELEV.w * ft, h: ELEV.wallH * ft, stroke: WALL, fill: '#f3efe6', lw: 3 });
  s.push({
    t: 'poly',
    pts: [[ox - 12, wallTop], [ox + (ELEV.w * ft) / 2, wallTop - ELEV.roofH * ft], [ox + ELEV.w * ft + 12, wallTop]],
    stroke: WALL, fill: '#d6d3d1', lw: 3,
  });
  for (const w of ELEV_WINDOWS) {
    s.push({ t: 'rect', x: ox + w.x * ft, y: ground - (w.y + w.h) * ft, w: w.w * ft, h: w.h * ft, stroke: INK, fill: '#dbeafe', lw: 2 });
    s.push({ t: 'line', x1: ox + (w.x + w.w / 2) * ft, y1: ground - (w.y + w.h) * ft, x2: ox + (w.x + w.w / 2) * ft, y2: ground - w.y * ft, stroke: INK, lw: 1 });
  }
  s.push({ t: 'rect', x: ox + ELEV_DOOR.x * ft, y: ground - ELEV_DOOR.h * ft, w: ELEV_DOOR.w * ft, h: ELEV_DOOR.h * ft, stroke: INK, fill: '#9ca3af', lw: 2 });
  s.push({ t: 'text', x: ox, y: ground + 46, size: 14, text: 'FRONT ELEVATION   SCALE: 1/4" = 1\'-0"', bold: true, color: INK });
  s.push({ t: 'text', x: ox, y: ground + 66, size: 11, text: 'Finish: three-coat cement stucco, sand float', color: GREY });
  return [...s, ...titleBlock('A-201', 'Exterior Elevation')];
}

const hex = (h: string) => {
  const n = parseInt(h.slice(1), 16);
  return rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
};

function drawShapesOnPdf(page: ReturnType<PDFDocument['addPage']>, shapes: Shape[], font: PDFFont, bold: PDFFont): void {
  const H = page.getHeight();
  for (const sh of shapes) {
    if (sh.t === 'rect') {
      page.drawRectangle({
        x: sh.x, y: H - sh.y - sh.h, width: sh.w, height: sh.h,
        color: sh.fill ? hex(sh.fill) : undefined,
        borderColor: sh.stroke ? hex(sh.stroke) : undefined,
        borderWidth: sh.stroke ? sh.lw ?? 1 : 0,
      });
    } else if (sh.t === 'line') {
      page.drawLine({
        start: { x: sh.x1, y: H - sh.y1 }, end: { x: sh.x2, y: H - sh.y2 },
        thickness: sh.lw ?? 1, color: hex(sh.stroke ?? INK),
      });
    } else if (sh.t === 'poly') {
      // drawSvgPath flips Y itself, so feed it top-left coordinates.
      const svgPath = sh.pts.map(([x, y], i) => `${i ? 'L' : 'M'} ${x} ${y}`).join(' ') + ' Z';
      page.drawSvgPath(svgPath, {
        x: 0, y: H,
        color: sh.fill ? hex(sh.fill) : undefined,
        borderColor: sh.stroke ? hex(sh.stroke) : undefined,
        borderWidth: sh.stroke ? sh.lw ?? 1 : 0,
      });
    } else {
      const f = sh.bold ? bold : font;
      const width = f.widthOfTextAtSize(sh.text, sh.size);
      page.drawText(sh.text, {
        x: sh.anchor === 'middle' ? sh.x - width / 2 : sh.x, y: H - sh.y,
        size: sh.size, font: f, color: hex(sh.color ?? INK),
      });
    }
  }
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function shapesToSvg(shapes: Shape[], width: number, height: number): string {
  const body = shapes.map(sh => {
    if (sh.t === 'rect') {
      return `<rect x="${sh.x}" y="${sh.y}" width="${sh.w}" height="${sh.h}" fill="${sh.fill ?? 'none'}" stroke="${sh.stroke ?? 'none'}" stroke-width="${sh.lw ?? 1}"/>`;
    }
    if (sh.t === 'line') {
      return `<line x1="${sh.x1}" y1="${sh.y1}" x2="${sh.x2}" y2="${sh.y2}" stroke="${sh.stroke ?? INK}" stroke-width="${sh.lw ?? 1}"/>`;
    }
    if (sh.t === 'poly') {
      return `<polygon points="${sh.pts.map(p => p.join(',')).join(' ')}" fill="${sh.fill ?? 'none'}" stroke="${sh.stroke ?? 'none'}" stroke-width="${sh.lw ?? 1}"/>`;
    }
    return `<text x="${sh.x}" y="${sh.y}" font-family="Helvetica, Arial, sans-serif" font-size="${sh.size}" font-weight="${sh.bold ? 700 : 400}" fill="${sh.color ?? INK}" text-anchor="${sh.anchor ?? 'start'}">${esc(sh.text)}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${SHEET_W_PT} ${SHEET_H_PT}">${body}</svg>`;
}

export interface PlanSet {
  pdf: Buffer;
  /** One small PNG per sheet, in sheet order. */
  thumbnails: Buffer[];
}

/** The two-sheet plan set: A-101 floor plan and A-201 elevation. */
export async function buildPlanSet(): Promise<PlanSet> {
  const sheets = [floorPlanShapes(), elevationShapes()];
  const doc = await PDFDocument.create();
  doc.setTitle('Example Residence - Plan Set');
  doc.setAuthor('Example Design Group');
  doc.setProducer('FrugalOmnibuild demo seed');
  doc.setCreator('FrugalOmnibuild demo seed');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (const shapes of sheets) {
    const page = doc.addPage([SHEET_W_PT, SHEET_H_PT]);
    drawShapesOnPdf(page, shapes, font, bold);
  }
  const thumbnails: Buffer[] = [];
  for (const shapes of sheets) {
    thumbnails.push(await sharp(Buffer.from(shapesToSvg(shapes, 360, 240))).png().toBuffer());
  }
  return { pdf: Buffer.from(await doc.save()), thumbnails };
}

// ---------------------------------------------------------------------------
// Logo and site photos (drawn, not photographed).
// ---------------------------------------------------------------------------

/** A small square mark for the company logo, as a PNG data URL. */
export async function logoDataUrl(): Promise<string> {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="240" viewBox="0 0 240 240">
    <rect width="240" height="240" rx="48" fill="#1f4d3a"/>
    <path d="M40 176 L120 52 L200 176 Z" fill="#f4efe3"/>
    <rect x="96" y="124" width="48" height="52" rx="6" fill="#1f4d3a"/>
    <rect x="40" y="176" width="160" height="12" fill="#c9a96a"/>
  </svg>`;
  const png = await sharp(Buffer.from(svg)).png({ compressionLevel: 9 }).toBuffer();
  return `data:image/png;base64,${png.toString('base64')}`;
}

export type PhotoKind = 'crack' | 'smooth' | 'scaffold' | 'patch' | 'corner';

/** A plain illustrated "site photo": a wall with one feature on it. 4:3. */
export async function sitePhoto(kind: PhotoKind): Promise<Buffer> {
  const wall = kind === 'smooth' ? '#e7e0d1' : '#d9d0bd';
  const features: Record<PhotoKind, string> = {
    crack: '<polyline points="300,120 340,220 310,300 370,400 340,470" fill="none" stroke="#4b4036" stroke-width="5"/>',
    smooth: '<rect x="120" y="100" width="560" height="360" fill="#ece6d8"/><line x1="120" y1="280" x2="680" y2="280" stroke="#d2c9b4" stroke-width="3"/>',
    scaffold: '<g stroke="#6b7280" stroke-width="10"><line x1="140" y1="40" x2="140" y2="560"/><line x1="660" y1="40" x2="660" y2="560"/><line x1="140" y1="200" x2="660" y2="200"/><line x1="140" y1="400" x2="660" y2="400"/></g><rect x="150" y="190" width="500" height="14" fill="#a16207"/><rect x="150" y="390" width="500" height="14" fill="#a16207"/>',
    patch: '<rect x="280" y="200" width="240" height="190" fill="#bfb49b"/><rect x="300" y="220" width="200" height="150" fill="#cdc3ab"/>',
    corner: '<polygon points="400,0 800,0 800,600 400,600" fill="#c8bea8"/><line x1="400" y1="0" x2="400" y2="600" stroke="#8c8270" stroke-width="6"/>',
  };
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="800" height="600" viewBox="0 0 800 600">
    <rect width="800" height="600" fill="${wall}"/>
    <rect y="520" width="800" height="80" fill="#8a8f98"/>
    ${features[kind]}
  </svg>`;
  return sharp(Buffer.from(svg)).png({ compressionLevel: 9, palette: true }).toBuffer();
}

// ---------------------------------------------------------------------------
// Simple one-page document PDFs and a spreadsheet for the Documents screens.
// ---------------------------------------------------------------------------

export interface DocPdfSpec {
  title: string;
  subtitle?: string;
  /** Label / value rows, printed as a two-column table. */
  rows?: [string, string][];
  /** Free paragraphs under the table. */
  paragraphs?: string[];
}

export async function simpleDocPdf(spec: DocPdfSpec): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setProducer('FrugalOmnibuild demo seed');
  doc.setCreator('FrugalOmnibuild demo seed');
  doc.setAuthor('Cedar Point Plastering');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const page = doc.addPage([612, 792]);
  page.drawRectangle({ x: 0, y: 742, width: 612, height: 50, color: hex('#1f4d3a') });
  page.drawText('CEDAR POINT PLASTERING', { x: 40, y: 760, size: 16, font: bold, color: rgb(1, 1, 1) });
  page.drawText('Riverton  |  (555) 010-0142  |  office@example.com', { x: 330, y: 762, size: 9, font, color: rgb(1, 1, 1) });
  let y = 700;
  page.drawText(spec.title, { x: 40, y, size: 20, font: bold, color: hex(INK) });
  y -= 22;
  if (spec.subtitle) { page.drawText(spec.subtitle, { x: 40, y, size: 11, font, color: hex(GREY) }); y -= 28; }
  for (const [k, v] of spec.rows ?? []) {
    page.drawText(k, { x: 40, y, size: 10, font: bold, color: hex(INK) });
    page.drawText(v, { x: 200, y, size: 10, font, color: hex(INK) });
    page.drawLine({ start: { x: 40, y: y - 6 }, end: { x: 572, y: y - 6 }, thickness: 0.5, color: hex('#d1d5db') });
    y -= 22;
  }
  y -= 8;
  for (const para of spec.paragraphs ?? []) {
    const words = para.split(/\s+/);
    let line = '';
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, 10) > 520) {
        page.drawText(line, { x: 40, y, size: 10, font, color: hex(INK) });
        y -= 14;
        line = w;
      } else line = next;
    }
    if (line) { page.drawText(line, { x: 40, y, size: 10, font, color: hex(INK) }); y -= 20; }
  }
  return Buffer.from(await doc.save());
}

/** A multi-page PDF of the given sheets, for the merge and append demos. */
export async function pageSetPdf(title: string, pages: number): Promise<Buffer> {
  const doc = await PDFDocument.create();
  doc.setProducer('FrugalOmnibuild demo seed');
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  for (let i = 1; i <= pages; i++) {
    const page = doc.addPage([612, 792]);
    page.drawText(title, { x: 50, y: 720, size: 22, font: bold, color: hex(INK) });
    page.drawText(`Page ${i} of ${pages}`, { x: 50, y: 694, size: 12, font, color: hex(GREY) });
    page.drawLine({ start: { x: 50, y: 680 }, end: { x: 562, y: 680 }, thickness: 1, color: hex('#d1d5db') });
    for (let l = 0; l < 14; l++) {
      page.drawRectangle({ x: 50, y: 640 - l * 28, width: l % 4 === 3 ? 300 : 512, height: 8, color: hex('#e5e7eb') });
    }
  }
  return Buffer.from(await doc.save());
}

export async function summarySpreadsheet(rows: [string, number, string, number][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Cedar Point Plastering';
  const ws = wb.addWorksheet('Material summary');
  ws.columns = [
    { header: 'Item', key: 'item', width: 32 },
    { header: 'Quantity', key: 'qty', width: 12 },
    { header: 'Unit', key: 'unit', width: 8 },
    { header: 'Unit cost', key: 'cost', width: 12 },
    { header: 'Total', key: 'total', width: 12 },
  ];
  ws.getRow(1).font = { bold: true };
  rows.forEach(([item, qty, unit, cost], i) => {
    ws.addRow({ item, qty, unit, cost, total: { formula: `B${i + 2}*D${i + 2}`, result: qty * cost } });
  });
  return Buffer.from(await wb.xlsx.writeBuffer());
}
