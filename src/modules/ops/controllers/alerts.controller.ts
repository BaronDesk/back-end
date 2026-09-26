import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';

import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { RequireScope } from '../../../common/decorators/require-scope.decorator.js';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { listAlertsQuerySchema, uuidParamSchema, type ListAlertsQuery } from '../schemas/telemetry.schemas.js';
import { AlertsService } from '../services/alerts.service.js';

@Controller('api/v1/alerts')
export class AlertsController {
  constructor(private readonly alerts: AlertsService) {}

  @RequireScope('staff')
  @Get()
  list(
    @CurrentUser() caller: AccessTokenPayload,
    @Query(new ZodValidationPipe(listAlertsQuerySchema)) query: ListAlertsQuery,
  ) {
    return this.alerts.list(caller, query);
  }

  @RequireScope('staff')
  @Post(':id/resolve')
  @HttpCode(200)
  resolve(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
  ) {
    return this.alerts.resolve(caller, id);
  }
}
