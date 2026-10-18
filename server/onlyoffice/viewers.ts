// server/onlyoffice/viewers.ts — ONLYOFFICE as a read-only viewer (Phase 6):
//
//   * Mail attachments: Word, Excel and PowerPoint files (old formats too)
//     open in the viewer instead of downloading. The mail routes look the
//     attachment up for its owner and ask createAttachmentViewer for the
//     config; the Document Server then fetches the attachment through a link
//     good for that one attachment for an hour (GET /api/mail/viewer-file,
//     server/mail/routes.ts). Nothing is stored.
//   * Share links: GET /api/share/:shareId/viewer — the embedded viewer for a
//     shared file ONLYOFFICE can read (PDFs included), anonymous and view
//     only, which also works on phones. Anything else keeps the page's own
//     preview. The Document Server fetches the file through the share link
//     itself, so an expired or stopped link cuts the viewer off too.
import crypto from 'crypto';
import express from 'express';
import type Database from 'better-sqlite3';
import { getMeta } from '../files';
import { SHARE_PROBLEM_TEXT, activeShare, shareProblemStatus, sharedFileIds } from '../shares';
import { officeFormatOf, type OfficeFormat } from '../../src/utils/officeFormats';
import { readOnlyofficeConfig, type OnlyofficeConfig } from './config';
import type { LinkTokens } from './tokens';
import { MAIL_ATTACHMENT_LINK_TTL_SECONDS, mailAttachmentSubject, shareFileLink } from './links';
import { buildEditorConfig } from './editorConfig';

export interface ViewerOpening {
  publicUrl: string;
  config: Record<string, unknown>;
  file: { name: string; ext: string };
}

export type ViewerResult = ViewerOpening | { error: 'not-configured' | 'unsupported' };

const viewerKey = (prefix: string, ...parts: string[]) =>
  `${prefix}-${crypto.createHash('sha256').update(parts.join('\n')).digest('hex').slice(0, 40)}`;

function viewerConfig(cfg: OnlyofficeConfig, input: {
  name: string; format: OfficeFormat; docKey: string; fileUrl: string;
  device: 'desktop' | 'phone'; theme: 'light' | 'dark'; user: { id: string; name: string }; embedded?: boolean;
}): ViewerOpening {
  const config = buildEditorConfig({
    cfg, file: { name: input.name }, format: input.format, docKey: input.docKey, fileUrl: input.fileUrl,
    callbackUrl: null, mode: 'view', device: input.device, theme: input.theme, user: input.user, embedded: input.embedded,
  });
  return { publicUrl: cfg.publicUrl, config, file: { name: input.name, ext: input.format.ext } };
}

export interface AttachmentViewer {
  /** The signed viewer config for one mail attachment. */
  config(input: {
    messageId: string; attId: string; name: string; mime: string; size: number;
    user: { id: string; name: string }; device: 'desktop' | 'phone'; theme: 'light' | 'dark';
  }): ViewerResult;
  /** Whether a download-link token is for exactly this attachment. */
  verify(token: string, messageId: string, attId: string): boolean;
}

/** Office formats ONLYOFFICE should show; PDFs and images the browser shows itself. */
export const opensInAttachmentViewer = (meta: { mime: string; name: string | null }): OfficeFormat | null => {
  const format = officeFormatOf(meta);
  return format && format.documentType !== 'pdf' ? format : null;
};

export function createAttachmentViewer(env: NodeJS.ProcessEnv, tokens: LinkTokens): AttachmentViewer {
  return {
    config(input) {
      const { config: cfg } = readOnlyofficeConfig(env);
      if (!cfg) return { error: 'not-configured' };
      const format = opensInAttachmentViewer({ mime: input.mime, name: input.name });
      if (!format) return { error: 'unsupported' };
      const token = tokens.sign(mailAttachmentSubject(input.messageId, input.attId), MAIL_ATTACHMENT_LINK_TTL_SECONDS);
      return viewerConfig(cfg, {
        name: input.name, format,
        // Same message, same file: same key, so reopening uses ONLYOFFICE's cache.
        docKey: viewerKey('mail', input.messageId, input.name, String(input.size)),
        fileUrl: `${cfg.appInternalUrl}/api/mail/viewer-file/${encodeURIComponent(input.messageId)}/${encodeURIComponent(input.attId)}?t=${encodeURIComponent(token)}`,
        device: input.device, theme: input.theme, user: input.user,
      });
    },
    verify: (token, messageId, attId) => tokens.verify(token, mailAttachmentSubject(messageId, attId)),
  };
}

export interface ShareViewerDeps {
  env: NodeJS.ProcessEnv;
  db: Database.Database;
}

export function registerShareViewerRoute(app: express.Express, deps: ShareViewerDeps): void {
  // Public, like the share link itself: the embedded viewer, view only. A
  // several-files link has one per file (/viewer/:index). An expired or
  // stopped link opens nothing (Phase 7).
  app.get(['/api/share/:shareId/viewer', '/api/share/:shareId/viewer/:index'], (req, res) => {
    const active = activeShare(deps.db, req.params.shareId);
    if (!('share' in active)) {
      return res.status(shareProblemStatus(active.problem)).json({ error: SHARE_PROBLEM_TEXT[active.problem], code: active.problem });
    }
    const share = active.share;
    const ids = sharedFileIds(share);
    const many = share.type === 'files';
    const index = req.params.index === undefined ? undefined : Number(req.params.index);
    const fileId = many ? (index !== undefined ? ids[index] : undefined) : index === undefined ? ids[0] : undefined;
    const meta = fileId ? getMeta(deps.db, fileId) : null;
    const found = meta ? { share, meta } : null;
    if (!found) return res.status(404).json({ error: 'Share not found' });
    const format = officeFormatOf(found.meta);
    if (!format) return res.status(404).json({ error: "This file isn't shown in the document viewer.", code: 'unsupported' });
    const { config: cfg } = readOnlyofficeConfig(deps.env);
    if (!cfg) return res.status(503).json({ error: "The document viewer isn't set up.", code: 'not-configured' });
    const name = (many ? found.meta.name : found.share.name || found.meta.name) || 'Document';
    res.set('Cache-Control', 'no-store');
    res.json(viewerConfig(cfg, {
      name, format,
      // Its own key: the editor's would join a live editing session, showing
      // someone's unsaved edits to anyone with the link.
      docKey: viewerKey('share', found.meta.id, found.meta.sha256),
      // Through the share link itself, so stopping it stops this too.
      fileUrl: shareFileLink(cfg, share.id, many ? index : undefined),
      device: req.query.device === 'phone' ? 'phone' : 'desktop',
      theme: req.query.theme === 'dark' ? 'dark' : 'light',
      user: { id: `guest-${crypto.createHash('sha256').update(req.params.shareId).digest('hex').slice(0, 12)}`, name: 'Guest' },
      embedded: true,
    }));
  });
}
