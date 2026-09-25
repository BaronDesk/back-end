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
});

export type EnvConfig = z.infer<typeof envSchema>;

export function validateEnv(config: Record<string, unknown>): EnvConfig {
  const parsed = envSchema.safeParse(config);
  if (!parsed.success) {
    throw new Error(`invalid environment configuration: ${parsed.error.toString()}`);
  }
  return parsed.data;
}
