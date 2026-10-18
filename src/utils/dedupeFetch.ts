// Collapses concurrent calls for the same key into a single in-flight promise,
// and keeps the resolved value around briefly so a burst of near-simultaneous
// callers (e.g. several components mounting at once) shares one network
// request instead of firing one each.
//
// ttlMs default is 250, NOT the naive "just under a second" you might reach
// for: useLiveQuery's change-event refetch debounce is 300ms (see
// src/hooks/useLiveQuery.ts). Any cache TTL >= 300ms risks serving
// pre-mutation data to a change-driven reload that fires right at the
// debounce boundary. 250ms still collapses the mount burst (opening a
// customer fires getCustomerOverview up to 6x in parallel today;
// ProjectOverview fires getBillingSummary 3x) while staying safely under the
// refetch debounce.
type CacheEntry<T> = {
  promise: Promise<T>;
  evictTimer: ReturnType<typeof setTimeout> | null;
};

const cache = new Map<string, CacheEntry<any>>();

export function dedupeInFlight<T>(key: string, fn: () => Promise<T>, ttlMs = 250): Promise<T> {
  const existing = cache.get(key);
  if (existing) return existing.promise as Promise<T>;

  const promise = fn();

  const entry: CacheEntry<T> = { promise, evictTimer: null };
  cache.set(key, entry);

  promise.then(
    () => {
      // Only schedule eviction if this entry is still the current one for the key.
      if (cache.get(key) === entry) {
        entry.evictTimer = setTimeout(() => {
          if (cache.get(key) === entry) cache.delete(key);
        }, ttlMs);
      }
    },
    () => {
      // Rejections are never cached — evict immediately so a retry re-invokes fn.
      if (cache.get(key) === entry) cache.delete(key);
    },
  );

  return promise;
}

/** Test-only: clears all cached/in-flight entries between test cases. */
export function __clearDedupeCache(): void {
  for (const entry of cache.values()) {
    if (entry.evictTimer) clearTimeout(entry.evictTimer);
  }
  cache.clear();
}
