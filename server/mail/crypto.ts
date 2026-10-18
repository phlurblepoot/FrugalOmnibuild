// AES-256-GCM sealing for mail secrets (spec §7). Key from MAIL_SECRET_KEY
// (hex or base64, 32 bytes) or an auto-generated data/mail.key (0600). The key
// deliberately lives OUTSIDE app.db so a copied database/backups can't read
// tokens; losing the key only forces users to reconnect accounts.
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const IV_LEN = 12;
const TAG_LEN = 16;

export class MailCrypto {
  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('MailCrypto key must be 32 bytes');
  }
  seal(obj: unknown): string {
    const iv = crypto.randomBytes(IV_LEN);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const plain = Buffer.from(JSON.stringify(obj), 'utf8');
    const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
    const tag = cipher.getAuthTag();
    return 'v1:' + Buffer.concat([iv, tag, enc]).toString('base64');
  }
  open<T = unknown>(sealed: string): T {
    if (!sealed.startsWith('v1:')) throw new Error('Unknown sealed format');
    const buf = Buffer.from(sealed.slice(3), 'base64');
    const iv = buf.subarray(0, IV_LEN);
    const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
    const enc = buf.subarray(IV_LEN + TAG_LEN);
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
    decipher.setAuthTag(tag);
    const plain = Buffer.concat([decipher.update(enc), decipher.final()]);
    return JSON.parse(plain.toString('utf8')) as T;
  }
}

function parseKey(raw: string): Buffer {
  const t = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(t)) return Buffer.from(t, 'hex');
  const b = Buffer.from(t, 'base64');
  if (b.length === 32) return b;
  throw new Error('MAIL_SECRET_KEY must be 32 bytes as hex (64 chars) or base64');
}

export function loadMailCrypto(dataDir: string, env: NodeJS.ProcessEnv = process.env): MailCrypto {
  if (env.MAIL_SECRET_KEY) return new MailCrypto(parseKey(env.MAIL_SECRET_KEY));
  const keyPath = path.join(dataDir, 'mail.key');
  if (fs.existsSync(keyPath)) return new MailCrypto(parseKey(fs.readFileSync(keyPath, 'utf8')));
  fs.mkdirSync(dataDir, { recursive: true });
  const key = crypto.randomBytes(32);
  fs.writeFileSync(keyPath, key.toString('hex') + '\n', { mode: 0o600 });
  fs.chmodSync(keyPath, 0o600);
  console.log(`[mail] generated ${keyPath} — back it up with the data directory`);
  return new MailCrypto(key);
}
