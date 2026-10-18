export interface ManifestFile { id: string; sha256: string; size: number }
export interface Manifest {
  format: 1;
  createdAt: number;
  appVersion: string;
  schemaVersion: number;
  db: { size: number; sha256: string };
  mailKey: { sha256: string } | { source: 'env' };
  files: ManifestFile[];
  counts: { files: number; bytes: number };
  warnings: string[];
}
export interface SnapshotSummary { id: string; createdAt: number; appVersion: string; schemaVersion: number; counts: Manifest['counts']; warnings: number }
/** Where a snapshot is written. Both implementations must write manifest.json LAST. */
export interface BackupTarget {
  readonly kind: 'local' | 'drive';
  /** Called once per run; returns the set of sha256 already stored. */
  listObjects(): Promise<Set<string>>;
  putObject(sha256: string, source: () => NodeJS.ReadableStream, size: number): Promise<void>;
  /** `onDbBytes`, when a target can report it, is told how much of app.db
   *  has been sent so far (from 0 again if a retry starts it over). */
  writeSnapshot(id: string, files: { dbPath: string; mailKeyPath: string | null; manifest: Manifest; onDbBytes?: (sent: number) => void }): Promise<void>;
  listSnapshots(): Promise<SnapshotSummary[]>;
  /** Ids of snapshot folders that exist but carry no manifest.json — what a
   *  run that died mid-write leaves behind. Every listing ignores them, so
   *  retention is the only thing that can ever collect them. */
  listIncompleteSnapshots?(): Promise<string[]>;
  readManifest(id: string): Promise<Manifest>;
  deleteSnapshot(id: string): Promise<void>;
  deleteObject(sha256: string): Promise<void>;
}
/** Where a restore reads from. LocalStore and DriveStore implement both. */
export interface BackupSource {
  listSnapshots(): Promise<SnapshotSummary[]>;
  readManifest(id: string): Promise<Manifest>;
  openObject(sha256: string): Promise<NodeJS.ReadableStream>;
  openSnapshotFile(id: string, name: 'app.db' | 'mail.key'): Promise<NodeJS.ReadableStream>;
}
export const snapshotIdNow = (d = new Date()): string =>
  d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15); // YYYYMMDD-HHMMSS
export const isSnapshotId = (s: string): boolean => /^\d{8}-\d{6}$/.test(s);
