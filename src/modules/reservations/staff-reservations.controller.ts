import { Controller, Delete, Get, Param, Query } from '@nestjs/common';

import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequireScope } from '../../common/decorators/require-scope.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../../common/types/jwt-payload.js';
import { reservationIdSchema, staffListQuerySchema, type StaffListQuery } from './reservations.schemas.js';
import { ReservationsService } from './reservations.service.js';

/** The desk's view of bookings: who booked which station when, and cancelling one nobody plays on. */
@Controller('api/v1/reservations')
@RequireScope('staff')
export class StaffReservationsController {
  constructor(private readonly reservations: ReservationsService) {}

  @Get()
  list(@CurrentUser() caller: AccessTokenPayload, @Query(new ZodValidationPipe(staffListQuerySchema)) query: StaffListQuery) {
    return this.reservations.listForStaff(caller, query);
  }

  @Delete(':id')
  cancel(@CurrentUser() caller: AccessTokenPayload, @Param('id', new ZodValidationPipe(reservationIdSchema)) id: string) {
    return this.reservations.cancelByStaff(caller, id);
  }
}
