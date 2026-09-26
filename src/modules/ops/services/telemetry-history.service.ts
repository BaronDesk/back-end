import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PresenceService } from '../../station/services/presence.service.js';
import { OpsRepository } from '../repository/ops.repository.js';
import { TelemetryService } from './telemetry.service.js';

/** Prune far less often than we sample; the cutoff only moves by one tick each time. */
const PRUNE_EVERY_TICKS = 10;

/**
 * Thinned history: the only telemetry that reaches Postgres. Every interval
 * it copies the latest cached snapshot of each ONLINE station into one
 * `node_telemetry` row, and periodically drops rows past retention.
 */
@Injectable()
export class TelemetryHistoryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TelemetryHistoryService.name);
  private readonly intervalMs: number;
  private readonly retentionMs: number;
  private timer?: NodeJS.Timeout;
  private ticks = 0;
  private running = false;

  constructor(
    private readonly presence: PresenceService,
    private readonly telemetry: TelemetryService,
    private readonly repo: OpsRepository,
    config: ConfigService,
  ) {
    this.intervalMs = Number(config.get('TELEMETRY_HISTORY_INTERVAL_MS') ?? 60_000);
    this.retentionMs = Number(config.get('TELEMETRY_HISTORY_RETENTION_HOURS') ?? 48) * 60 * 60 * 1000;
  }

  onModuleInit(): void {
    this.timer = setInterval(() => void this.tick(), this.intervalMs);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.sample();
      if (this.ticks++ % PRUNE_EVERY_TICKS === 0) await this.prune();
    } catch (err) {
      this.logger.error(`telemetry history tick failed: ${(err as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  private async sample(): Promise<void> {
    const stations = this.presence.onlineStations();
    const snapshots = await this.telemetry.latestMany(stations.map((s) => s.serialNumber));

    const rows = stations.flatMap((station, i) => {
      const snapshot = snapshots[i];
      if (!snapshot) return [];
      const sampledAt = new Date(snapshot.timestamp);
      return [
        {
          machineId: station.machineId,
          metrics: snapshot.metrics,
          recordedAt: Number.isNaN(sampledAt.getTime()) ? new Date(snapshot.receivedAt) : sampledAt,
        },
      ];
    });
    if (rows.length === 0) return;

    await this.repo.insertTelemetryHistory(rows);
    this.logger.debug(`telemetry history: ${rows.length} row(s) written`);
  }

  private async prune(): Promise<void> {
    const { count } = await this.repo.pruneTelemetryHistory(new Date(Date.now() - this.retentionMs));
    if (count) this.logger.log(`telemetry history: pruned ${count} row(s) past retention`);
  }
}
