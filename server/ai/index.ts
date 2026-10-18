import { existsSync } from 'node:fs';
import type { AiRunner } from './types';
import { createDisabledRunner } from './disabledRunner';
import { createLlamaServerRunner } from './runner';

let singleton: AiRunner | null = null;

/** Build (once) the AiRunner from env. Falls back to the disabled runner when
 *  AI is turned off or the bundled llama-server binary is absent (e.g. the
 *  CPU-only image). The model + mmproj are auto-downloaded by llama-server on
 *  first use (via `-hf`) into AI_MODELS_DIR, unless explicit local paths are
 *  provided. */
export function getAiRunner(env: NodeJS.ProcessEnv = process.env): AiRunner {
  if (singleton) return singleton;

  if (env.AI_ENABLED === 'false' || env.AI_ENABLED === '0') {
    singleton = createDisabledRunner('disabled by AI_ENABLED');
    return singleton;
  }

  const serverBin = env.AI_LLAMA_SERVER_BIN || '/app/llama-server';
  if (!existsSync(serverBin)) {
    singleton = createDisabledRunner('llama-server not found');
    return singleton;
  }

  const modelsDir = env.AI_MODELS_DIR || '/models';
  const modelArgs = env.AI_MODEL_PATH && env.AI_MMPROJ_PATH
    ? ['--model', env.AI_MODEL_PATH, '--mmproj', env.AI_MMPROJ_PATH]
    : ['-hf', env.AI_MODEL_HF || 'ggml-org/Qwen2.5-VL-7B-Instruct-GGUF:Q4_K_M'];

  singleton = createLlamaServerRunner({
    serverBin,
    modelArgs,
    host: env.AI_HOST || '127.0.0.1',
    port: Number(env.AI_PORT ?? 8080),
    gpuLayers: Number(env.AI_GPU_LAYERS ?? 999),
    cacheDir: modelsDir,
    timeoutMs: Number(env.AI_TIMEOUT_MS ?? 30000),
    startupTimeoutMs: Number(env.AI_STARTUP_TIMEOUT_MS ?? 900000),
    modelLabel: env.AI_MODEL_HF || 'qwen2.5-vl-7b-instruct',
  });
  return singleton;
}
