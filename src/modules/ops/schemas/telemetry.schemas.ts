import { z } from 'zod';

/**
 * One reading inside a `telemetry` frame. `metric` is a dotted key such as
 * `cpu.temperature_c` or `gpu.0.load_percent`; the set of keys is open-ended,
 * so readings are validated one by one and a bad entry never sinks the frame.
 */
export const telemetryReadingSchema = z.object({
  metric: z.string().trim().min(1),
  value: z.number().finite(),
  sampledAt: z.string().optional(),
});

export const telemetryPayloadSchema = z.object({
  timestamp: z.string().min(1),
  metrics: z.array(z.unknown()),
});
export type TelemetryPayload = z.infer<typeof telemetryPayloadSchema>;

export const DEVICE_EVENT_TYPES = { CONNECTED: 'Connected', DISCONNECTED: 'Disconnected' } as const;

export const deviceEventPayloadSchema = z.object({
  timestamp: z.string().min(1),
  deviceType: z.string().nullish(),
  deviceName: z.string().nullish(),
  productId: z.union([z.string(), z.number()]).nullish(),
  eventType: z.string().min(1),
});
export type DeviceEventPayload = z.infer<typeof deviceEventPayloadSchema>;

export const ALERT_STATUSES = ['open', 'resolved'] as const;

export const listAlertsQuerySchema = z.object({
  branchId: z.string().uuid().optional(),
  status: z.enum(ALERT_STATUSES).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type ListAlertsQuery = z.infer<typeof listAlertsQuerySchema>;

export const uuidParamSchema = z.string().uuid();
