import type { AiRunner } from './types';

/** A runner used when AI is disabled or the model failed to load. */
export function createDisabledRunner(reason = 'disabled'): AiRunner {
  const unavailable = () => Promise.reject(new Error('ai runner unavailable'));
  return {
    configured: () => false,
    state: () => Promise.resolve('off' as const),
    warmup: () => {},
    info: () => ({ model: reason, device: 'none' }),
    readSheet: unavailable,
    matchSheet: unavailable,
    transcribeRegion: unavailable,
  };
}
