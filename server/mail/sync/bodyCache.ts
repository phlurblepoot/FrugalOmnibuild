// A single entry larger than maxBytes is intentionally allowed to sit alone over budget after
// eviction empties the map — refusing to cache it would just re-fetch it every time, which is worse.
export class BodyCache<T> {
  private map = new Map<string, { value: T; bytes: number; at: number }>();
  private total = 0;
  private readonly now: () => number;
  constructor(private opts: { maxBytes: number; ttlMs: number; now?: () => number }) { this.now = opts.now ?? (() => Date.now()); }
  get(key: string): T | undefined {
    const e = this.map.get(key); if (!e) return undefined;
    if (this.now() - e.at > this.opts.ttlMs) { this.delete(key); return undefined; }
    this.map.delete(key); this.map.set(key, e);   // refresh recency
    return e.value;
  }
  set(key: string, value: T, bytes: number): void {
    this.delete(key);
    this.map.set(key, { value, bytes, at: this.now() }); this.total += bytes;
    for (const [k, e] of this.map) { if (this.total <= this.opts.maxBytes) break; this.map.delete(k); this.total -= e.bytes; }
  }
  delete(key: string): void { const e = this.map.get(key); if (e) { this.map.delete(key); this.total -= e.bytes; } }
}
