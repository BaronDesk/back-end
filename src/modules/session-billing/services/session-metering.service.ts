import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '../../../generated/prisma/index.js';

import { MembershipService } from '../../membership/services/membership.service.js';
import { CommandsService } from '../../ops/services/commands.service.js';
import { PricingService } from '../../pricing/services/pricing.service.js';
import { SubscriptionsService } from '../../subscriptions/services/subscriptions.service.js';
import { WalletService } from '../../wallet/services/wallet.service.js';
import { SessionsRepository } from '../repository/sessions.repository.js';
import { costAt, exactCostAt, foldDueRateSwitch, rateAt, secondsBetween, type Meter } from '../util/metering.js';
import { insufficientFunds, sessionConfig, type SettlementSession } from '../util/session-rules.js';

import { RunoutTimerService } from './runout-timer.service.js';

export interface Quote {
  centsPerMinute: number;
  totalCents: number;
  membershipId: string | null;
}

/**
 * Rates, quotes and the money rules around them (a gamer never books or plays
 * past what their wallet covers), derived metering (rate switches, pauses) and
 * settlement: the one place a session is closed and charged.
 */
@Injectable()
export class SessionMeteringService implements OnModuleInit {
  private readonly logger = new Logger(SessionMeteringService.name);
  private readonly minPlayMinutes: number;

  constructor(
    private readonly repo: SessionsRepository,
    private readonly pricing: PricingService,
    private readonly membership: MembershipService,
    private readonly subscriptions: SubscriptionsService,
    private readonly wallet: WalletService,
    private readonly commands: CommandsService,
    private readonly runoutTimer: RunoutTimerService,
    config: ConfigService,
  ) {
    this.minPlayMinutes = sessionConfig(config).minPlayMinutes;
  }

  onModuleInit(): void {
    this.wallet.setReserveProvider((gamerProfileId) => this.usedByRunningSessions(gamerProfileId));
  }

  // --- money ---------------------------------------------------------------

  /** What a booking of `minutes` from `start` would cost this gamer at this branch. */
  async quote(gamerProfileId: string, branchId: string, isWalkIn: boolean, start: Date, minutes: number): Promise<Quote> {
    const rate = await this.computeRate(branchId, gamerProfileId, isWalkIn, start);
    return { ...rate, totalCents: rate.centsPerMinute * minutes };
  }

  /**
   * Money the gamer has already promised: what their running sessions cost so
   * far plus the rest of their booked time, and every booking ahead that
   * hasn't started. A new booking or an extension must fit in what is left.
   */
  async committedCents(gamerProfileId: string, now = new Date(), excludeReservationId?: string): Promise<number> {
    let committed = 0;
    for (const session of await this.repo.findGrantedByGamer(gamerProfileId)) {
      const meter = session as Meter;
      const remainingMin = Math.max((session.endTime.getTime() - now.getTime()) / 60_000, 0);
      committed += exactCostAt(meter, now) + remainingMin * rateAt(meter, now);
    }
    for (const booking of await this.repo.findUpcomingUnstarted(gamerProfileId, now, excludeReservationId)) {
      const minutes = (booking.endTime.getTime() - booking.startTime.getTime()) / 60_000;
      const start = booking.startTime > now ? booking.startTime : now;
      committed += (await this.quote(gamerProfileId, booking.machine.branchId, booking.isWalkIn, start, minutes)).totalCents;
    }
    return Math.ceil(committed);
  }

