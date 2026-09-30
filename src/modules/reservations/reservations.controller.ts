import { Body, Controller, Delete, Get, Param, Post } from '@nestjs/common';

import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequireScope } from '../../common/decorators/require-scope.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../../common/types/jwt-payload.js';
import {
  createReservationSchema,
  extendSchema,
  reservationIdSchema,
  walkInSchema,
  type CreateReservationDto,
  type ExtendDto,
  type WalkInDto,
} from './reservations.schemas.js';
import { ReservationsService } from './reservations.service.js';

@Controller('reservations')
@RequireScope('self')
export class ReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  @Get()
  list(@CurrentUser() caller: AccessTokenPayload) {
    return this.reservations.list(caller);
  }

  @Post()
  create(
    @CurrentUser() caller: AccessTokenPayload,
    @Body(new ZodValidationPipe(createReservationSchema)) dto: CreateReservationDto,
  ) {
    return this.reservations.create(caller, dto);
  }

  @Post('walk-in')
  walkIn(@CurrentUser() caller: AccessTokenPayload, @Body(new ZodValidationPipe(walkInSchema)) dto: WalkInDto) {
    return this.reservations.walkIn(caller, dto);
  }

  @Post(':id/check-in')
  checkIn(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(reservationIdSchema)) id: string,
  ) {
    return this.reservations.checkIn(caller, id);
  }

  @Get(':id/extend-options')
  extendOptions(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(reservationIdSchema)) id: string,
  ) {
    return this.reservations.extendOptions(caller, id);
  }

  @Post(':id/extend')
  extend(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(reservationIdSchema)) id: string,
    @Body(new ZodValidationPipe(extendSchema)) dto: ExtendDto,
  ) {
    return this.reservations.extend(caller, id, dto.minutes);
  }

  @Delete(':id')
  cancel(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(reservationIdSchema)) id: string,
  ) {
    return this.reservations.cancel(caller, id);
  }
}
