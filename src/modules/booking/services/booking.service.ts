import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';

import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { BookingRepository } from '../repository/booking.repository.js';
import type { CheckAvailabilityDto, CreateReservationDto } from '../schemas/booking.schemas.js';

const LEAD_TIME_MINUTES = 15; // ADR-005: remote bookings must be >= 15 min ahead

@Injectable()
export class BookingService {
  constructor(private readonly repo: BookingRepository) {}

  checkAvailability(dto: CheckAvailabilityDto) {
    return this.repo.findAvailableMachines(
      dto.branchId,
      new Date(dto.startTime),
      new Date(dto.endTime),
    );
  }

  async createReservation(user: AccessTokenPayload, dto: CreateReservationDto) {
    const start = new Date(dto.startTime);
    const end = new Date(dto.endTime);

    if (end <= start) {
      throw new BadRequestException('endTime must be after startTime');
    }

    const earliestAllowed = new Date(Date.now() + LEAD_TIME_MINUTES * 60_000);
    if (start < earliestAllowed) {
      throw new BadRequestException(
        `Remote bookings must be at least ${LEAD_TIME_MINUTES} minutes ahead`,
      );
    }

    const gamerProfile = await this.repo.findGamerProfileByUserId(user.sub);
    if (!gamerProfile) {
      throw new ForbiddenException('Only gamer accounts can book stations');
    }

    const overlap = await this.repo.findOverlapping(dto.machineId, start, end);
    if (overlap) {
      throw new ConflictException('This slot was just taken — please pick another');
    }

    // Unique constraint on [machineId, startTime] is the DB-level backstop
    // for the exact-same-instant race; findOverlapping above catches the
    // general overlap case ahead of time.
    return this.repo.createReservation(gamerProfile.id, dto.machineId, start, end);
  }

  getReservation(id: string) {
    return this.repo.findById(id);
  }

  async cancelReservation(user: AccessTokenPayload, id: string) {
    const reservation = await this.repo.findById(id);

    const gamerProfile = await this.repo.findGamerProfileByUserId(user.sub);
    if (!gamerProfile || reservation.gamerProfileId !== gamerProfile.id) {
      throw new ForbiddenException('You can only cancel your own reservations');
    }

    return this.repo.cancel(id);
  }
}