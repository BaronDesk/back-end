import { tmpdir } from 'node:os';
import path from 'node:path';

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
    // each spec boots the full AppModule; that can exceed the 10s default
    hookTimeout: 30_000,
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
      // Every spec calls from one IP and creates many gamers: the production
      // sign-up limit (30 an hour, counted in Redis across runs) would refuse them.
      RATE_LIMIT_SIGNUPS_PER_HOUR: '100000',
      RATE_LIMIT_REFRESHES_PER_MINUTE: '100000',
      // Uploaded test images go to a temp folder, not to the dev server's uploads.
      UPLOAD_DIR: path.join(tmpdir(), 'cstam-e2e-uploads'),
    },
  },
  plugins: [swc.vite()],
});
