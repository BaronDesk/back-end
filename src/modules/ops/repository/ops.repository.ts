import { Injectable } from '@nestjs/common';

import { BaseRepository } from '../../../common/repository/base.repository.js';
import { PrismaService } from '../../../infra/prisma/prisma.service.js';
import type { AlertCategory, AlertSeverity, Prisma } from '../../../generated/prisma/index.js';

/**
 * ops owns `node_telemetry` and `telemetry_alerts` only. Machines and branches
 * are reached through the station module's PresenceService, never from here.
 */
@Injectable()
export class OpsRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  insertTelemetryHistory(rows: { machineId: string; metrics: Prisma.InputJsonValue; recordedAt: Date }[]) {
    return this.prisma.nodeTelemetry.createMany({ data: rows });
  }

  /** One station's thinned history since `since`, oldest first. */
  telemetryHistory(machineId: string, since: Date) {
    return this.prisma.nodeTelemetry.findMany({
      where: { machineId, recordedAt: { gte: since } },
      select: { recordedAt: true, metrics: true },
      orderBy: { recordedAt: 'asc' },
      take: 5000,
    });
  }

  pruneTelemetryHistory(before: Date) {
    return this.prisma.nodeTelemetry.deleteMany({ where: { recordedAt: { lt: before } } });
  }

  createAlert(data: {
    machineId: string;
    branchId: string | null;
    category: AlertCategory;
    type: string;
    severity: AlertSeverity;
    value: Prisma.InputJsonValue;
    createdAt?: Date;
  }) {
    return this.prisma.telemetryAlert.create({ data });
  }

  /** Newest unacknowledged alert of this kind on the machine created at or after `since`. */
  findRecentOpenAlert(filter: { machineId: string; category: AlertCategory; type: string; since: Date }) {
    return this.prisma.telemetryAlert.findFirst({
      where: {
        machineId: filter.machineId,
        category: filter.category,
        type: filter.type,
        acknowledged: false,
        createdAt: { gte: filter.since },
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  updateAlert(id: string, data: { severity: AlertSeverity; value: Prisma.InputJsonValue }) {
    return this.prisma.telemetryAlert.update({ where: { id }, data });
  }

  findAlertById(id: string) {
    return this.prisma.telemetryAlert.findUnique({ where: { id } });
  }

  /** `branchId: null` means every branch (hq). */
  listAlerts(filter: { branchId: string | null; acknowledged?: boolean; limit: number }) {
    return this.prisma.telemetryAlert.findMany({
      where: {
        ...(filter.branchId ? { branchId: filter.branchId } : {}),
        ...(filter.acknowledged !== undefined ? { acknowledged: filter.acknowledged } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: filter.limit,
    });
  }

  acknowledgeAlert(id: string, userId: string, at: Date) {
    return this.prisma.telemetryAlert.update({
      where: { id },
      data: { acknowledged: true, acknowledgedByUserId: userId, acknowledgedAt: at },
    });
  }
}
