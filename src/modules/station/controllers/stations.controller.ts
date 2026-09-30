import { Body, Controller, Get, Param, Patch } from '@nestjs/common';

import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { RequireScope } from '../../../common/decorators/require-scope.decorator.js';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { renameStationSchema, stationIdParamSchema, type RenameStationDto } from '../schemas/presence.schemas.js';
import { StationsService } from '../services/stations.service.js';

@Controller('api/v1/stations')
export class StationsController {
  constructor(private readonly stations: StationsService) {}

  @RequireScope('staff')
  @Get()
  list(@CurrentUser() caller: AccessTokenPayload) {
    return this.stations.list(caller);
  }

  @RequireScope('admin')
  @Patch(':id')
  rename(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(stationIdParamSchema)) id: string,
    @Body(new ZodValidationPipe(renameStationSchema)) dto: RenameStationDto,
  ) {
    return this.stations.rename(caller, id, dto.name);
  }

  @RequireScope('staff')
  @Get(':id')
  get(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(stationIdParamSchema)) id: string,
  ) {
    return this.stations.get(caller, id);
  }
}
