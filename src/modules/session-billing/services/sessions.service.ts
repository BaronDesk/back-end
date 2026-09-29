import { ConflictException, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import type { Subscription } from 'rxjs';
import { Prisma } from '../../../generated/prisma/index.js';

import { assertScope } from '../../../common/utils/assert-scope.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { MembershipService } from '../../membership/services/membership.service.js';
import { CommandsService } from '../../ops/services/commands.service.js';
import { PricingService } from '../../pricing/services/pricing.service.js';
import { PresenceService, type SessionEndedEvent, type StationStatusEvent } from '../../station/services/presence.service.js';
import { WalletService } from '../../wallet/services/wallet.service.js';
import { OPEN_SESSION_STATUSES, SessionsRepository } from '../repository/sessions.repository.js';
import { toSessionDto, type SessionRecord } from '../util/public-session.js';

/** Shown to the gamer to confirm the booking unlock on the station's lock screen. */
function generatePin(): string {
  return String(Math.floor(1000 + Math.random() * 9000));
}

function secondsBetween(from: Date, to: Date): number {
  return Math.max(Math.round((to.getTime() - from.getTime()) / 1000), 0);
}

const notFound = (code: string, error: string) => new NotFoundException({ code, error });

/**
 * Owns Session lifecycle, derived metering and settlement. Metering state
 * (ACTIVE/PAUSED) and close-out (COMPLETED) are driven entirely by
 * PresenceService's agent-reported events — the same path whether a station
 * got locked by staff, by a wrong PIN, or (once feat/runout-timer wires in)
 * by running out of funds. This module never talks to the agent directly.
 */
@Injectable()
export class SessionsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SessionsService.name);
  private statusSub?: Subscription;
  private endedSub?: Subscription;

  constructor(
    private readonly repo: SessionsRepository,
    private readonly presence: PresenceService,
    private readonly pricing: PricingService,
    private readonly membership: MembershipService,
    private readonly wallet: WalletService,
    private readonly commands: CommandsService,
  ) {}

  onModuleInit(): void {
    this.statusSub = this.presence.statusChanges.subscribe((event) => void this.onStationStatus(event));
    this.endedSub = this.presence.sessionEnded.subscribe((event) => void this.onSessionEnded(event));
  }

  onModuleDestroy(): void {
    this.statusSub?.unsubscribe();
    this.endedSub?.unsubscribe();
  }

  /**
   * Creates the session row and sends the booking UNLOCK with a fresh PIN —
   * the station stays locked until the gamer types it in. A failed send just
   * leaves the session PENDING for staff to retry.
   */
  async start(caller: AccessTokenPayload, reservationId: string) {
    const reservation = await this.repo.findReservationForStart(reservationId);
    if (!reservation) throw notFound('RESERVATION_NOT_FOUND', 'reservation not found');
    assertScope(caller, { branchId: reservation.machine.branchId });
    if (reservation.status !== 'CONFIRMED') {
      throw new ConflictException({ code: 'RESERVATION_NOT_CONFIRMED', error: 'reservation is not confirmed' });
    }
    if (await this.repo.findActiveForReservation(reservationId)) {
      throw new ConflictException({ code: 'SESSION_ALREADY_STARTED', error: 'reservation already has an open session' });
    }

    const rate = await this.computeRate(reservation.machine.branchId, reservation.gamerProfileId);
    const session = await this.repo.create({
      reservationId,
      appliedMembershipId: rate.membershipId,
      startTime: reservation.startTime,
      endTime: reservation.endTime,
      rateCentsPerMinute: rate.centsPerMinute,
    });

    const pin = generatePin();
    try {
      await this.commands.issue(caller, reservation.machineId, { type: 'UNLOCK', payload: { sessionId: session.id, pin } });
    } catch (err) {
      this.logger.warn(`booking UNLOCK not sent for session ${session.id}: ${(err as Error).message}`);
    }

    return { ...toSessionDto(session as SessionRecord), pin };
  }

  async get(caller: AccessTokenPayload, id: string) {
    const session = await this.repo.findByIdWithReservation(id);
    if (!session) throw notFound('SESSION_NOT_FOUND', 'session not found');
    assertScope(caller, { branchId: session.reservation.machine.branchId });
    return toSessionDto(session as SessionRecord);
  }

  /** Staff-forced end; the actual billing close-out only runs once presence confirms the station cleared the session (onSessionEnded). */
  async end(caller: AccessTokenPayload, id: string, reason?: string) {
    const session = await this.repo.findByIdWithReservation(id);
    if (!session) throw notFound('SESSION_NOT_FOUND', 'session not found');
    assertScope(caller, { branchId: session.reservation.machine.branchId });
    if (!OPEN_SESSION_STATUSES.includes(session.status)) {
      throw new ConflictException({ code: 'SESSION_NOT_OPEN', error: 'session is already closed' });
    }
    return this.commands.issue(caller, session.reservation.machineId, { type: 'END_SESSION', reason, payload: undefined,});
  }

  /**
   * RUNOUT_LOCK_HANDLER seam for feat/runout-timer. Just requests the lock —
   * the PAUSED transition and metering close-out happen through
   * onStationStatus once presence reports the station actually locked, same
   * as a staff-issued LOCK.
   */
  async lockForRunout(sessionId: string): Promise<void> {
    const session = await this.repo.findByIdWithReservation(sessionId);
    if (!session || !OPEN_SESSION_STATUSES.includes(session.status)) return;
    await this.commands.issueSystemLock(session.reservation.machineId, 'runout');
  }

  private async onStationStatus(event: StationStatusEvent): Promise<void> {
    if (!event.sessionId) return;
    const session = await this.repo.findById(event.sessionId);
    if (!session || !OPEN_SESSION_STATUSES.includes(session.status)) return;

    if (event.locked === false && session.status !== 'ACTIVE') {
      await this.repo.update(session.id, { status: 'ACTIVE', meteringStartedAt: new Date(), lockedAt: null });
      // TODO(runout-timer): runoutTimer.scheduleOrReschedule({ sessionId: session.id, gamerProfileId, machineId, branchId, serialNumber, rateCentsPerMinute: session.rateCentsPerMinute })
    } else if (event.locked === true && session.status === 'ACTIVE') {
      const now = new Date();
      const meteredSeconds = session.meteredSeconds + secondsBetween(session.meteringStartedAt ?? now, now);
      await this.repo.update(session.id, { status: 'PAUSED', meteringStartedAt: null, meteredSeconds, lockedAt: now });
      // TODO(runout-timer): runoutTimer.cancel(session.id)
    }
  }

  private async onSessionEnded(event: SessionEndedEvent): Promise<void> {
    const session = await this.repo.findForSettlement(event.sessionId);
    if (!session || !OPEN_SESSION_STATUSES.includes(session.status)) return;
    await this.settle(session, new Date(event.endedAt));
    // TODO(runout-timer): runoutTimer.cancel(session.id)
  }

  private async settle(session: any, endedAt: Date): Promise<void> {
    let meteredSeconds = session.meteredSeconds;
    if (session.status === 'ACTIVE' && session.meteringStartedAt) {
      meteredSeconds += secondsBetween(session.meteringStartedAt, endedAt);
    }
    const rate = session.rateCentsPerMinute ?? 0;
    const totalCents = Math.max(Math.round((meteredSeconds / 60) * rate), 0);

    const breakdown: Record<string, unknown> = {
      rateCentsPerMinute: rate,
      meteredSeconds,
      totalCents,
      appliedMembershipId: session.appliedMembershipId,
    };

    if (totalCents > 0) {
      try {
        await this.wallet.debit(session.reservation.gamerProfileId, {
          amount: totalCents,
          type: 'PAYMENT',
          sessionId: session.id,
          idempotencyKey: `session-settlement:${session.id}`,
        });
      } catch (err) {
        this.logger.error(`settlement debit failed for session ${session.id}: ${(err as Error).message}`);
        breakdown.debitFailed = true; // session still closes; staff reconciles from the flagged breakdown
      }
    }

    await this.repo.update(session.id, {
      status: 'COMPLETED',
      meteringStartedAt: null,
      meteredSeconds,
      lockedAt: null,
      settledAt: endedAt,
      billingBreakdown: breakdown as unknown as Prisma.InputJsonValue,
    });
  }

  /** paygRate is cents/hour (Pricing convention); membership discount applies before converting to cents/minute. */
  private async computeRate(branchId: string, gamerProfileId: string): Promise<{ centsPerMinute: number; membershipId: string | null }> {
    const { paygRate } = await this.pricing.getRatesForBranch(branchId);
    const discount = await this.membership.getActiveDiscountForGamer(gamerProfileId);
    const discountPercent = discount ? Number(discount.discountPercent) : 0;
    const centsPerHour = Math.round(paygRate * (1 - discountPercent / 100));
    return { centsPerMinute: Math.max(Math.round(centsPerHour / 60), 0), membershipId: discount?.membershipId ?? null };
  }
}
