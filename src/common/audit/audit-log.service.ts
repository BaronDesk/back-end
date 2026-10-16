import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { Prisma, type AuditAction } from '../../generated/prisma/index.js';

@Injectable()
export class AuditLogService {
  constructor(private readonly prisma: PrismaService) {}

  record(userId: string, action: AuditAction, target: string, opts?: { branchId?: string; metadata?: Prisma.InputJsonValue }) {
    return this.prisma.auditLog.create({
      data: { userId, action, target, branchId: opts?.branchId, metadata: opts?.metadata ?? {} },
    });
  }

  list(filter: { branchId?: string; from?: Date; action?: string; q?: string; limit: number }) {
    return this.prisma.auditLog.findMany({
      where: {
        ...(filter.branchId ? { branchId: filter.branchId } : {}),
        ...(filter.from ? { timestamp: { gte: filter.from } } : {}),
        ...(filter.action ? { metadata: { path: ['event'], equals: filter.action } } : {}),
        ...(filter.q ? { user: { username: { contains: filter.q, mode: 'insensitive' } } } : {}),
      },
      include: { user: { select: { username: true } } },
      orderBy: { timestamp: 'desc' },
      take: filter.limit,
    });
  }
}
