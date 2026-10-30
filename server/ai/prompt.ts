import type { SheetRead, SheetMatch, ExistingSheetRef, TranscribeMode, TranscribeResult, SetContext } from './types';

/** System prompt for every call: a strict, tool-less JSON reader. */
export const SYSTEM_PROMPT =
  'You read construction and architectural drawing sheets for a takeoff app. ' +
  'Answer every request with exactly one JSON object and nothing else: no prose, no markdown code fences. ' +
  'Report only what is printed on the drawing; never invent a sheet number or title.';

/** Pull the first balanced JSON object out of a string. Braces inside JSON
 *  strings don't count, and a ```json fence around the object is tolerated. */
function extractJson(raw: string): any | null {
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          const obj = JSON.parse(raw.slice(start, i + 1));
          return obj && typeof obj === 'object' && !Array.isArray(obj) ? obj : null;
        } catch { return null; }
      }
    }
  }
  return null;
}

/** A field the model must give as a string; anything else counts as missing. */
const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

const clamp01 = (n: unknown): number => {
  const v = typeof n === 'number' && isFinite(n) ? n : 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
};

/**
 * The read-sheet prompt. `layoutText` lists the page's large text with where
 * it sits and which way it is turned (client: utils/pdf.ts layoutTextOf);
 * `embeddedText` is all of the page's text. Title blocks sit in different
 * places on different sets, their text may be turned, and some sheets have no
 * printed number or title at all, so nothing here assumes a layout.
 */
export function buildReadPrompt(embeddedText?: string, layoutText?: string, setContext?: SetContext): string {
  const earlier = setContext?.sheets?.length
    ? `\nSheets of this set read so far: ${setContext.sheets.map(s => [s.number, s.title].filter(Boolean).join(' ')).join('; ')}.`
    : '';
  const set = setContext?.notes || earlier
    ? `\n\nThis sheet comes from the same set as sheets you have already read.` +
      (setContext?.notes ? ` Your notes on how this set is laid out:\n"""${setContext.notes}"""` : '') +
      `${earlier}\nExpect this sheet to follow the same layout and numbering, and use that to find its number and title quickly. ` +
      `But not every sheet does (a cover sheet, an index, or a consultant's sheet may differ): if this one differs, read it on its own terms.`
    : '';
  const layout = layoutText && layoutText.trim()
    ? `\n\nThe largest text on this page, from the PDF's text layer: one line per run of text, giving where it sits ` +
      `(x from the left edge, y from the top edge, as % of the page), which way it is turned (counter-clockwise, if at all) ` +
      `and its size. It is exact where the image is hard to read, but check it against what you see:\n"""${layoutText.trim().slice(0, 6000)}"""`
    : '';
  const hint = embeddedText && embeddedText.trim()
    ? `\n\nAll of the page's text, from the PDF (may be noisy or incomplete; scanned pages have OCR text or none):\n"""${embeddedText.trim().slice(0, 4000)}"""`
    : '';
  return (
    `You are naming ONE sheet from a set of construction drawings, so that someone can find it in a list of sheets.\n\n` +
    `Look at the whole sheet first to understand how it is laid out. Most sets have a title block, but where it is varies: ` +
    `a strip down the right edge, a band along the bottom, a box in a corner, or elsewhere; and its text may be turned sideways. ` +
    `Use the quarter views to read small print exactly.\n\n` +
    `Give:\n` +
    `- sheetNumber: the sheet's own identifier as printed, usually in the title block and often the largest text in it, ` +
    `e.g. "A-201", "S1.1", "RC-A-106", "A3". Read every character carefully. It is not a project or job number, a revision ` +
    `number or date, a room number, a grid line, or the number in a detail or section callout bubble. If the sheet has no ` +
    `sheet number printed anywhere, give "".\n` +
    `- sheetTitle:\n` +
    `  (1) If the sheet's title is printed (normally in the title block, next to the sheet number), copy it as printed, ` +
    `keeping any level, area or phase, e.g. "Level 06 Floor Plan", "Second Floor Plan".\n` +
    `  (2) If no sheet title is printed, name the sheet from what is drawn on it, as one general title for the whole sheet. ` +
    `Sheets often just hold a few drawings that each carry their own label, such as two elevations labelled "Front ` +
    `Elevation" and "Left Elevation": name what they are together ("Exterior Elevations"), not one of them. Likewise ` +
    `several sections -> "Building Sections"; enlarged wall details -> "Wall Details"; one floor plan -> "Floor Plan" ` +
    `(with its level if shown). No compass directions or parentheses in a title you make up.\n` +
    `  Never use the heading of a legend, keynotes, schedule or notes as the title.\n` +
    `- discipline: Architectural, Structural, Mechanical, Electrical, Plumbing, Civil, or similar.\n` +
    `- confidence, 0 to 1: high when the number and title are printed and clearly read; lower when you made up the title ` +
    `or could not find a number; low when the sheet is hard to read.\n` +
    `- setNotes: one or two sentences for reading the NEXT sheets of this set: where the title block is, where in it the ` +
    `sheet number and title are, which way they are turned, and the numbering format (e.g. "Title block is the strip ` +
    `down the right edge; number at its foot in large type like A-101, title just above it, both turned 90°."). ` +
    `Give "" if this sheet is unlike the rest of the set (a cover sheet, say), or repeat the notes you were given if they still hold.\n\n` +
    `Respond with ONLY a JSON object, no prose, exactly of the form ` +
    `{"sheetNumber": string, "sheetTitle": string, "discipline": string, "confidence": number, "setNotes": string}.` +
    set +
    layout +
    hint
  );
}

export function parseReadResponse(raw: string): SheetRead {
  const obj = extractJson(raw);
  if (!obj) return { sheetNumber: '', sheetTitle: '', confidence: 0 };
  const sheetNumber = str(obj.sheetNumber).toUpperCase();
  const sheetTitle = str(obj.sheetTitle);
  const discipline = str(obj.discipline) || undefined;
  const setNotes = str(obj.setNotes).slice(0, 1000) || undefined;
  return { sheetNumber, sheetTitle, discipline, confidence: clamp01(obj.confidence), ...(setNotes ? { setNotes } : {}) };
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
  const id = str(obj.matchSheetId);
  const matchSheetId = validIds.includes(id) ? id : null;
  const reason = str(obj.reason).slice(0, 200) || undefined;
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
  return { text: str(obj.text), confidence: clamp01(obj.confidence) };
}
