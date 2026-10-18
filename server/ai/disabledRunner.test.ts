import { describe, it, expect } from 'vitest';
import { createDisabledRunner } from './disabledRunner';

describe('createDisabledRunner', () => {
  it('is never configured, state is off, and reports device "none"', async () => {
    const r = createDisabledRunner('disabled by config');
    expect(r.configured()).toBe(false);
    expect(await r.state()).toBe('off');
    expect(r.info()).toEqual({ model: 'disabled by config', device: 'none' });
  });
  it('warmup is a no-op', () => {
    const r = createDisabledRunner();
    expect(() => r.warmup(5000)).not.toThrow();
  });
  it('rejects readSheet and matchSheet', async () => {
    const r = createDisabledRunner();
    await expect(r.readSheet({ image: Buffer.from('') })).rejects.toThrow(/unavailable/i);
    await expect(r.matchSheet({ page: { sheetNumber: '', sheetTitle: '', confidence: 0 }, existing: [] })).rejects.toThrow(/unavailable/i);
  });
});
