import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';

import type { AccessTokenPayload } from '../../common/types/jwt-payload.js';
import { ReservationsRepository } from './reservations.repository.js';
import type { CreateReservationDto, WalkInDto } from './reservations.schemas.js';

@Injectable()
export class ReservationsService {
  constructor(private readonly reservations: ReservationsRepository) {}

  async list(caller: AccessTokenPayload) {
    const gamer = await this.getGamer(caller.sub);
    return this.reservations.listForGamer(gamer.id);
  }

  async create(caller: AccessTokenPayload, input: CreateReservationDto) {
    const gamer = await this.getGamer(caller.sub);
    if (input.startTime <= new Date()) {
      throw new BadRequestException({ code: 'INVALID_RESERVATION_TIME', error: 'reservation must start in the future' });
    }
    return this.unwrap(await this.reservations.createIfAvailable(gamer.id, input));
  }

  async walkIn(caller: AccessTokenPayload, input: WalkInDto) {
    const gamer = await this.getGamer(caller.sub);
    const startTime = new Date();
    const result = await this.reservations.createIfAvailable(gamer.id, {
      machineId: input.machineId,
      startTime,
      endTime: new Date(startTime.getTime() + input.durationMinutes * 60_000),
    }, true);
    return this.unwrap(result);
  }

  async cancel(caller: AccessTokenPayload, id: string) {
    const gamer = await this.getGamer(caller.sub);
    const reservation = await this.reservations.findOwned(id, gamer.id);
    if (!reservation) throw new NotFoundException({ code: 'RESERVATION_NOT_FOUND', error: 'reservation not found' });
    if (reservation.status !== 'CONFIRMED' && reservation.status !== 'PENDING') {
      throw new ConflictException({ code: 'RESERVATION_NOT_CANCELLABLE', error: 'reservation cannot be cancelled' });
    }
    if (reservation.startTime <= new Date()) {
      throw new ConflictException({ code: 'RESERVATION_ALREADY_STARTED', error: 'reservation has already started' });
    }
    return this.reservations.cancel(id);
  }

  private async getGamer(userId: string) {
    const gamer = await this.reservations.findGamerProfileId(userId);
    if (!gamer) throw new NotFoundException({ code: 'GAMER_PROFILE_NOT_FOUND', error: 'gamer profile not found' });
    return gamer;
  }

  private unwrap(result: Awaited<ReturnType<ReservationsRepository['createIfAvailable']>>) {
    if (result.kind === 'machine_unavailable') {
      throw new ConflictException({ code: 'MACHINE_UNAVAILABLE', error: 'machine is unavailable' });
    }
    if (result.kind === 'invalid_walk_in') {
      throw new BadRequestException({ code: 'INVALID_WALK_IN', error: 'walk-in start time is invalid' });
    }
    if (result.kind === 'slot_taken') {
      throw new ConflictException({ code: 'RESERVATION_SLOT_TAKEN', error: 'machine is already reserved for this time' });
    }
    return result.reservation;
  }
}
