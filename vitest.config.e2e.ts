import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  test: {
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    environment: 'node',
    globals: true,
    // each spec boots the full AppModule; in parallel that can exceed the 10s default
    hookTimeout: 30_000,
  },
  plugins: [swc.vite()],
});
