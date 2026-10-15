import { Body, Controller, HttpCode, Param, Post } from '@nestjs/common';

import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { RequireScope } from '../../../common/decorators/require-scope.decorator.js';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { networkDropBodySchema, type NetworkDropBody } from '../schemas/network-simulation.schemas.js';
import { uuidParamSchema } from '../schemas/telemetry.schemas.js';
import { NetworkSimulationService } from '../services/network-simulation.service.js';

/**
 * Dev-only network failures (400 SIMULATION_DISABLED in production): the
 * station's socket is cut and its reconnects refused for `seconds`.
 */
@Controller('api/v1')
export class NetworkSimulationController {
  constructor(private readonly simulation: NetworkSimulationService) {}

  /** One station drops on its own: OFFLINE as a single drop. */
  @RequireScope('admin')
  @Post('stations/:id/simulate/network-drop')
  @HttpCode(200)
  dropStation(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
    @Body(new ZodValidationPipe(networkDropBodySchema)) body: NetworkDropBody,
  ) {
    return this.simulation.dropStation(caller, id, body.seconds);
  }

  /** The whole venue loses its network: every station of the branch, classified as a venue outage. */
  @RequireScope('admin')
  @Post('branches/:id/simulate/network-drop')
  @HttpCode(200)
  dropBranch(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
    @Body(new ZodValidationPipe(networkDropBodySchema)) body: NetworkDropBody,
  ) {
    return this.simulation.dropBranch(caller, id, body.seconds);
  }
}
