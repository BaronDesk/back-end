import { ConflictException, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Subscription } from 'rxjs';
import { Prisma, type Session } from '../../../generated/prisma/index.js';

import { assertScope } from '../../../common/utils/assert-scope.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { MembershipService } from '../../membership/services/membership.service.js';
import { CommandsService } from '../../ops/services/commands.service.js';
import {
  StationSessionPort,
  type LoginDecision,
  type StationLease,
  type StationSessionHandler,
} from '../../ops/services/station-session.port.js';
import { PricingService } from '../../pricing/services/pricing.service.js';
import type { StateReportPayload } from '../../station/schemas/presence.schemas.js';
import {
  PresenceService,
  type SessionEndedEvent,
  type StationRef,
  type StationStatusEvent,
} from '../../station/services/presence.service.js';
import { WalletService } from '../../wallet/services/wallet.service.js';
import { OPEN_SESSION_STATUSES, SessionsRepository } from '../repository/sessions.repository.js';
import { generatePin, hashPin, verifyPin } from '../util/pin.js';
import { toSessionDto, type SessionRecord } from '../util/public-session.js';

import { RunoutTimerService } from './runout-timer.service.js';

/** The only login method the backend accepts from the lock screen. */
const PIN_METHOD = 'pin';

/** A gamer can get their PIN from 15 minutes before the booked time. */
const CHECK_IN_EARLY_MS = 15 * 60_000;

const rejected = (reason: string): LoginDecision => ({ accepted: false, reason });

function secondsBetween(from: Date, to: Date): number {
  return Math.max(Math.round((to.getTime() - from.getTime()) / 1000), 0);
}

function toLease(seconds: number, now: Date): StationLease {
  return { leaseSeconds: Math.max(seconds, 0), serverTime: now.toISOString() };
}

const notFound = (code: string, error: string) => new NotFoundException({ code, error });

type SettlementSession = NonNullable<Awaited<ReturnType<SessionsRepository['findForSettlement']>>>;
type StartableReservation = NonNullable<Awaited<ReturnType<SessionsRepository['findReservationForStart']>>>;

/**
 * Owns Session lifecycle, station login, leases, derived metering and
 * settlement.
 *
 * start() creates a PENDING session with a hashed, single-use PIN and sends
 * the station nothing. The gamer types the PIN on the lock screen, the agent
 * relays it as login_request, and login() checks it here; the agent gateway
 * answers login_result and only then sends UNLOCK { sessionId, lease }.
 *
 * Metering state (ACTIVE/PAUSED) and close-out (COMPLETED) are driven by
 * PresenceService's agent-reported events — the same path whether a station
 * got locked by staff, by a lapsed lease, or (once feat/runout-timer wires
 * in) by running out of funds. Never by a command ack.
 */
@Injectable()
export class SessionsService implements OnModuleInit, OnModuleDestroy, StationSessionHandler {
  private readonly logger = new Logger(SessionsService.name);
  private statusSub?: Subscription;
  private endedSub?: Subscription;
  private sweepTimer?: NodeJS.Timeout;

  private readonly pinTtlMs: number;
  private readonly pinMaxAttempts: number;
  private readonly leaseCapSeconds: number;
  private readonly sweepIntervalMs: number;

  private creditSub?: Subscription;

  constructor(
    private readonly repo: SessionsRepository,
    private readonly presence: PresenceService,
    private readonly pricing: PricingService,
    private readonly membership: MembershipService,
    private readonly wallet: WalletService,
    private readonly commands: CommandsService,
    private readonly runoutTimer: RunoutTimerService,
    private readonly port: StationSessionPort,
    config: ConfigService,
  ) {
    this.pinTtlMs = Number(config.get('SESSION_PIN_TTL_S') ?? 900) * 1000;
    this.pinMaxAttempts = Number(config.get('SESSION_PIN_MAX_ATTEMPTS') ?? 5);
    this.leaseCapSeconds = Number(config.get('SESSION_LEASE_CAP_S') ?? 180);
    this.sweepIntervalMs = Number(config.get('SESSION_SWEEP_INTERVAL_MS') ?? 60_000);
  }

