import fsSync from 'fs';
import path from 'path';
import crypto from 'crypto';

// File content lives at <dataDir>/files/<shard>/<id> where shard is the first
// two characters of the (sanitized) id. Ids are uuids in practice; sanitizing
// defends against any client-supplied id reaching the filesystem.
export function filesRoot(dataDir: string): string {
  return path.join(dataDir, 'files');
}

export function pathFor(dataDir: string, id: string): string {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, '_').replace(/\.\./g, '__');
  const shard = safe.slice(0, 2).padEnd(2, '_');
  return path.join(filesRoot(dataDir), shard, safe);
}

export function writeFileContent(
  dataDir: string,
  id: string,
  buf: Buffer
): { size: number; sha256: string } {
  const p = pathFor(dataDir, id);
  fsSync.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  fsSync.writeFileSync(tmp, buf);
  fsSync.renameSync(tmp, p); // atomic replace on same filesystem
  return {
    size: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
  };
}

export function readFileContent(dataDir: string, id: string): Buffer | null {
  try {
    return fsSync.readFileSync(pathFor(dataDir, id));
  } catch {
    return null;
  }
}

export function statFile(dataDir: string, id: string): { size: number } | null {
  try {
    return { size: fsSync.statSync(pathFor(dataDir, id)).size };
  } catch {
    return null;
  }
}

export function deleteFileContent(dataDir: string, id: string): void {
  try {
    fsSync.unlinkSync(pathFor(dataDir, id));
  } catch {
    /* already gone */
  }
}
