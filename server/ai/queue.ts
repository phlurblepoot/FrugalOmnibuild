// Serializes async tasks so only one runs at a time (one GPU context), with a
// per-task timeout. A slow/failed task never wedges the queue.

export interface SingleFlightQueue {
  enqueue<T>(fn: () => Promise<T>): Promise<T>;
}

export function createSingleFlightQueue({ timeoutMs }: { timeoutMs: number }): SingleFlightQueue {
  let tail: Promise<unknown> = Promise.resolve();

  function withTimeout<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`ai task timed out after ${timeoutMs}ms`)), timeoutMs);
      Promise.resolve()
        .then(fn)
        .then(v => { clearTimeout(timer); resolve(v); })
        .catch(e => { clearTimeout(timer); reject(e); });
    });
  }

  return {
    enqueue<T>(fn: () => Promise<T>): Promise<T> {
      const run = tail.then(() => withTimeout(fn), () => withTimeout(fn));
      // Keep the chain alive regardless of this task's outcome.
      tail = run.then(() => undefined, () => undefined);
      return run;
    },
  };
}
