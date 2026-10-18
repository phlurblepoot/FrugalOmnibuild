// src/test/timeZone.ts — run a test file (or a describe block) in a given
// time zone. The test machine runs in UTC, where a date stored at UTC
// midnight and its local day agree, so a date shown a day early in the US
// only fails a test pinned west of UTC. Node re-reads TZ when it is assigned.
import { afterAll, beforeAll } from 'vitest';

export function useTimeZone(tz: string): void {
  const saved = process.env.TZ;
  beforeAll(() => { process.env.TZ = tz; });
  afterAll(() => {
    if (saved === undefined) delete process.env.TZ;
    else process.env.TZ = saved;
  });
}
