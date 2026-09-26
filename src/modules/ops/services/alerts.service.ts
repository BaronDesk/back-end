import { createHash } from 'node:crypto';

import { ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Redis } from 'ioredis';

import { assertScope } from '../../../common/utils/assert-scope.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { DASHBOARD_EVENTS } from '../../../infra/realtime/constants.js';
import { REDIS } from '../../../infra/redis/redis.module.js';
import type { AlertCategory, AlertSeverity, Prisma, TelemetryAlert } from '../../../generated/prisma/index.js';
import type { StationRef } from '../../station/services/presence.service.js';
import { DashboardGateway } from '../dashboard.gateway.js';
import { OpsRepository } from '../repository/ops.repository.js';
import { DEVICE_EVENT_TYPES, type DeviceEventPayload, type ListAlertsQuery } from '../schemas/telemetry.schemas.js';

/** The agent retries device events on reconnect; remember each one this long. */
const DEVICE_EVENT_DEDUPE_TTL_S = 24 * 60 * 60;

export interface NewAlert {
  category: AlertCategory;
  type: string;
  severity: AlertSeverity;
  details: Record<string, unknown>;
}

/** API/WS shape of an alert. `category` is lower-case (`hardware`, `anti_theft`). */
export function toAlertDto(alert: TelemetryAlert) {
  const value = (alert.value ?? {}) as Record<string, unknown>;
  return {
    id: alert.id,
    machineId: alert.machineId,
    serialNumber: typeof value.serialNumber === 'string' ? value.serialNumber : null,
    branchId: alert.branchId,
    category: alert.category.toLowerCase(),
    type: alert.type,
    severity: alert.severity,
    value: alert.value,
    acknowledged: alert.acknowledged,
    acknowledgedByUserId: alert.acknowledgedByUserId,
    acknowledgedAt: alert.acknowledgedAt?.toISOString() ?? null,
    createdAt: alert.createdAt.toISOString(),
  };
}

@Injectable()
export class AlertsService {
  private readonly logger = new Logger(AlertsService.name);

  constructor(
    private readonly repo: OpsRepository,
    private readonly dashboard: DashboardGateway,
    @Inject(REDIS) private readonly redis: Redis,
  ) {}

  /** Persists an alert and pushes it to the station's branch room. */
  async raise(station: StationRef, alert: NewAlert) {
    const row = await this.repo.createAlert({
      machineId: station.machineId,
      branchId: station.branchId,
      category: alert.category,
      type: alert.type,
      severity: alert.severity,
      value: { serialNumber: station.serialNumber, ...alert.details } as Prisma.InputJsonValue,
    });
    const dto = toAlertDto(row);
    this.logger.warn(`alert ${dto.category}/${dto.type} on ${station.serialNumber} (${row.id})`);
    // TODO: Redis pub/sub if multi-instance — in-process publish only reaches
    // dashboards connected to this instance.
    this.dashboard.publishToBranch(station.branchId, DASHBOARD_EVENTS.ALERT, dto);
    return dto;
  }

  /**
   * device_event is the anti-theft source. A peripheral going away raises an
   * ANTI_THEFT alert; one coming back is informational only.
   */
  async onDeviceEvent(station: StationRef, event: DeviceEventPayload): Promise<void> {
    const device = `${event.deviceType ?? '?'} '${event.deviceName ?? '?'}' (productId ${event.productId ?? '?'})`;

    if (!(await this.firstDelivery(station.serialNumber, event))) {
      this.logger.debug(`duplicate device_event from ${station.serialNumber} ignored: ${event.eventType} ${device}`);
      return;
    }

    switch (event.eventType) {
      case DEVICE_EVENT_TYPES.DISCONNECTED:
        await this.raise(station, {
          category: 'ANTI_THEFT',
          type: 'device_disconnected',
          severity: 'HIGH',
          details: {
            deviceType: event.deviceType ?? null,
            deviceName: event.deviceName ?? null,
            productId: event.productId ?? null,
            occurredAt: event.timestamp,
          },
        });
        return;
      case DEVICE_EVENT_TYPES.CONNECTED:
        this.logger.log(`device connected on ${station.serialNumber}: ${device}`);
        return;
      default:
        this.logger.warn(`unknown device_event eventType '${event.eventType}' from ${station.serialNumber}`);
    }
  }

  async list(caller: AccessTokenPayload, query: ListAlertsQuery) {
    let branchId: string | null;
    if (caller.scope === 'hq') {
      branchId = query.branchId ?? null;
    } else {
      if (!caller.branchId) return [];
      if (query.branchId) assertScope(caller, { branchId: query.branchId });
      branchId = caller.branchId;
    }

    const rows = await this.repo.listAlerts({
      branchId,
      acknowledged: query.status === undefined ? undefined : query.status === 'resolved',
      limit: query.limit,
    });
    return rows.map(toAlertDto);
  }

  async resolve(caller: AccessTokenPayload, id: string) {
    const alert = await this.repo.findAlertById(id);
    if (!alert) throw new NotFoundException({ code: 'ALERT_NOT_FOUND', error: 'alert not found' });
    // An alert whose branch was deleted belongs to nobody below hq.
    if (!alert.branchId && caller.scope !== 'hq') {
      throw new ForbiddenException({ code: 'FORBIDDEN_CROSS_BRANCH', error: 'cross-branch access denied' });
    }
    assertScope(caller, { branchId: alert.branchId });

    if (alert.acknowledged) return toAlertDto(alert);

    const dto = toAlertDto(await this.repo.acknowledgeAlert(id, caller.sub, new Date()));
    this.dashboard.publishToBranch(alert.branchId, DASHBOARD_EVENTS.ALERT_RESOLVED, dto);
    return dto;
  }

  /**
   * True the first time this exact event is seen. Keyed on the event's own
   * content (not the envelope id) so an agent retry is recognised however it
   * is re-wrapped. If Redis is down we fail open: a duplicate alert is better
   * than a missed theft.
   */
  private async firstDelivery(serialNumber: string, event: DeviceEventPayload): Promise<boolean> {
    const fingerprint = createHash('sha1')
      .update([event.timestamp, event.eventType, event.deviceType, event.deviceName, event.productId].join('|'))
      .digest('hex');
    try {
      const set = await this.redis.set(
        `device_event:${serialNumber}:${fingerprint}`,
        '1',
        'EX',
        DEVICE_EVENT_DEDUPE_TTL_S,
        'NX',
      );
      return set === 'OK';
    } catch (err) {
      this.logger.warn(`device_event dedupe check failed for ${serialNumber}: ${(err as Error).message}`);
      return true;
    }
  }
}
