// server/untrustedContent.ts
// Headers for any response that sends a stored file's bytes from the app's own
// origin: uploads, generated documents, shared files, mail attachments. Their
// content is untrusted — anyone can upload an SVG or an HTML file, and anyone
// can email one — and the session token lives in localStorage on this origin,
// so a file that ran script here could read it. Two headers stop that:
//   - X-Content-Type-Options: nosniff — the browser keeps to the stored type
//     and never guesses a script or a page out of the bytes;
//   - for anything that isn't a passive type (a photo, a PDF, audio or video),
//     a sandboxing Content-Security-Policy: an SVG, an HTML page or any other
//     document opened straight from its link renders without script, in an
//     origin of its own. An <img> of an SVG is unaffected (images never run
//     script), and fetch() / pdf.js / ONLYOFFICE read bytes, not pages.
// PDFs are left out of the sandbox on purpose: the browser's PDF viewer will
// not open inside a sandbox, and it runs a PDF's own script isolated already.
// (spec docs/superpowers/specs/2026-10-07-file-link-security-design.md)
import type express from 'express';

const PASSIVE_TYPE = /^(?:image\/(?!svg\+xml$)[\w.+-]+|application\/pdf|audio\/[\w.+-]+|video\/[\w.+-]+)$/;

export const UNTRUSTED_CONTENT_CSP = "sandbox; default-src 'none'; img-src data:; media-src data:; style-src 'unsafe-inline'";

/** Whether a stored type is one a browser only ever displays. */
export const isPassiveType = (mime: string | null | undefined): boolean =>
  PASSIVE_TYPE.test((mime ?? '').split(';')[0].trim().toLowerCase());

export function setUntrustedContentHeaders(res: express.Response, mime: string | null | undefined): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  if (!isPassiveType(mime)) res.setHeader('Content-Security-Policy', UNTRUSTED_CONTENT_CSP);
}
