import { describe, it, expect } from 'vitest';
import { buildServerArgs, extractContent, type RunnerConfig } from './runner';

const cfg = (over: Partial<RunnerConfig> = {}): RunnerConfig => ({
  serverBin: '/app/llama-server',
  modelArgs: ['-hf', 'ggml-org/Qwen2.5-VL-3B-Instruct-GGUF:Q4_K_M'],
  host: '127.0.0.1',
  port: 8080,
  gpuLayers: 999,
  cacheDir: '/models',
  timeoutMs: 30000,
  startupTimeoutMs: 900000,
  modelLabel: 'qwen2.5-vl-3b-instruct',
  ...over,
});

describe('buildServerArgs', () => {
  it('passes the model args through and binds host/port/ngl', () => {
    const args = buildServerArgs(cfg());
    expect(args).toContain('-hf');
    expect(args).toContain('ggml-org/Qwen2.5-VL-3B-Instruct-GGUF:Q4_K_M');
    expect(args.join(' ')).toContain('--host 127.0.0.1');
    expect(args.join(' ')).toContain('--port 8080');
    expect(args.join(' ')).toContain('-ngl 999');
  });
  it('supports explicit local model + mmproj paths', () => {
    const args = buildServerArgs(cfg({ modelArgs: ['--model', '/models/m.gguf', '--mmproj', '/models/mm.gguf'] }));
    expect(args.join(' ')).toContain('--model /models/m.gguf --mmproj /models/mm.gguf');
  });
});

describe('extractContent', () => {
  it('reads a plain string content', () => {
    expect(extractContent({ choices: [{ message: { content: 'hello' } }] })).toBe('hello');
  });
  it('joins array content parts', () => {
    expect(extractContent({ choices: [{ message: { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] } }] })).toBe('a b');
  });
  it('returns empty string on malformed shapes', () => {
    expect(extractContent({})).toBe('');
    expect(extractContent(null)).toBe('');
    expect(extractContent({ choices: [] })).toBe('');
  });
});
