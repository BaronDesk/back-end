import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  test: {
    root: './',
    include: ['src/**/*.spec.ts'],
    environment: 'node',
    globals: true,
  },
  plugins: [swc.vite()],
});