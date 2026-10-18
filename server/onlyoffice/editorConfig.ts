// server/onlyoffice/editorConfig.ts — the signed config the browser hands to
// `new DocsAPI.DocEditor(...)`. ONLYOFFICE trusts the signed copy (`token`)
// over the plain fields, so everything that matters is decided here on the
// server: which file, who the user is, edit or view, and where saves go.
import jwt from 'jsonwebtoken';
import type { OfficeFormat } from '../../src/utils/officeFormats';
import { extensionOf } from '../../src/utils/officeFormats';
import type { OnlyofficeConfig } from './config';

// ONLYOFFICE keys allow 0-9 a-z A-Z - . _ = and at most 128 characters.
const safeId = (id: string) => id.replace(/[^0-9A-Za-z._=-]/g, '_').slice(0, 80);

/** Every document key for a file starts with this, which lets the callback
 *  check that a save for one file was not posted to another file's URL. */
export const documentKeyPrefix = (fileId: string) => `${safeId(fileId)}-v`;

/** The key for a file's current bytes. ONLYOFFICE caches documents by key, so
 *  the key must change whenever the bytes do. The version number alone isn't
 *  enough: an "overwrite" regenerate resets it to 1, which could match a key
 *  ONLYOFFICE still caches with older content. The hash covers that. */
export const documentKeyFor = (file: { id: string; versionNumber: number; sha256: string }) =>
  `${documentKeyPrefix(file.id)}${file.versionNumber}-${(file.sha256 || 'nohash').slice(0, 12)}`;

/** The title ONLYOFFICE shows and downloads with, always ending in the right
 *  extension (generated documents are often named without one). */
export function editorTitle(name: string | null, ext: string): string {
  const base = (name || '').trim() || 'Document';
  return extensionOf(base) === ext ? base : `${base}.${ext}`;
}

export interface EditorConfigInput {
  cfg: OnlyofficeConfig;
  file: { name: string | null };
  format: OfficeFormat;
  docKey: string;
  /** Where ONLYOFFICE downloads the file (short-lived single-file link). */
  fileUrl: string;
  /** Where ONLYOFFICE sends saves; null when opened read-only. */
  callbackUrl: string | null;
  mode: 'edit' | 'view';
  device: 'desktop' | 'phone';
  theme: 'light' | 'dark';
  user: { id: string; name: string };
  /** Where to scroll on opening: a comment's action link (onMakeActionLink /
   *  onRequestSendNotify), from a notification or a shared comment link. */
  actionLink?: Record<string, unknown> | null;
  /** ONLYOFFICE's light embedded viewer (share links, Phase 6): view only,
   *  no Close button (the page around it has its own header). */
  embedded?: boolean;
}

export function buildEditorConfig(input: EditorConfigInput): Record<string, unknown> {
  const { format, mode } = input;
  const editing = mode === 'edit';
  const config: Record<string, any> = {
    type: input.embedded ? 'embedded' : input.device === 'phone' ? 'mobile' : 'desktop',
    documentType: format.documentType,
    width: '100%',
    height: '100%',
    document: {
      fileType: format.ext,
      key: input.docKey,
      title: editorTitle(input.file.name, format.ext),
      url: input.fileUrl,
      permissions: {
        edit: editing,
        comment: editing,
        review: editing,
        fillForms: editing,
        download: true,
        print: true,
        copy: true,
      },
    },
    editorConfig: {
      mode,
      lang: 'en',
      region: 'en-US',
      user: { id: input.user.id, name: input.user.name },
      coEditing: { mode: 'fast', change: true },
      customization: {
        // The Save button sends the current state to the callback (status 6)
        // instead of waiting for everyone to close the file.
        forcesave: true,
        uiTheme: input.theme === 'dark' ? 'default-dark' : 'default-light',
        close: { visible: true, text: 'Close' },
      },
    },
  };
  if (input.callbackUrl) config.editorConfig.callbackUrl = input.callbackUrl;
  if (input.actionLink) config.editorConfig.actionLink = input.actionLink;
  if (input.embedded) delete config.editorConfig.customization.close;
  config.token = jwt.sign(config, input.cfg.jwtSecret, { algorithm: 'HS256' });
  return config;
}
