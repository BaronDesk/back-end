import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';

import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { Public } from '../../../common/decorators/public.decorator.js';
import { RequireScope } from '../../../common/decorators/require-scope.decorator.js';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import {
  checkAvailabilitySchema,
  createReservationSchema,
  type CheckAvailabilityDto,
  type CreateReservationDto,
} from '../schemas/booking.schemas.js';
import { BookingService } from '../services/booking.service.js';

@Controller('bookings')
export class BookingController {
  constructor(private readonly booking: BookingService) {}

  @Public()
  @Get('availability')
  availability(@Query(new ZodValidationPipe(checkAvailabilitySchema)) dto: CheckAvailabilityDto) {
    return this.booking.checkAvailability(dto);
  }

  @RequireScope('self')
  @HttpCode(201)
  @Post()
  create(
    @CurrentUser() user: AccessTokenPayload,
    @Body(new ZodValidationPipe(createReservationSchema)) dto: CreateReservationDto,
  ) {
    return this.booking.createReservation(user, dto);
  }

  @RequireScope('self')
  @Get(':id')
  get(@Param('id') id: string) {
    return this.booking.getReservation(id);
  }

  @RequireScope('self')
  @Post(':id/cancel')
  cancel(@CurrentUser() user: AccessTokenPayload, @Param('id') id: string) {
    return this.booking.cancelReservation(user, id);
  }
}