import { describe, it, expect } from 'vitest';
import { isPassiveType, setUntrustedContentHeaders, UNTRUSTED_CONTENT_CSP } from './untrustedContent';

describe('untrusted content headers', () => {
  it('treats photos, PDFs, audio and video as passive — but never SVG', () => {
    for (const t of ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf', 'audio/mpeg', 'video/mp4', 'IMAGE/PNG', 'image/jpeg; charset=binary']) {
      expect(isPassiveType(t), t).toBe(true);
    }
    for (const t of ['image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/xml', 'application/xml', 'text/plain',
      'application/javascript', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/octet-stream', '', null, undefined]) {
      expect(isPassiveType(t), String(t)).toBe(false);
    }
  });

  it('always sends nosniff, and sandboxes everything that is not passive', () => {
    const headersFor = (mime: string) => {
      const h: Record<string, string> = {};
      setUntrustedContentHeaders({ setHeader: (k: string, v: string) => { h[k] = v; } } as any, mime);
      return h;
    };
    expect(headersFor('image/jpeg')).toEqual({ 'X-Content-Type-Options': 'nosniff' });
    expect(headersFor('application/pdf')).toEqual({ 'X-Content-Type-Options': 'nosniff' });
    for (const mime of ['image/svg+xml', 'text/html']) {
      expect(headersFor(mime)).toEqual({ 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': UNTRUSTED_CONTENT_CSP });
    }
    expect(UNTRUSTED_CONTENT_CSP).toMatch(/^sandbox;/);
  });
});