  /**
   * Refuses (409 INSUFFICIENT_FUNDS) a booking the wallet can't pay for once
   * everything already promised is set aside. Returns the quote.
   */
  async assertAffordable(input: {
    gamerProfileId: string;
    branchId: string;
    isWalkIn: boolean;
    start: Date;
    minutes: number;
  }): Promise<Quote> {
    const quote = await this.quote(input.gamerProfileId, input.branchId, input.isWalkIn, input.start, input.minutes);
    if (quote.totalCents <= 0) return quote;
    const [{ balance }, committed] = await Promise.all([
      this.wallet.getWalletForGamer(input.gamerProfileId),
      this.committedCents(input.gamerProfileId),
    ]);
    if (balance - committed < quote.totalCents) {
      throw insufficientFunds(
        `this booking costs ${quote.totalCents} millimes; your balance leaves ${Math.max(balance - committed, 0)} after your other bookings`,
      );
    }
    return quote;
  }

  /** Money the gamer's running sessions have already used: other spending must leave it alone. */
  async usedByRunningSessions(gamerProfileId: string): Promise<number> {
    const now = new Date();
    const sessions = await this.repo.findGrantedByGamer(gamerProfileId);
    return sessions.reduce((sum, s) => sum + costAt(s as Meter, now), 0);
  }

  /** Free play always does; paid play needs the balance for the minimum play time (at least a minute). */
  async coversMinimumPlay(gamerProfileId: string, centsPerMinute: number): Promise<boolean> {
    if (centsPerMinute <= 0) return true;
    const { balance } = await this.wallet.getWalletForGamer(gamerProfileId);
    const used = await this.usedByRunningSessions(gamerProfileId);
    return balance - used >= centsPerMinute * Math.max(this.minPlayMinutes, 1);
  }

  /**
   * Rates are per hour (Pricing convention): paygRate for Play now, bookingRate
   * for a booking made ahead. The better of the membership discount and a
   * pass window discount (at the time play starts) applies — they don't stack —
   * before converting to per minute.
   */
  async computeRate(
    branchId: string,
    gamerProfileId: string,
    isWalkIn: boolean,
    playStarts: Date,
  ): Promise<{ centsPerMinute: number; membershipId: string | null }> {
    const { paygRate, bookingRate } = await this.pricing.getRatesForBranch(branchId);
    const [membership, pass] = await Promise.all([
      this.membership.getActiveDiscountForGamer(gamerProfileId),
      this.subscriptions.getWindowDiscountForGamer(gamerProfileId, playStarts),
    ]);
    const membershipPercent = membership ? Number(membership.discountPercent) : 0;
    const passPercent = pass?.discountPercent ?? 0;
    const discountPercent = Math.max(membershipPercent, passPercent);
    const centsPerHour = Math.round((isWalkIn ? paygRate : bookingRate) * (1 - discountPercent / 100));
    return {
      centsPerMinute: Math.max(Math.round(centsPerHour / 60), 0),
      membershipId: membership && membershipPercent >= passPercent ? membership.membershipId : null,
    };
  }

  // --- metering ------------------------------------------------------------

  async foldRateSwitch(session: SettlementSession, now: Date): Promise<SettlementSession> {
    const fold = foldDueRateSwitch(session as Meter, now);
    if (!fold) return session;
    await this.repo.update(session.id, fold);
    return { ...session, ...fold } as SettlementSession;
  }

  async pause(session: SettlementSession, at: Date, lockReason: string | null): Promise<void> {
    const until = new Date(Math.min(at.getTime(), session.endTime.getTime()));
    const started = session.meteringStartedAt ?? until;
    const meteredSeconds = session.meteredSeconds + (until > started ? secondsBetween(started, until) : 0);
    await this.repo.update(session.id, { status: 'PAUSED', meteringStartedAt: null, meteredSeconds, lockedAt: at, lockReason });
    await this.runoutTimer.cancel(session.id);
  }

