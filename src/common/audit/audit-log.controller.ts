import { Controller, Get, Query } from '@nestjs/common';
import { z } from 'zod';

import { RequireScope } from '../decorators/require-scope.decorator.js';
import { ZodValidationPipe } from '../pipes/zod-validation.pipe.js';
import { AuditLogService } from './audit-log.service.js';

const listAuditLogsQuerySchema = z.object({
  branchId: z.uuid().optional(),
  from: z.iso.datetime({ offset: true }).transform((v) => new Date(v)).optional(),
  action: z.string().trim().min(1).max(64).optional(),
  q: z.string().trim().min(1).max(64).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
type ListAuditLogsQuery = z.infer<typeof listAuditLogsQuerySchema>;

@Controller('audit-logs')
export class AuditLogController {
  constructor(private readonly audit: AuditLogService) {}

  @RequireScope('hq')
  @Get()
  async list(@Query(new ZodValidationPipe(listAuditLogsQuerySchema)) query: ListAuditLogsQuery) {
    const rows = await this.audit.list(query);
    return rows.map((row) => ({
      id: row.id,
      action: (row.metadata as Record<string, unknown> | null)?.event ?? row.action,
      target: row.target,
      username: row.user.username,
      branchId: row.branchId,
      metadata: row.metadata,
      timestamp: row.timestamp.toISOString(),
    }));
  }
}