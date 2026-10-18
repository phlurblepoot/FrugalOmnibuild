// server/mail/providers/mimeBuild.ts
// Turns an OutgoingMessage into the RFC822 bytes an IMAP APPEND / SMTP `raw`
// send needs. Everything that decides threading (Message-ID, In-Reply-To,
// References) is written here from OUR values so the sent copy we index and
// the copy the recipient quotes agree.
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import type { OutgoingMessage } from './types';
import { formatAddress } from '../mime';

const angle = (id: string): string => `<${id.replace(/^<+|>+$/g, '')}>`;

/** `keepBcc` leaves the Bcc header in the built bytes. It is OFF by default —
 *  an SMTP send carries bcc in the envelope, so a header would leak the list to
 *  every recipient. Gmail's `messages/send` is the exception: it has no
 *  envelope of ours to read and derives the recipients from the headers alone,
 *  so a stripped Bcc there means the blind copies simply never go out. */
export async function buildRawMime(msg: OutgoingMessage, opts: { keepBcc?: boolean } = {}): Promise<Buffer> {
  const composer = new MailComposer({
    from: formatAddress(msg.from),
    to: msg.to.map(formatAddress).join(', '),
    cc: msg.cc.length ? msg.cc.map(formatAddress).join(', ') : undefined,
    // Bcc is handed to the composer either way: mime-node strips it from the
    // built headers unless keepBcc is set below.
    bcc: msg.bcc.length ? msg.bcc.map(formatAddress).join(', ') : undefined,
    subject: msg.subject,
    html: msg.html,
    text: msg.text,
    messageId: angle(msg.messageIdHeader),
    inReplyTo: msg.inReplyTo ? angle(msg.inReplyTo) : undefined,
    references: msg.references?.length ? msg.references.map(angle).join(' ') : undefined,
    attachments: msg.attachments.map(a => ({
      filename: a.name, content: a.content, contentType: a.mime,
      ...(a.contentId ? { cid: a.contentId } : {}),
    })),
  });
  const node = composer.compile();
  if (opts.keepBcc) node.keepBcc = true;
  return node.build();
}