  /**
   * After a single station's drop: the gamer kept playing on the unlocked PC
   * until it locked itself, so bill from the pause (its last heartbeat) to
   * `stationLockedAt`, never past `maxSeconds` after the pause (the lease it
   * held, plus grace) nor the booking end. Once per pause: a repeated
   * reconnect bills nothing more. Returns the session as billed.
   */
  async billOfflineDrop(session: SettlementSession, stationLockedAt: Date, maxSeconds: number): Promise<SettlementSession> {
    const pausedAt = session.lockedAt;
    if (session.status !== 'PAUSED' || !pausedAt) return session;
    if (session.offlineBilledFor?.getTime() === pausedAt.getTime()) return session;
    const until = new Date(Math.min(stationLockedAt.getTime(), pausedAt.getTime() + maxSeconds * 1000, session.endTime.getTime()));
    const seconds = until > pausedAt ? secondsBetween(pausedAt, until) : 0;
    if (seconds <= 0 || !(await this.repo.billOfflineOnce(session.id, pausedAt, seconds))) return session;
    this.logger.log(`session ${session.id}: billed ${seconds}s played after the station dropped at ${pausedAt.toISOString()}`);
    return {
      ...session,
      meteredSeconds: session.meteredSeconds + seconds,
      offlineBilledSeconds: (session.offlineBilledSeconds ?? 0) + seconds,
      offlineBilledFor: pausedAt,
    };
  }

  // --- settlement ----------------------------------------------------------

  /**
   * Closes the session and charges it. The runout lock (with its margin) and
   * the booking checks keep the bill within the wallet; the capped debit is
   * only a safety net, and a shortfall is logged as an error.
   */
  /** False if another path closed the session first; the shared debit key keeps a repeat from billing twice. */
  async settle(found: SettlementSession, endedAt: Date, reason = 'normal'): Promise<boolean> {
    const session = await this.foldRateSwitch(found, endedAt);
    // No lease reaches past the reservation window, so neither does metering.
    const meteredUntil = new Date(Math.min(endedAt.getTime(), session.endTime.getTime()));
    const meter = session as Meter;
    const totalCents = costAt(meter, meteredUntil);
    let meteredSeconds = session.meteredSeconds;
    if (session.status === 'ACTIVE' && session.meteringStartedAt && meteredUntil > session.meteringStartedAt) {
      meteredSeconds += secondsBetween(session.meteringStartedAt, meteredUntil);
    }

    const breakdown: Record<string, unknown> = {
      rateCentsPerMinute: session.rateCentsPerMinute ?? 0,
      meteredSeconds,
      accruedCents: session.accruedCents,
      totalCents,
      appliedMembershipId: session.appliedMembershipId,
      endReason: reason,
    };
    // Play billed after a single station's drop (already in meteredSeconds).
    if (session.offlineBilledSeconds) breakdown.offlineBilledSeconds = session.offlineBilledSeconds;

    if (totalCents > 0) {
      try {
        const charged = await this.wallet.debitUpTo(session.reservation.gamerProfileId, {
          amount: totalCents,
          type: 'PAYMENT',
          sessionId: session.id,
          idempotencyKey: `session-settlement:${session.id}`,
        });
        breakdown.chargedCents = charged;
        if (charged < totalCents) {
          breakdown.shortfallCents = totalCents - charged;
          this.logger.error(`session ${session.id} settled ${totalCents - charged} short: the wallet held ${charged}`);
        }
      } catch (err) {
        this.logger.error(`settlement debit failed for session ${session.id}: ${(err as Error).message}`);
        breakdown.debitFailed = true; // session still closes; staff reconciles from the flagged breakdown
      }
    }

    const closed = await this.repo.complete(session.id, session.reservationId, {
      status: 'COMPLETED',
      meteringStartedAt: null,
      meteredSeconds,
      lockedAt: null,
      settledAt: endedAt,
      billingBreakdown: breakdown as unknown as Prisma.InputJsonValue,
    });
    await this.runoutTimer.cancel(session.id);
    return closed;
  }

  /** Settles at the window end, and ends it on the station only if the station still runs this very session. */
  async closeOverdue(session: SettlementSession): Promise<void> {
    await this.settle(session, session.endTime, 'reservation_ended');
    await this.commands.issueSystemEndSession(session.reservation.machineId, 'reservation_ended', session.id);
  }
}
