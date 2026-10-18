import { describe, it, expect } from 'vitest';
import fsSync from 'fs';
import os from 'os';
import path from 'path';
import { pathFor, writeFileContent, readFileContent, deleteFileContent, statFile } from './fileStore';

const tmpDir = () => fsSync.mkdtempSync(path.join(os.tmpdir(), 'ft-fs-'));

describe('fileStore', () => {
  it('shards paths by first two id chars', () => {
    const dir = tmpDir();
    const p = pathFor(dir, 'ab12cd34');
    expect(p).toBe(path.join(dir, 'files', 'ab', 'ab12cd34'));
  });

  it('sanitizes hostile ids so they cannot escape the files root', () => {
    const dir = tmpDir();
    const p = pathFor(dir, '../../etc/passwd');
    expect(p.startsWith(path.join(dir, 'files'))).toBe(true);
    expect(p).not.toContain('..');
  });

  it('writes, reads, stats, and deletes content', () => {
    const dir = tmpDir();
    const buf = Buffer.from('hello world');
    const { size, sha256 } = writeFileContent(dir, 'testid01', buf);
    expect(size).toBe(11);
    expect(sha256).toHaveLength(64);
    expect(readFileContent(dir, 'testid01')!.toString()).toBe('hello world');
    expect(statFile(dir, 'testid01')!.size).toBe(11);
    deleteFileContent(dir, 'testid01');
    expect(readFileContent(dir, 'testid01')).toBeNull();
    expect(statFile(dir, 'testid01')).toBeNull();
  });

  it('overwrites atomically on repeated writes', () => {
    const dir = tmpDir();
    writeFileContent(dir, 'x1', Buffer.from('one'));
    writeFileContent(dir, 'x1', Buffer.from('two'));
    expect(readFileContent(dir, 'x1')!.toString()).toBe('two');
    const shard = path.dirname(pathFor(dir, 'x1'));
    expect(fsSync.readdirSync(shard).filter(f => f.endsWith('.tmp'))).toEqual([]);
  });
});
