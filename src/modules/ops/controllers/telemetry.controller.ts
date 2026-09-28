import { Controller, Get, NotFoundException, Param } from '@nestjs/common';

import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { RequireScope } from '../../../common/decorators/require-scope.decorator.js';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import { assertScope } from '../../../common/utils/assert-scope.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { PresenceService } from '../../station/services/presence.service.js';
import { uuidParamSchema } from '../schemas/telemetry.schemas.js';
import { TelemetryService } from '../services/telemetry.service.js';

@Controller('api/v1/stations')
export class TelemetryController {
  constructor(
    private readonly presence: PresenceService,
    private readonly telemetry: TelemetryService,
  ) {}

  /** Latest live reading from Redis; 404 once the cache entry has expired. */
  @RequireScope('staff')
  @Get(':id/telemetry')
  async latest(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
  ) {
    const station = await this.presence.resolveById(id);
    if (!station) throw new NotFoundException({ code: 'STATION_NOT_FOUND', error: 'station not found' });
    assertScope(caller, { branchId: station.branchId });

    const snapshot = await this.telemetry.latest(station.serialNumber);
    if (!snapshot) {
      throw new NotFoundException({ code: 'TELEMETRY_NOT_AVAILABLE', error: 'no live telemetry for this station' });
    }
    return snapshot;
  }
}
