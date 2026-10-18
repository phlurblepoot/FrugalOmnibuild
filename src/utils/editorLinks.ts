// src/utils/editorLinks.ts — in-app links into the document editor, shared by
// the client (the editor's "Get link" on a comment) and the server (the link
// in an @mention notification), so both open a comment the same way.
//
// ONLYOFFICE describes "where in the document" as an opaque actionLink object
// (onMakeActionLink / onRequestSendNotify). The link carries it as JSON in
// ?comment=, and the editor hands it back as editorConfig.actionLink, which
// scrolls to that comment.

/** A generous cap: ONLYOFFICE's own action links are a few dozen bytes. */
export const ACTION_LINK_MAX_CHARS = 2000;

/** The action link if it's a plain object of a sane size, else null. */
export function normalizeActionLink(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  try {
    return JSON.stringify(value).length <= ACTION_LINK_MAX_CHARS ? value as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** /tools/edit?fileId=…, pointing at a comment when given one. */
export function editorPath(fileId: string, actionLink?: unknown): string {
  const path = `/tools/edit?fileId=${encodeURIComponent(fileId)}`;
  const link = normalizeActionLink(actionLink);
  return link ? `${path}&comment=${encodeURIComponent(JSON.stringify(link))}` : path;
}

/** The action link carried by a ?comment= value, or null. */
export function parseActionLinkParam(param: string | null | undefined): Record<string, unknown> | null {
  if (!param) return null;
  try { return normalizeActionLink(JSON.parse(param)); } catch { return null; }
}

/** /tools/view: a mail attachment in the document viewer (Phase 6). */
export const attachmentViewerPath = (messageId: string, attId: string, name: string): string =>
  `/tools/view?message=${encodeURIComponent(messageId)}&att=${encodeURIComponent(attId)}&name=${encodeURIComponent(name)}`;
