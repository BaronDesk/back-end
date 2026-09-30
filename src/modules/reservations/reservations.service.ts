import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';

import type { AccessTokenPayload } from '../../common/types/jwt-payload.js';
import { assertScope } from '../../common/utils/assert-scope.js';
import { MembershipService } from '../membership/services/membership.service.js';
import { SessionsService } from '../session-billing/services/sessions.service.js';
import { ReservationsRepository } from './reservations.repository.js';
import type { CreateReservationDto, StaffListQuery, WalkInDto } from './reservations.schemas.js';

const DAY_MS = 24 * 60 * 60_000;

const minutesBetween = (from: Date, to: Date) => Math.ceil((to.getTime() - from.getTime()) / 60_000);

@Injectable()
export class ReservationsService {
  private readonly logger = new Logger(ReservationsService.name);

  constructor(
    private readonly reservations: ReservationsRepository,
    private readonly sessions: SessionsService,
    private readonly membership: MembershipService,
  ) {}

  async list(caller: AccessTokenPayload) {
    const gamer = await this.getGamer(caller.sub);
    return this.reservations.listForGamer(gamer.id);
  }

  async create(caller: AccessTokenPayload, input: CreateReservationDto) {
    const gamer = await this.getGamer(caller.sub);
    const now = Date.now();
    if (input.startTime.getTime() <= now) {
      throw new BadRequestException({ code: 'INVALID_RESERVATION_TIME', error: 'reservation must start in the future' });
    }
    // The membership plan sets how far ahead a gamer may book; everyone may book the next 24 hours.
    const advanceDays = Math.max(await this.membership.getBookingAdvanceDays(gamer.id), 1);
    if (input.startTime.getTime() > now + advanceDays * DAY_MS) {
      throw new BadRequestException({
        code: 'BOOKING_TOO_FAR_AHEAD',
        error: `your plan lets you book up to ${advanceDays} day(s) ahead`,
      });
    }
    // The wallet must cover the whole booking on top of what is already promised.
    await this.sessions.assertAffordable({
      gamerProfileId: gamer.id,
      branchId: await this.branchOf(input.machineId),
      isWalkIn: false,
      start: input.startTime,
      minutes: minutesBetween(input.startTime, input.endTime),
    });
    return this.unwrap(await this.reservations.createIfAvailable(gamer.id, input));
  }

  async walkIn(caller: AccessTokenPayload, input: WalkInDto) {
    const gamer = await this.getGamer(caller.sub);
    const startTime = new Date();
    await this.sessions.assertAffordable({
      gamerProfileId: gamer.id,
      branchId: await this.branchOf(input.machineId),
      isWalkIn: true,
      start: startTime,
      minutes: input.durationMinutes,
    });
    const result = await this.reservations.createIfAvailable(gamer.id, {
      machineId: input.machineId,
      startTime,
      endTime: new Date(startTime.getTime() + input.durationMinutes * 60_000),
    }, true);
    const reservation = this.unwrap(result);
    // The gamer plays now, so they get their PIN now. The booking stands even
    // if that fails: the gamer can ask again with check-in.
    let checkIn: Awaited<ReturnType<SessionsService['checkIn']>> | null = null;
    try {
      checkIn = await this.sessions.checkIn(gamer.id, reservation.id);
    } catch (err) {
      this.logger.warn(`walk-in ${reservation.id}: no PIN issued: ${(err as Error).message}`);
    }
    return { ...reservation, checkIn };
  }

  /** What extra time the gamer can add to their running booking now, and its cost. */
  async extendOptions(caller: AccessTokenPayload, id: string) {
    const gamer = await this.getGamer(caller.sub);
    return this.sessions.extendOptions(gamer.id, id);
  }

  /** Adds 30/60/90 minutes (pay-as-you-go rate) to the gamer's running booking. */
  async extend(caller: AccessTokenPayload, id: string, minutes: number) {
    const gamer = await this.getGamer(caller.sub);
    return this.sessions.extend(gamer.id, id, minutes);
  }

  /**
   * The desk's bookings view: the caller's branch (HQ: any, or every
   * branch), with who booked and on which station.
   */
  async listForStaff(caller: AccessTokenPayload, query: StaffListQuery) {
    if (query.branchId) assertScope(caller, { branchId: query.branchId });
    const branchId = caller.scope === 'hq' ? (query.branchId ?? null) : caller.branchId;
    if (caller.scope !== 'hq' && !branchId) return [];
    const rows = await this.reservations.listForStaff({ ...query, branchId });
    return rows.map(({ gamerProfile, ...r }) => ({ ...r, gamerUsername: gamerProfile.user.username }));
  }

  /**
   * The desk cancels a booking nobody is playing on yet (a PIN already
   * issued for it stops working). A running one is ended instead.
   */
  async cancelByStaff(caller: AccessTokenPayload, id: string) {
    const reservation = await this.reservations.findForStaff(id);
    if (!reservation) throw new NotFoundException({ code: 'RESERVATION_NOT_FOUND', error: 'reservation not found' });
    assertScope(caller, { branchId: reservation.machine.branchId });
    if (reservation.status !== 'CONFIRMED' && reservation.status !== 'PENDING') {
      throw new ConflictException({ code: 'RESERVATION_NOT_CANCELLABLE', error: 'reservation cannot be cancelled' });
    }
    if (reservation.sessions.length > 0) {
      throw new ConflictException({ code: 'SESSION_RUNNING', error: 'the gamer is playing on it: end the session instead' });
    }
    return this.reservations.cancel(id);
  }

  /** The gamer gets the PIN to type on the station for their own booking. */
  async checkIn(caller: AccessTokenPayload, id: string) {
    const gamer = await this.getGamer(caller.sub);
    return this.sessions.checkIn(gamer.id, id);
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

  /** The branch of the PC being booked (its prices); an unknown PC can't be booked. */
  private async branchOf(machineId: string): Promise<string> {
    const machine = await this.reservations.findMachine(machineId);
    if (!machine) throw new ConflictException({ code: 'MACHINE_UNAVAILABLE', error: 'machine is unavailable' });
    return machine.branchId;
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
    if (result.kind === 'gamer_busy') {
      throw new ConflictException({ code: 'GAMER_ALREADY_BOOKED', error: 'you already have a booking at this time' });
    }
    return result.reservation;
  }
}
