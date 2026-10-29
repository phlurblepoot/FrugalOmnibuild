import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import {defineConfig, loadEnv} from 'vite';
import {readFileSync} from 'fs';

// The app's version (package.json), for the "What's new" popup.
const APP_VERSION = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf8')).version as string;

export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    define: { __APP_VERSION__: JSON.stringify(APP_VERSION) },
    // The sketch editor's geometry worker imports replicad and its OpenCascade
    // build as ES modules, so workers are bundled as modules too.
    worker: { format: 'es' },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      // HMR is disabled in AI Studio via DISABLE_HMR env var.
      // Do not modifyâfile watching is disabled to prevent flickering during agent edits.
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
