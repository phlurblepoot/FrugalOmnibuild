import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'server',
          include: ['server/**/*.test.ts', 'scripts/**/*.test.ts'],
          exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
          environment: 'node',
        },
      },
      {
        plugins: [react()],
        resolve: {
          alias: { '@': path.resolve(__dirname, '.') },
        },
        test: {
          name: 'ui',
          include: ['src/**/*.test.{ts,tsx}'],
          exclude: ['e2e/**', 'node_modules/**', 'dist/**'],
          environment: 'jsdom',
          setupFiles: ['./src/test/setup.ts'],
          // globals enables RTL's auto-cleanup between tests (it registers via
          // a global afterEach); ui project only — server tests import explicitly.
          globals: true,
          // Node 25+ built-in localStorage shadows jsdom's; flag is accepted by Node 22.4+ too (project minimum is 22).
          execArgv: ['--no-experimental-webstorage'],
        },
      },
    ],
  },
});
