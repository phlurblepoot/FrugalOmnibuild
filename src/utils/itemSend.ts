// src/utils/itemSend.ts
// One conversion, used by all seven "email this document" editors: the mail
// composer resolves a SendRequest (structured addresses, html, mixed
// attachments), while the item send routes — /api/rfis/:id/send and friends —
// still speak the older shape (comma-joined strings + a fileId). The routes
// own the item, so they cannot be bypassed in favour of /api/mail/send; this
// keeps the translation in one place instead of seven near-copies that would
// drift.
import { formatAddresses } from './email';
import type { SendRequest } from '../pages/mail/types';

export interface ItemSendPayload {
  to: string;
  cc?: string;
  bcc?: string;
  subject: string;
  /** The composer's rich text. `body` (plain) stays supported server-side for
   *  older callers; nothing in the app sends it any more. */
  html: string;
  /** Extra documents chosen from the app's own file store. */
  attachmentFileIds: string[];
  /** Files the user attached from their device, staged by /api/mail/uploads. */
  uploadIds: string[];
  /** Set when the send should land in an existing thread. */
  replyTo?: { accountId: string; threadKey: string };
  /** The mailbox the composer's From select settled on. */
  accountId?: string;
}

/** SendRequest → the body an item send route accepts (minus `fileId`, which
 *  the DocumentActionsBar supplies once it knows the generated document). */
export const itemSendPayload = (req: SendRequest): ItemSendPayload => {
  const attachments = req.attachments ?? [];
  return {
    to: formatAddresses(req.to ?? []),
    cc: req.cc?.length ? formatAddresses(req.cc) : undefined,
    bcc: req.bcc?.length ? formatAddresses(req.bcc) : undefined,
    subject: req.subject,
    html: req.html,
    attachmentFileIds: attachments.flatMap(a => ('fileId' in a ? [a.fileId] : [])),
    uploadIds: attachments.flatMap(a => ('uploadId' in a ? [a.uploadId] : [])),
    ...(req.replyTo ? { replyTo: req.replyTo } : {}),
    ...(req.accountId ? { accountId: req.accountId } : {}),
  };
};
