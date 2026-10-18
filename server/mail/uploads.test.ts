import { describe, it, expect } from 'vitest';
import fs from 'fs'; import os from 'os'; import path from 'path';
import { stageUpload, readUpload, discardUpload, sweepUploads } from './uploads';
describe('uploads', () => {
  it('stages, reads, discards', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-up-'));
    const { uploadId } = stageUpload(dir, 'a.pdf', 'application/pdf', Buffer.from('x'));
    expect(readUpload(dir, uploadId)).toMatchObject({ name: 'a.pdf', mime: 'application/pdf' });
    discardUpload(dir, uploadId); expect(readUpload(dir, uploadId)).toBeNull();
  });
  it('sweep removes old files only', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ft-up-'));
    const { uploadId } = stageUpload(dir, 'a', 'x', Buffer.from('x'));
    sweepUploads(dir, 60_000); expect(readUpload(dir, uploadId)).not.toBeNull();
    sweepUploads(dir, -1); expect(readUpload(dir, uploadId)).toBeNull();
  });
});
