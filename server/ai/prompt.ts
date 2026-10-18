import type { SheetRead, SheetMatch, ExistingSheetRef, TranscribeMode, TranscribeResult } from './types';

/** Pull the first balanced JSON object out of a string, tolerant of surrounding prose. */
function extractJson(raw: string): any | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < raw.length; i++) {
    if (raw[i] === '{') depth++;
    else if (raw[i] === '}') {
      depth--;
      if (depth === 0) {
        try { return JSON.parse(raw.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

const clamp01 = (n: unknown): number => {
  const v = typeof n === 'number' && isFinite(n) ? n : 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
};

export function buildReadPrompt(embeddedText?: string): string {
  const hint = embeddedText && embeddedText.trim()
    ? `\n\nFor reference, here is text extracted from the drawing's PDF layer (may be noisy or incomplete). Prefer it when it agrees with what you see:\n"""${embeddedText.trim().slice(0, 2000)}"""`
    : '';
  return (
    `You are reading ONE sheet from a set of construction/architectural drawings. Extract:\n` +
    `- sheetNumber: the sheet's identifier from the title block (the strip along the right or bottom edge that holds the sheet number), ` +
    `e.g. "A-201", "S1.1", "RC-A-106", "A-300". Read each character and digit carefully. ` +
    `Ignore project/record numbers, revision numbers, room tags, and round detail-callout bubbles.\n` +
    `- sheetTitle, in this priority:\n` +
    `  (1) If a sheet title is printed IN THE TITLE BLOCK (right next to / above the sheet number), copy it VERBATIM, keeping any ` +
    `level/area/phase qualifier — e.g. "Level 06 Floor Plan", "Second Floor Plan".\n` +
    `  (2) Otherwise give ONE general category title for the WHOLE sheet. In this case it must name a category, not a single drawing; ` +
    `it must NOT contain a compass direction (North/South/East/West) or parentheses. The individual drawings may each carry their own ` +
    `label (e.g. "Front Elevation (South)", "Section A", "Detail 3") — do NOT copy one of those. Name the collective type instead: ` +
    `several building elevations -> "Exterior Elevations"; several sections -> "Building Sections"; a roof plan -> "Roof Plan"; ` +
    `enlarged details -> "Wall Details".\n` +
    `  Never use the heading of a legend, keynotes, or a notes table as the title.\n` +
    `- discipline: one of Architectural, Structural, Mechanical, Electrical, Plumbing, Civil, or similar.\n` +
    `Respond with ONLY a JSON object, no prose, exactly of the form ` +
    `{"sheetNumber": string, "sheetTitle": string, "discipline": string, "confidence": number between 0 and 1}. ` +
    `Use empty strings and a low confidence only when the sheet is genuinely unreadable.` +
    hint
  );
}

export function parseReadResponse(raw: string): SheetRead {
  const obj = extractJson(raw);
  if (!obj) return { sheetNumber: '', sheetTitle: '', confidence: 0 };
  const sheetNumber = String(obj.sheetNumber ?? '').trim().toUpperCase();
  const sheetTitle = String(obj.sheetTitle ?? '').trim();
  const discipline = obj.discipline ? String(obj.discipline).trim() : undefined;
  return { sheetNumber, sheetTitle, discipline, confidence: clamp01(obj.confidence) };
}

export function buildMatchPrompt(page: SheetRead, existing: ExistingSheetRef[]): string {
  const list = existing.map(e => `- id="${e.sheetId}" number="${e.number}" title="${e.title}"`).join('\n');
  return (
    `You are matching a new drawing sheet against an existing set to decide if it is a REVISION of one of them ` +
    `(the same logical sheet re-issued) or a brand new sheet. Sheet numbers or titles may have changed slightly between revisions.\n\n` +
    `New sheet: number="${page.sheetNumber}" title="${page.sheetTitle}"${page.discipline ? ` discipline="${page.discipline}"` : ''}\n\n` +
    `Existing sheets:\n${list || '(none)'}\n\n` +
    `Respond with ONLY a JSON object of the form ` +
    `{"matchSheetId": string, "confidence": number, "reason": string}, ` +
    `where matchSheetId is one of the ids above if this is a revision of that sheet, or the literal "new" if it is a new sheet.`
  );
}

export function parseMatchResponse(raw: string, validIds: string[]): SheetMatch {
  const obj = extractJson(raw);
  if (!obj) return { matchSheetId: null, confidence: 0, reason: undefined };
  const id = String(obj.matchSheetId ?? '').trim();
  const matchSheetId = validIds.includes(id) ? id : null;
  const reason = obj.reason ? String(obj.reason).trim().slice(0, 200) : undefined;
  return { matchSheetId, confidence: clamp01(obj.confidence), reason };
}

export function buildTranscribePrompt(mode: TranscribeMode): string {
  const target = mode === 'number'
    ? `The crop should contain a drawing sheet number (e.g. "A-101", "S2.1", "RC-A-106"). Return just that token as written, reading each character and digit carefully.`
    : `The crop should contain a sheet title or description. Return it verbatim as written.`;
  return (
    `This image is a small cropped region of a construction drawing. ` +
    `Read ONLY the text visible in the image. Do not interpret, summarize, expand abbreviations, or add anything that is not printed. ` +
    target +
    ` If the crop contains several lines, return them joined with single spaces in reading order.\n` +
    `Respond with ONLY a JSON object, no prose, exactly of the form ` +
    `{"text": string, "confidence": number between 0 and 1}. ` +
    `Use an empty string and low confidence if the crop is unreadable.`
  );
}

export function parseTranscribeResponse(raw: string): TranscribeResult {
  const obj = extractJson(raw);
  if (!obj) return { text: '', confidence: 0 };
  // No uppercasing here — the client applies the same cleaners as the OCR path.
  return { text: String(obj.text ?? '').trim(), confidence: clamp01(obj.confidence) };
}
