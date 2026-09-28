import { z } from 'zod';

export const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  DATABASE_URL: z.string().min(1),
  REDIS_URL: z.string().min(1),
  JWT_ACCESS_SECRET: z.string().min(1),
  JWT_REFRESH_SECRET: z.string().min(1),
  JWT_ACCESS_TTL: z.string().min(1).default('15m'),
  JWT_REFRESH_TTL: z.string().min(1).default('7d'),
  // Node tracking. The agent heartbeats every 15s; OFFLINE after ~3 missed.
  PRESENCE_OFFLINE_AFTER_MS: z.coerce.number().int().positive().default(45_000),
  PRESENCE_WATCHDOG_INTERVAL_MS: z.coerce.number().int().positive().default(10_000),
  PRESENCE_PERSIST_INTERVAL_MS: z.coerce.number().int().positive().default(15_000),
  // Telemetry. A hardware alert fires when a temperature crosses its threshold.
  CPU_TEMP_THRESHOLD_C: z.coerce.number().positive().default(85),
  GPU_TEMP_THRESHOLD_C: z.coerce.number().positive().default(90),
  TELEMETRY_CACHE_TTL_S: z.coerce.number().int().positive().default(30),
  TELEMETRY_HISTORY_INTERVAL_MS: z.coerce.number().int().positive().default(60_000),
  TELEMETRY_HISTORY_RETENTION_HOURS: z.coerce.number().positive().default(48),
  // Station commands. The worker holds its BullMQ job while it waits for the
  // ack, so the timeout stays well under BullMQ's 30s job lock.
  COMMAND_ACK_TIMEOUT_MS: z.coerce.number().int().positive().max(25_000).default(10_000),
  COMMAND_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),
  COMMAND_RETRY_BACKOFF_MS: z.coerce.number().int().nonnegative().default(1_000),
  // Final status of a command whose station has no live socket at send time.
  COMMAND_OFFLINE_STATUS: z.enum(['TIMEOUT', 'FAILED']).default('FAILED'),
  BULLMQ_PREFIX: z.string().min(1).default('bull'),
});

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`invalid environment configuration: ${parsed.error.toString()}`);
  }
  return parsed.data;
}
