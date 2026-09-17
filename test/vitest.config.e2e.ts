import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  test: {
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    environment: 'node',
    globals: true,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
  plugins: [swc.vite()],
});