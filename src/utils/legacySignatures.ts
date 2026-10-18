// src/utils/legacySignatures.ts — the old PDF editor kept saved signatures in
// this browser's localStorage ('pdfEditorSignatures': id, name, a PNG data URL
// with the background already removed). ONLYOFFICE Phase 3 moves signatures to
// the person's profile; this carries those across once, to whoever signs in
// on this browser first, then clears the old key.
import { addSignature } from './store';
import { dataUrlToBlob } from './removeWhiteBackground';

const KEY = 'pdfEditorSignatures';

interface LegacySignature { id?: string; name?: string; dataUrl?: string }

let running: Promise<number> | null = null;

/** Uploads any old-editor signatures as the signed-in person's own; resolves
 *  with how many came across. Safe to call repeatedly. */
export function importLegacySignatures(): Promise<number> {
  if (running) return running;
  running = (async () => {
    let list: LegacySignature[] = [];
    try { list = JSON.parse(localStorage.getItem(KEY) || '[]'); } catch { list = []; }
    if (!Array.isArray(list) || list.length === 0) {
      try { localStorage.removeItem(KEY); } catch { /* ignore */ }
      return 0;
    }
    let imported = 0;
    const left: LegacySignature[] = [];
    for (const [i, sig] of list.entries()) {
      if (typeof sig?.dataUrl !== 'string' || !sig.dataUrl.startsWith('data:image/')) continue; // unusable
      try {
        await addSignature(dataUrlToBlob(sig.dataUrl), (sig.name || '').trim() || `Signature ${i + 1}`);
        imported++;
      } catch {
        left.push(sig); // try again next time
      }
    }
    try {
      if (left.length) localStorage.setItem(KEY, JSON.stringify(left));
      else localStorage.removeItem(KEY);
    } catch { /* ignore */ }
    return imported;
  })().finally(() => { running = null; });
  return running;
}
