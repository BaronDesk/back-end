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
}
