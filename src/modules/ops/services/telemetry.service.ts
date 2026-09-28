import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

import { DASHBOARD_EVENTS } from '../../../infra/realtime/constants.js';
import { REDIS } from '../../../infra/redis/redis.module.js';
import { PresenceService, type StationRef } from '../../station/services/presence.service.js';
import { DashboardGateway } from '../dashboard.gateway.js';
import {
  telemetryReadingSchema,
  type AlertPayload,
  type DeviceEventPayload,
  type TelemetryPayload,
} from '../schemas/telemetry.schemas.js';
import { AlertsService } from './alerts.service.js';

export function telemetryCacheKey(serialNumber: string): string {
  return `telemetry:${serialNumber}`;
}

/** What `telemetry:<serial>` holds and what `telemetry_update` carries. */
export interface TelemetrySnapshot {
  serialNumber: string;
  machineId: string;
  branchId: string;
  /** Newest `sampledAt` among the frame's readings, or `receivedAt` if none is usable. */
  timestamp: string;
  receivedAt: string;
  metrics: Record<string, number>;
}

const CPU_TEMP_METRIC = /^cpu\.temperature_c$/;
const GPU_TEMP_METRIC = /^gpu\.\d+\.temperature_c$/;

/**
 * Live telemetry: cache-only, never Postgres (the history job thins it into
 * `node_telemetry`). The agent raises its own HARDWARE alerts (`alert`
 * frames), so deriving them here from temperature readings is off unless
 * TELEMETRY_DERIVED_ALERTS=true.
 */
@Injectable()
export class TelemetryService {
  private readonly logger = new Logger(TelemetryService.name);
  private readonly cacheTtlS: number;
  private readonly cpuThresholdC: number;
  private readonly gpuThresholdC: number;
  private readonly derivedAlerts: boolean;
  /** `<machineId>:<metric>` currently over threshold; an alert has already fired for it. */
  private readonly overheating = new Set<string>();

  constructor(
    private readonly presence: PresenceService,
    private readonly alerts: AlertsService,
    private readonly dashboard: DashboardGateway,
    @Inject(REDIS) private readonly redis: Redis,
    config: ConfigService,
  ) {
    this.cacheTtlS = Number(config.get('TELEMETRY_CACHE_TTL_S') ?? 30);
    this.cpuThresholdC = Number(config.get('CPU_TEMP_THRESHOLD_C') ?? 85);
    this.gpuThresholdC = Number(config.get('GPU_TEMP_THRESHOLD_C') ?? 90);
    this.derivedAlerts = String(config.get('TELEMETRY_DERIVED_ALERTS') ?? 'false') === 'true';
  }

  async ingest(serialNumber: string, payload: TelemetryPayload): Promise<void> {
    const station = this.presence.resolve(serialNumber);
    if (!station) {
      this.logger.warn(`telemetry from unresolved station ${serialNumber} dropped`);
      return;
    }

    const metrics: Record<string, number> = {};
    let rejected = 0;
    let newestSampledAt = Number.NEGATIVE_INFINITY;
    for (const entry of payload.samples) {
      const reading = telemetryReadingSchema.safeParse(entry);
      if (!reading.success) {
        rejected += 1;
        continue;
      }
      metrics[reading.data.metric] = reading.data.value;
      const sampledAt = reading.data.sampledAt ? Date.parse(reading.data.sampledAt) : Number.NaN;
      if (sampledAt > newestSampledAt) newestSampledAt = sampledAt;
    }
    if (rejected) this.logger.debug(`${rejected} malformed telemetry reading(s) from ${serialNumber} skipped`);

    const receivedAt = new Date().toISOString();
    // Frames are deltas: merge onto the cached snapshot so unchanged metrics
    // survive. The agent sends a full snapshot before any metric could expire.
    const previous = await this.latest(serialNumber).catch(() => null);
    const snapshot: TelemetrySnapshot = {
      serialNumber,
      machineId: station.machineId,
      branchId: station.branchId,
      timestamp: Number.isFinite(newestSampledAt) ? new Date(newestSampledAt).toISOString() : receivedAt,
      receivedAt,
      metrics: { ...(previous?.machineId === station.machineId ? previous.metrics : {}), ...metrics },
    };

    try {
      await this.redis.set(telemetryCacheKey(serialNumber), JSON.stringify(snapshot), 'EX', this.cacheTtlS);
    } catch (err) {
      this.logger.warn(`telemetry cache write failed for ${serialNumber}: ${(err as Error).message}`);
    }

    // TODO: Redis pub/sub if multi-instance — in-process publish only reaches
    // dashboards connected to this instance.
    this.dashboard.publishToBranch(station.branchId, DASHBOARD_EVENTS.TELEMETRY_UPDATE, snapshot);

    if (this.derivedAlerts) await this.checkThresholds(station, metrics);
  }

  async onAlert(serialNumber: string, alert: AlertPayload): Promise<void> {
    const station = this.presence.resolve(serialNumber);
    if (!station) {
      this.logger.warn(`alert from unresolved station ${serialNumber} dropped`);
      return;
    }
    await this.alerts.onAgentAlert(station, alert);
  }

  /** Legacy path: the current agent never sends `device_event`. */
  async onDeviceEvent(serialNumber: string, event: DeviceEventPayload): Promise<void> {
    const station = this.presence.resolve(serialNumber);
    if (!station) {
      this.logger.warn(`device_event from unresolved station ${serialNumber} dropped`);
      return;
    }
    await this.alerts.onDeviceEvent(station, event);
  }

  /** Latest cached snapshot, or null once it has expired (agent gone for > TTL). */
  async latest(serialNumber: string): Promise<TelemetrySnapshot | null> {
    const raw = await this.redis.get(telemetryCacheKey(serialNumber));
    return raw ? (JSON.parse(raw) as TelemetrySnapshot) : null;
  }

  async latestMany(serialNumbers: string[]): Promise<(TelemetrySnapshot | null)[]> {
    if (serialNumbers.length === 0) return [];
    const raws = await this.redis.mget(...serialNumbers.map(telemetryCacheKey));
    return raws.map((raw) => (raw ? (JSON.parse(raw) as TelemetrySnapshot) : null));
  }

  /**
   * Debounced per (machine, metric): fires once on crossing the threshold,
   * then stays quiet until the reading drops back to or below it.
   */
  private async checkThresholds(station: StationRef, metrics: Record<string, number>): Promise<void> {
    for (const [metric, value] of Object.entries(metrics)) {
      const threshold = CPU_TEMP_METRIC.test(metric)
        ? this.cpuThresholdC
        : GPU_TEMP_METRIC.test(metric)
          ? this.gpuThresholdC
          : null;
      if (threshold === null) continue;

      const key = `${station.machineId}:${metric}`;
      if (value > threshold) {
        if (this.overheating.has(key)) continue;
        // Marked before the await so an overlapping frame can't double-fire.
        this.overheating.add(key);
        try {
          await this.alerts.raise(station, {
            category: 'HARDWARE',
            type: 'temperature_high',
            severity: 'HIGH',
            details: { metric, value, threshold },
          });
        } catch (err) {
          this.overheating.delete(key);
          throw err;
        }
      } else if (this.overheating.delete(key)) {
        this.logger.log(`${metric} on ${station.serialNumber} back to ${value} (<= ${threshold}); alert cleared`);
      }
    }
  }
}