  onModuleInit(): void {
    this.statusSub = this.presence.statusChanges.subscribe((event) => void this.onStationStatus(event));
    this.endedSub = this.presence.sessionEnded.subscribe((event) => void this.onSessionEnded(event));
    this.port.register(this);
    this.sweepTimer = setInterval(() => void this.sweep(), this.sweepIntervalMs);
    this.sweepTimer.unref();
    this.creditSub = this.wallet.credited.subscribe((e) => void this.onWalletCredited(e));
  }

  onModuleDestroy(): void {
    this.statusSub?.unsubscribe();
    this.endedSub?.unsubscribe();
    this.creditSub?.unsubscribe();
    clearInterval(this.sweepTimer);
  }

  /**
   * Staff start: creates the PENDING session with a fresh PIN for the desk to
   * hand the gamer. Gamers normally get their PIN themselves (checkIn).
   */
  async start(caller: AccessTokenPayload, reservationId: string) {
    const reservation = await this.repo.findReservationForStart(reservationId);
    if (!reservation) throw notFound('RESERVATION_NOT_FOUND', 'reservation not found');
    assertScope(caller, { branchId: reservation.machine.branchId });
    const { session, pin } = await this.issuePin(reservation, new Date(), false);
    return { ...toSessionDto(session as SessionRecord), pin };
  }

  /**
   * The gamer's own check-in: the same PENDING session and PIN as start(),
   * handed straight to the gamer. Opens CHECK_IN_EARLY_MS before the booking.
   * Asking again replaces a PIN nobody has typed yet, so a lost PIN is never
   * a dead end. The caller has already resolved the gamer's profile.
   */
  async checkIn(gamerProfileId: string, reservationId: string) {
    const reservation = await this.repo.findReservationForStart(reservationId);
    if (!reservation || reservation.gamerProfileId !== gamerProfileId) {
      throw notFound('RESERVATION_NOT_FOUND', 'reservation not found');
    }
    const now = new Date();
    if (reservation.startTime.getTime() - CHECK_IN_EARLY_MS > now.getTime()) {
      throw new ConflictException({ code: 'RESERVATION_NOT_STARTED', error: 'check-in opens 15 minutes before the booking' });
    }
    const { session, pin } = await this.issuePin(reservation, now, true);
    return { sessionId: session.id, reservationId, pin, pinExpiresAt: session.pinExpiresAt };
  }

