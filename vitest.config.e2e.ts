import { defineConfig } from 'vitest/config';
import swc from 'unplugin-swc';

export default defineConfig({
  test: {
    root: './',
    include: ['test/**/*.e2e-spec.ts'],
    environment: 'node',
    globals: true,
    // Every spec boots its own AppModule, and each one runs a command worker
    // on the same queue. In parallel, one spec's worker takes another spec's
    // jobs without holding the agent socket, so specs run one at a time.
    fileParallelism: false,
    // Short presence timings so the watchdog case runs in seconds. Must be set
    // here, not in the spec: ConfigModule.forRoot validates env when AppModule
    // is imported, and ESM imports run before any code in the spec body.
    env: {
      PRESENCE_OFFLINE_AFTER_MS: '1500',
      PRESENCE_WATCHDOG_INTERVAL_MS: '300',
      // Short ack timeout so the command retry/timeout cases run in seconds.
      COMMAND_ACK_TIMEOUT_MS: '800',
      COMMAND_RETRY_BACKOFF_MS: '50',
      // Keeps the running dev server's worker off the test's command jobs.
      BULLMQ_PREFIX: 'bull-e2e',
    },
  },
  plugins: [swc.vite()],
});
