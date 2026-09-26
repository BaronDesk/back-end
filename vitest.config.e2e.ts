import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  test: {
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    environment: 'node',
    globals: true,
    // Short presence timings so the watchdog case runs in seconds. Must be set
    // here, not in the spec: ConfigModule.forRoot validates env when AppModule
    // is imported, and ESM imports run before any code in the spec body.
    env: {
      PRESENCE_OFFLINE_AFTER_MS: '1500',
      PRESENCE_WATCHDOG_INTERVAL_MS: '300',
    },
  },
  plugins: [swc.vite()],
});
