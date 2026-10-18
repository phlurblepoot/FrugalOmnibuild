import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MailCrypto, loadMailCrypto } from './crypto';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'ft-mc-'));

describe('MailCrypto', () => {
  it('round-trips an object and produces different ciphertext each time', () => {
    const c = new MailCrypto(Buffer.alloc(32, 7));
    const a = c.seal({ refreshToken: 'abc' });
    const b = c.seal({ refreshToken: 'abc' });
    expect(a).not.toEqual(b);                       // random IV
    expect(c.open(a)).toEqual({ refreshToken: 'abc' });
  });
  it('rejects tampered ciphertext', () => {
    const c = new MailCrypto(Buffer.alloc(32, 7));
    const s = c.seal({ x: 1 });
    const bad = s.slice(0, -2) + (s.endsWith('AA') ? 'BB' : 'AA');
    expect(() => c.open(bad)).toThrow();
  });
  it('uses MAIL_SECRET_KEY when set (hex)', () => {
    const dir = tmp();
    const hex = Buffer.alloc(32, 1).toString('hex');
    const c = loadMailCrypto(dir, { MAIL_SECRET_KEY: hex } as any);
    expect(fs.existsSync(path.join(dir, 'mail.key'))).toBe(false);
    expect(c.open(c.seal({ ok: true }))).toEqual({ ok: true });
  });
  it('generates data/mail.key with mode 0600 when env is unset and reuses it', () => {
    const dir = tmp();
    const c1 = loadMailCrypto(dir, {} as any);
    const keyPath = path.join(dir, 'mail.key');
    expect(fs.existsSync(keyPath)).toBe(true);
    expect(fs.statSync(keyPath).mode & 0o777).toBe(0o600);
    const sealed = c1.seal({ v: 2 });
    const c2 = loadMailCrypto(dir, {} as any);
    expect(c2.open(sealed)).toEqual({ v: 2 });
  });
  it('rejects a key of the wrong length', () => {
    expect(() => new MailCrypto(Buffer.alloc(16))).toThrow(/32 bytes/);
  });
});
