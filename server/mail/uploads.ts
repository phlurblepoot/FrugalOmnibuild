import fs from 'fs'; import path from 'path';
import { v4 as uuidv4 } from 'uuid';
const dirOf = (dataDir: string) => path.join(dataDir, 'tmp', 'mail-uploads');
export function stageUpload(dataDir: string, name: string, mime: string, buf: Buffer): { uploadId: string } {
  const d = dirOf(dataDir); fs.mkdirSync(d, { recursive: true });
  const uploadId = uuidv4();
  fs.writeFileSync(path.join(d, uploadId + '.bin'), buf);
  fs.writeFileSync(path.join(d, uploadId + '.json'), JSON.stringify({ name, mime }));
  return { uploadId };
}
export function readUpload(dataDir: string, uploadId: string): { name: string; mime: string; buf: Buffer } | null {
  if (!/^[0-9a-f-]{36}$/.test(uploadId)) return null;
  const d = dirOf(dataDir); const bin = path.join(d, uploadId + '.bin'); const meta = path.join(d, uploadId + '.json');
  if (!fs.existsSync(bin) || !fs.existsSync(meta)) return null;
  const { name, mime } = JSON.parse(fs.readFileSync(meta, 'utf8'));
  return { name, mime, buf: fs.readFileSync(bin) };
}
export function discardUpload(dataDir: string, uploadId: string): void {
  if (!/^[0-9a-f-]{36}$/.test(uploadId)) return;
  const d = dirOf(dataDir); for (const ext of ['.bin', '.json']) { try { fs.unlinkSync(path.join(d, uploadId + ext)); } catch { /* gone */ } }
}
export function sweepUploads(dataDir: string, maxAgeMs = 3_600_000): void {
  const d = dirOf(dataDir); if (!fs.existsSync(d)) return;
  const cutoff = Date.now() - maxAgeMs;
  for (const f of fs.readdirSync(d)) { const p = path.join(d, f); try { if (fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch { /* ignore */ } }
}
/** Marks a staged upload as in use (a saved draft carries it) so the sweeper keeps it. */
export function touchUpload(dataDir: string, uploadId: string): void {
  if (!/^[0-9a-f-]{36}$/.test(uploadId)) return;
  const d = dirOf(dataDir); const now = new Date();
  for (const ext of ['.bin', '.json']) { try { fs.utimesSync(path.join(d, uploadId + ext), now, now); } catch { /* gone */ } }
}
