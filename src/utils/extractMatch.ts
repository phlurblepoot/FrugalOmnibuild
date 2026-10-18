export type ExtractConfidence = 'high' | 'low';
export interface ReconcileInput { rawCandidates: string[]; ocrText: string; }
export interface ReconcileResult { value: string; confidence: ExtractConfidence; }

const normalize = (s: string) => s.trim().toUpperCase().replace(/\s+/g, ' ');

/** Levenshtein distance. */
function lev(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (!m) return n; if (!n) return m;
  const d = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) d[0][j] = j;
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++)
    d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
  return d[m][n];
}
/** 1 = identical, 0 = totally different. */
const sim = (a: string, b: string) => {
  const A = normalize(a), B = normalize(b);
  if (!A && !B) return 1;
  const L = Math.max(A.length, B.length) || 1;
  return 1 - lev(A, B) / L;
};

/**
 * Reconcile a region's raw PDF-text candidates against an OCR read.
 * - With raw candidates: return the one most similar to OCR (clean characters,
 *   OCR disambiguates which). High confidence when the best match is strong.
 * - Otherwise fall back to the OCR text (low confidence).
 */
export function reconcileExtract({ rawCandidates, ocrText }: ReconcileInput): ReconcileResult {
  const ocr = ocrText.trim();
  const cands = rawCandidates.map(c => c.trim()).filter(Boolean);
  if (cands.length) {
    let best = cands[0], bestScore = -1;
    for (const c of cands) { const s = ocr ? sim(c, ocr) : 0; if (s > bestScore) { bestScore = s; best = c; } }
    // Strong agreement OR no OCR to compare but a single obvious candidate.
    const confident = ocr ? bestScore >= 0.6 : cands.length === 1;
    if (confident) return { value: best, confidence: 'high' };
    // Weak match: prefer the readable OCR if we have it, else the best raw.
    return { value: ocr || best, confidence: 'low' };
  }
  return { value: ocr, confidence: 'low' };
}
