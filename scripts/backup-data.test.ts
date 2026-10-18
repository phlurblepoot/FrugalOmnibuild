import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupData } from './backup-data';
import { restoreData } from './restore-data';

const DB_BYTES = Buffer.from([0x53, 0x51, 0x4c, 0x69, 0x74, 0x65, 0x00, 0x01, 0x02, 0x03]);
const FILE_A = 'hello content A';
const FILE_B = 'second file body B';
const OLD_BACKUP = 'old db-only snapshot bytes';
const SETTINGS = '{"theme":"dark"}';

let tmpRoot: string;
let dataDir: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-bktest-'));
  dataDir = path.join(tmpRoot, 'data');

  // Build a synthetic data dir.
  fs.mkdirSync(path.join(dataDir, 'files', 'ab'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'files', 'cd'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'backups'), { recursive: true });

  fs.writeFileSync(path.join(dataDir, 'app.db'), DB_BYTES);
  fs.writeFileSync(path.join(dataDir, 'files', 'ab', 'id1'), FILE_A);
  fs.writeFileSync(path.join(dataDir, 'files', 'cd', 'id2'), FILE_B);
  fs.writeFileSync(path.join(dataDir, 'backups', 'old.db'), OLD_BACKUP);
  fs.writeFileSync(path.join(dataDir, 'settings.json'), SETTINGS);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe('backupData', () => {
  it('copies the full data dir excluding backups/', () => {
    const dest = path.join(tmpRoot, 'backup');
    const result = backupData(dataDir, dest);

    // app.db byte-identical.
    expect(fs.readFileSync(path.join(dest, 'app.db'))).toEqual(DB_BYTES);
    // files preserved byte-identical.
    expect(fs.readFileSync(path.join(dest, 'files', 'ab', 'id1'), 'utf8')).toBe(FILE_A);
    expect(fs.readFileSync(path.join(dest, 'files', 'cd', 'id2'), 'utf8')).toBe(FILE_B);
    // other top-level files included.
    expect(fs.readFileSync(path.join(dest, 'settings.json'), 'utf8')).toBe(SETTINGS);
    // backups/ excluded.
    expect(fs.existsSync(path.join(dest, 'backups'))).toBe(false);

    // returned metrics.
    expect(result.dbBytes).toBe(DB_BYTES.length);
    expect(result.fileCount).toBe(2); // two files under files/
    expect(result.dest).toBe(path.resolve(dest));
    // total = app.db + 2 files + settings.json (no backups).
    const expectedTotal =
      DB_BYTES.length +
      Buffer.byteLength(FILE_A) +
      Buffer.byteLength(FILE_B) +
      Buffer.byteLength(SETTINGS);
    expect(result.totalBytes).toBe(expectedTotal);
  });

  it('never mutates the source (backups/ still present in source)', () => {
    const dest = path.join(tmpRoot, 'backup2');
    backupData(dataDir, dest);
    expect(fs.existsSync(path.join(dataDir, 'backups', 'old.db'))).toBe(true);
    expect(fs.readFileSync(path.join(dataDir, 'app.db'))).toEqual(DB_BYTES);
  });

  it('throws on a missing source dir', () => {
    expect(() => backupData(path.join(tmpRoot, 'nope'), path.join(tmpRoot, 'd'))).toThrow();
  });
});

describe('restoreData', () => {
  it('restores into an empty target byte-identical', () => {
    const dest = path.join(tmpRoot, 'backup');
    backupData(dataDir, dest);

    const target = path.join(tmpRoot, 'fresh-target');
    const result = restoreData(dest, target, false);

    expect(fs.readFileSync(path.join(target, 'app.db'))).toEqual(DB_BYTES);
    expect(fs.readFileSync(path.join(target, 'files', 'ab', 'id1'), 'utf8')).toBe(FILE_A);
    expect(fs.readFileSync(path.join(target, 'settings.json'), 'utf8')).toBe(SETTINGS);
    expect(result.fileCount).toBe(2);
    expect(result.dbBytes).toBe(DB_BYTES.length);
  });

  it('refuses to overwrite a non-empty target without --force', () => {
    const dest = path.join(tmpRoot, 'backup');
    backupData(dataDir, dest);

    const target = path.join(tmpRoot, 'occupied');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'live.db'), 'DO NOT CLOBBER');

    expect(() => restoreData(dest, target, false)).toThrow(/non-empty|OVERWRITE|force/i);
    // live data untouched.
    expect(fs.readFileSync(path.join(target, 'live.db'), 'utf8')).toBe('DO NOT CLOBBER');
  });

  it('overwrites a non-empty target with --force', () => {
    const dest = path.join(tmpRoot, 'backup');
    backupData(dataDir, dest);

    const target = path.join(tmpRoot, 'occupied2');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'app.db'), 'STALE');

    const result = restoreData(dest, target, true);
    expect(fs.readFileSync(path.join(target, 'app.db'))).toEqual(DB_BYTES);
    expect(result.fileCount).toBe(2);
  });

  it('throws when backup source dir is missing', () => {
    expect(() => restoreData(path.join(tmpRoot, 'ghost'), path.join(tmpRoot, 't'), false)).toThrow();
  });
});