  /**
   * Creates the PENDING session with a fresh PIN. Only the PIN's hash is
   * stored; the plaintext is returned here, once. Nothing is sent to the
   * station: it unlocks only after an accepted login. `replaceUnusedPin`
   * lets a PIN nobody typed yet be replaced even while it is still valid.
   */
  private async issuePin(reservation: StartableReservation, now: Date, replaceUnusedPin: boolean) {
    const reservationId = reservation.id;
    if (reservation.status !== 'CONFIRMED') {
      throw new ConflictException({ code: 'RESERVATION_NOT_CONFIRMED', error: 'reservation is not confirmed' });
    }
    if (reservation.endTime <= now) {
      throw new ConflictException({ code: 'RESERVATION_EXPIRED', error: 'reservation window is over' });
    }
    if (!this.presence.isOnline(reservation.machine.serialNumber)) {
      throw new ConflictException({ code: 'STATION_OFFLINE', error: 'station is not online' });
    }
    const open = await this.repo.findActiveForReservation(reservationId);
    if (open) {
      // A PIN that expired or was burned unused can be replaced; anything else is a live session.
      const replaceable = replaceUnusedPin ? open.status === 'PENDING' && !open.pinUsedAt : this.isDeadPin(open, now);
      if (!replaceable) {
        throw new ConflictException({ code: 'SESSION_ALREADY_STARTED', error: 'reservation already has an open session' });
      }
      await this.repo.cancelPending(open.id);
    }

    const rate = await this.computeRate(reservation.machine.branchId, reservation.gamerProfileId);
    const pin = generatePin();
    const pinWindowStart = Math.max(now.getTime(), reservation.startTime.getTime());
    const session = await this.repo.create({
      reservationId,
      appliedMembershipId: rate.membershipId,
      startTime: reservation.startTime,
      endTime: reservation.endTime,
      rateCentsPerMinute: rate.centsPerMinute,
      pinHash: await hashPin(pin),
      pinExpiresAt: new Date(Math.min(pinWindowStart + this.pinTtlMs, reservation.endTime.getTime())),
    });

    return { session, pin };
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
    return this.commands.issue(caller, session.reservation.machineId, { type: 'END_SESSION', reason });
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

  /**
   * login_request from the station's lock screen. Checks the PIN of the
   * station's open PENDING session: not expired, not spent, within the
   * attempt limit. Accepting spends the PIN. The gateway sends login_result
   * and then the UNLOCK; nothing is sent from here.
   */
  async login(station: StationRef, method: string, credential: string): Promise<LoginDecision> {
    if (method !== PIN_METHOD) return rejected('unsupported_method');
    const now = new Date();
    const session = await this.repo.findLoginCandidate(station.machineId, now);
    if (!session) return rejected('no_pending_session');
    if (session.pinUsedAt) return rejected('pin_used');
    if (!session.pinHash || !session.pinExpiresAt || session.pinExpiresAt <= now) return rejected('pin_expired');
    // The attempt is taken before the check, so parallel guesses cannot overrun the limit.
    if (!(await this.repo.claimPinAttempt(session.id, this.pinMaxAttempts))) {
      return rejected(session.pinAttempts >= this.pinMaxAttempts ? 'too_many_attempts' : 'pin_used');
    }
    if (!(await verifyPin(session.pinHash, credential.trim()))) return rejected('invalid_pin');
    if (!(await this.repo.spendPin(session.id, now))) return rejected('pin_used');
    return { accepted: true, sessionId: session.id, lease: this.leaseFor(session, now) };
  }

  /**
   * heartbeat_ack lease. Zero unless the station reports a session of its own
   * that was logged into and is still open and inside its window: a station
   * is never left unlocked without a reason to be.
   */
  async lease(station: StationRef, sessionId: string | null): Promise<StationLease> {
    const now = new Date();
    if (!sessionId) return toLease(0, now);
    const session = await this.repo.findForSettlement(sessionId);
    if (!session || session.reservation.machineId !== station.machineId || !this.isGranted(session, now)) {
      return toLease(0, now);
    }
    return this.leaseFor(session, now);
  }

  /**
   * state_report on (re)connect. A session still open and in its window is
   * resumed with a fresh UNLOCK + lease; metering picks up again once presence
   * sees locked=false. A session that ran past its window meanwhile is settled
   * and ended on the station; any other session the station holds is ended.
   */
  async reconcile(station: StationRef, report: StateReportPayload): Promise<void> {
    if (!report.sessionId) return;
    const now = new Date();
    const found = await this.repo.findForSettlement(report.sessionId);
    const session = found?.reservation.machineId === station.machineId ? found : null;

    if (session && this.isGranted(session, now)) {
      await this.commands.issueSessionUnlock(station.machineId, { sessionId: session.id, ...this.leaseFor(session, now) }, 'resume');
      return;
    }
    if (session && OPEN_SESSION_STATUSES.includes(session.status) && session.endTime <= now) {
      await this.closeOverdue(session);
      return;
    }
    this.logger.warn(`station ${station.serialNumber} reports session ${report.sessionId}, which is not open for it; ending it`);
    await this.commands.issueSystemEndSession(station.machineId, 'session_closed');
  }

  private async onStationStatus(event: StationStatusEvent): Promise<void> {
    if (!event.sessionId) return;
    const session = await this.repo.findForSettlement(event.sessionId)
    if (!session || !OPEN_SESSION_STATUSES.includes(session.status)) return;

    if (event.locked === false && session.status !== 'ACTIVE') {
      // The agent binds a session only from an UNLOCK, which only follows an accepted login.
      if (session.status === 'PENDING' && !session.pinUsedAt) return;
      await this.repo.activate(session.id, session.reservationId, { status: 'ACTIVE', meteringStartedAt: new Date(), lockedAt: null });
      await this.runoutTimer.scheduleOrReschedule({
        sessionId: session.id,
        gamerProfileId: session.reservation.gamerProfileId,
        machineId: session.reservation.machineId,
        branchId: event.branchId,
        serialNumber: event.serialNumber,
        rateCentsPerMinute: session.rateCentsPerMinute,
      });
    } else if (event.locked === true && session.status === 'ACTIVE') {
      const now = new Date();
      const meteredSeconds = session.meteredSeconds + secondsBetween(session.meteringStartedAt ?? now, now);
      await this.repo.update(session.id, { status: 'PAUSED', meteringStartedAt: null, meteredSeconds, lockedAt: now });
      await this.runoutTimer.cancel(session.id);
    }
  }

  private async onSessionEnded(event: SessionEndedEvent): Promise<void> {
    const session = await this.repo.findForSettlement(event.sessionId);
    if (!session || !OPEN_SESSION_STATUSES.includes(session.status)) return;
    await this.settle(session, new Date(event.endedAt));
    await this.runoutTimer.cancel(session.id)
  }

  private async onWalletCredited(event: { gamerProfileId: string }): Promise<void> {
    const session = await this.repo.findActiveByGamer(event.gamerProfileId);
    if (!session) return;
    await this.runoutTimer.scheduleOrReschedule({
      sessionId: session.id,
      gamerProfileId: event.gamerProfileId,
      machineId: session.reservation.machineId,
      branchId: session.reservation.machine.branchId,
      serialNumber: session.reservation.machine.serialNumber,
      rateCentsPerMinute: session.rateCentsPerMinute,
    });
  }

  /**
   * Reservations past their window. A PENDING session nobody logged into is
   * cancelled (PIN expired) and its reservation becomes NO_SHOW. Any other
   * open session is settled at its window end — no lease reaches past it, so
   * the station is locked by then — and ended on the station.
   */
  async sweep(): Promise<void> {
    try {
      const now = new Date();
      for (const session of await this.repo.findOverdueOpen(now)) {
        if (session.status === 'PENDING' && !session.pinUsedAt) {
          await this.repo.cancelPending(session.id);
          this.logger.log(`session ${session.id} cancelled: reservation window passed without a login`);
        } else {
          await this.closeOverdue(session);
        }
      }
      const noShows = await this.repo.markNoShows(now);
      if (noShows) this.logger.log(`${noShows} reservation(s) marked NO_SHOW`);
    } catch (err) {
      this.logger.error(`session sweep failed: ${(err as Error).message}`);
    }
  }

  private async closeOverdue(session: SettlementSession): Promise<void> {
    await this.settle(session, session.endTime);
    await this.commands.issueSystemEndSession(session.reservation.machineId, 'reservation_ended');
  }

  /** Logged into, still open and inside its reservation window. */
  private isGranted(session: Session, now: Date): boolean {
    return (
      OPEN_SESSION_STATUSES.includes(session.status) &&
      (session.status !== 'PENDING' || session.pinUsedAt !== null) &&
      session.endTime > now
    );
  }

  /** A never-used PIN that can no longer be used: expired or out of attempts. */
  private isDeadPin(session: Session, now: Date): boolean {
    if (session.status !== 'PENDING' || session.pinUsedAt) return false;
    return !session.pinExpiresAt || session.pinExpiresAt <= now || session.pinAttempts >= this.pinMaxAttempts;
  }

  /**
   * The shorter of the remaining reservation window and the safety cap,
   * re-granted on every heartbeat.
   * TODO(runout-timer): replace the cap with the exact funds/quota run-out time.
   */
  private leaseFor(session: Session, now: Date): StationLease {
    const windowSeconds = Math.floor((session.endTime.getTime() - now.getTime()) / 1000);
    return toLease(Math.min(windowSeconds, this.leaseCapSeconds), now);
  }

  private async settle(session: SettlementSession, endedAt: Date): Promise<void> {
    // No lease reaches past the reservation window, so neither does metering.
    const meteredUntil = new Date(Math.min(endedAt.getTime(), session.endTime.getTime()));
    let meteredSeconds = session.meteredSeconds;
    if (session.status === 'ACTIVE' && session.meteringStartedAt) {
      meteredSeconds += secondsBetween(session.meteringStartedAt, meteredUntil);
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

    await this.repo.complete(session.id, session.reservationId, {
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
