import { ConflictException, Injectable, Logger } from '@nestjs/common';

import { WalletService } from '../../wallet/services/wallet.service.js';
import { SessionsRepository } from '../repository/sessions.repository.js';
import { rateAt, type Meter } from '../util/metering.js';
import { insufficientFunds, isGranted, notFound } from '../util/session-rules.js';

import { SessionMeteringService } from './session-metering.service.js';
import { SessionNoticesService } from './session-notices.service.js';
import { SessionRunoutService } from './session-runout.service.js';

/** How much extra time a gamer can add near the end of a booking. */
export const EXTEND_MINUTES = [30, 60, 90] as const;

/** Extra time on a running booking: the PC must be free and the wallet cover it. */
@Injectable()
export class SessionExtensionsService {
  private readonly logger = new Logger(SessionExtensionsService.name);

  constructor(
    private readonly repo: SessionsRepository,
    private readonly wallet: WalletService,
    private readonly metering: SessionMeteringService,
    private readonly runout: SessionRunoutService,
    private readonly notices: SessionNoticesService,
  ) {}

  /** The extensions the gamer can buy now: the PC must be free and the wallet cover it. */
  async extendOptions(gamerProfileId: string, reservationId: string) {
    const { session, now } = await this.extendable(gamerProfileId, reservationId);
    const [{ balance }, committed] = await Promise.all([
      this.wallet.getWalletForGamer(gamerProfileId),
      this.metering.committedCents(gamerProfileId, now),
    ]);
    const options = [];
    for (const minutes of EXTEND_MINUTES) {
      const to = new Date(session.endTime.getTime() + minutes * 60_000);
      const quote = await this.metering.quote(gamerProfileId, session.reservation.machine.branchId, true, session.endTime, minutes);
      const busy = await this.repo.isMachineBusy(session.reservation.machineId, session.endTime, to, reservationId);
      const affordable = balance - committed >= quote.totalCents;
      options.push({ minutes, costCents: quote.totalCents, available: !busy && affordable, reason: busy ? 'SLOT_TAKEN' : affordable ? null : 'INSUFFICIENT_FUNDS' });
    }
    return { reservationId, endsAt: session.endTime.toISOString(), options };
  }

  /**
   * Adds `minutes` at the pay-as-you-go (walk-in) rate to the end of the
   * gamer's running booking. The PC must be free for that time and the
   * wallet cover it on top of everything already promised.
   */
  async extend(gamerProfileId: string, reservationId: string, minutes: number) {
    const { session, now } = await this.extendable(gamerProfileId, reservationId);
    const from = session.endTime;
    const to = new Date(from.getTime() + minutes * 60_000);
    const quote = await this.metering.quote(gamerProfileId, session.reservation.machine.branchId, true, from, minutes);

    const [{ balance }, committed] = await Promise.all([
      this.wallet.getWalletForGamer(gamerProfileId),
      this.metering.committedCents(gamerProfileId, now),
    ]);
    if (balance - committed < quote.totalCents) {
      throw insufficientFunds(`${minutes} more minutes cost ${quote.totalCents} millimes; your balance doesn't cover it`);
    }

    // The extra time bills at the walk-in rate: switch at the old end when the session bills another one.
    const current = rateAt(session as Meter, from);
    const switchNeeded = !session.rateSwitchAt && current !== quote.centsPerMinute;
    const result = await this.repo.extendIfFree({
      reservationId,
      sessionId: session.id,
      machineId: session.reservation.machineId,
      gamerProfileId,
      from,
      to,
      session: {
        endingNoticeSentAt: null,
        ...(switchNeeded ? { nextRateCentsPerMinute: quote.centsPerMinute, rateSwitchAt: from } : {}),
      },
    });
    if (result.kind === 'slot_taken') {
      throw new ConflictException({ code: 'RESERVATION_SLOT_TAKEN', error: 'the PC is booked right after your time' });
    }
    if (result.kind === 'gamer_busy') {
      throw new ConflictException({ code: 'GAMER_ALREADY_BOOKED', error: 'you already have a booking at that time' });
    }

    this.logger.log(`session ${session.id} extended by ${minutes} min to ${to.toISOString()}`);
    const updated = { ...session, ...result.session };
    await this.runout.scheduleRunout(updated);
    await this.notices.notify(updated, 'CLEAR');
    return { reservationId, sessionId: session.id, endsAt: to.toISOString(), costCents: quote.totalCents };
  }

  /** The gamer's own running session on this booking, still inside its window. */
  private async extendable(gamerProfileId: string, reservationId: string) {
    const now = new Date();
    const reservation = await this.repo.findReservationForStart(reservationId);
    if (!reservation || reservation.gamerProfileId !== gamerProfileId) {
      throw notFound('RESERVATION_NOT_FOUND', 'reservation not found');
    }
    const open = await this.repo.findActiveForReservation(reservationId);
    const session = open && (await this.repo.findForSettlement(open.id));
    if (!session || !isGranted(session, now)) {
      throw new ConflictException({ code: 'SESSION_NOT_RUNNING', error: 'you can only extend a session that is running' });
    }
    return { session, now };
  }
}
