import { ConflictException, Injectable, Logger, NotFoundException, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Subscription } from 'rxjs';
import { Prisma, type Session } from '../../../generated/prisma/index.js';

import { assertScope } from '../../../common/utils/assert-scope.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { DASHBOARD_EVENTS, SERVER_MESSAGE_TYPES } from '../../../infra/realtime/constants.js';
import { MembershipService } from '../../membership/services/membership.service.js';
import { AgentGateway } from '../../ops/agent.gateway.js';
import { DashboardGateway } from '../../ops/dashboard.gateway.js';
import { CommandsService } from '../../ops/services/commands.service.js';
import {
  StationSessionPort,
  type LoginDecision,
  type StationLease,
  type StationSessionHandler,
} from '../../ops/services/station-session.port.js';
import { PricingService } from '../../pricing/services/pricing.service.js';
import { SubscriptionsService } from '../../subscriptions/services/subscriptions.service.js';
import type { StateReportPayload } from '../../station/schemas/presence.schemas.js';
import {
  PresenceService,
  type SessionEndedEvent,
  type StationRef,
  type StationStatusEvent,
} from '../../station/services/presence.service.js';
import { WalletService } from '../../wallet/services/wallet.service.js';
import { OPEN_SESSION_STATUSES, SessionsRepository } from '../repository/sessions.repository.js';
import { costAt, exactCostAt, foldDueRateSwitch, msUntilSpent, rateAt, secondsBetween, type Meter } from '../util/metering.js';
import { generatePin, hashPin, PinVault, verifyPin } from '../util/pin.js';
import { toSessionDto, type SessionRecord } from '../util/public-session.js';

import { RunoutTimerService } from './runout-timer.service.js';

/** The only login method the backend accepts from the lock screen. */
const PIN_METHOD = 'pin';

/** Session.lockReason: the backend locked the station because the gamer's funds ran out. */
const RUNOUT_LOCK = 'runout';
/** Session.lockReason: the station went offline mid-session; metering stopped at its last heartbeat. */
const OFFLINE_LOCK = 'offline';

/** How much extra time a gamer can add near the end of a booking. */
export const EXTEND_MINUTES = [30, 60, 90] as const;

const rejected = (reason: string): LoginDecision => ({ accepted: false, reason });

function toLease(seconds: number, now: Date): StationLease {
  return { leaseSeconds: Math.max(seconds, 0), serverTime: now.toISOString() };
}

const notFound = (code: string, error: string) => new NotFoundException({ code, error });

const insufficientFunds = (error: string) => new ConflictException({ code: 'INSUFFICIENT_FUNDS', error });

type SettlementSession = NonNullable<Awaited<ReturnType<SessionsRepository['findForSettlement']>>>;
type StartableReservation = NonNullable<Awaited<ReturnType<SessionsRepository['findReservationForStart']>>>;

export interface Quote {
  centsPerMinute: number;
  totalCents: number;
  membershipId: string | null;
}

/**
 * Owns Session lifecycle, station login, leases, derived metering and
 * settlement, and the money rules around them: a gamer never books, plays or
 * extends past what their wallet covers.
 *
 * start()/checkIn() create a PENDING session with a hashed, single-use PIN
 * and send the station nothing. The gamer types the PIN on the lock screen,
 * the agent relays it as login_request, and login() checks it here; the agent
 * gateway answers login_result and only then sends UNLOCK { sessionId, lease }.
 *
 * Metering state (ACTIVE/PAUSED) and close-out (COMPLETED) are driven by
 * PresenceService's agent-reported events — the same path whether a station
 * got locked by staff, by a lapsed lease, by running out of funds or by going
 * offline. Never by a command ack.
 */
@Injectable()
export class SessionsService implements OnModuleInit, OnModuleDestroy, StationSessionHandler {
  private readonly logger = new Logger(SessionsService.name);
  private readonly subs: Subscription[] = [];
  private sweepTimer?: NodeJS.Timeout;

  private readonly pinMaxAttempts: number;
  private readonly vault: PinVault;
  private readonly leaseCapSeconds: number;
  private readonly sweepIntervalMs: number;
  private readonly minPlayMinutes: number;
  private readonly runoutMarginS: number;
  private readonly noShowGraceMs: number;
  private readonly endingNoticeMs: number;

  constructor(
    private readonly repo: SessionsRepository,
    private readonly presence: PresenceService,
    private readonly pricing: PricingService,
    private readonly membership: MembershipService,
    private readonly subscriptions: SubscriptionsService,
    private readonly wallet: WalletService,
    private readonly commands: CommandsService,
    private readonly runoutTimer: RunoutTimerService,
    private readonly port: StationSessionPort,
    private readonly agents: AgentGateway,
    private readonly dashboard: DashboardGateway,
    config: ConfigService,
  ) {
    this.vault = new PinVault(config.get<string>('PIN_ENCRYPTION_KEY') ?? config.getOrThrow<string>('JWT_ACCESS_SECRET'));
    this.pinMaxAttempts = Number(config.get('SESSION_PIN_MAX_ATTEMPTS') ?? 5);
    this.leaseCapSeconds = Number(config.get('SESSION_LEASE_CAP_S') ?? 180);
    this.sweepIntervalMs = Number(config.get('SESSION_SWEEP_INTERVAL_MS') ?? 60_000);
    this.minPlayMinutes = Number(config.get('SESSION_MIN_PLAY_MINUTES') ?? 5);
    this.runoutMarginS = Number(config.get('SESSION_RUNOUT_MARGIN_S') ?? 30);
    this.noShowGraceMs = Number(config.get('NO_SHOW_GRACE_MINUTES') ?? 30) * 60_000;
    this.endingNoticeMs = Number(config.get('SESSION_ENDING_NOTICE_MINUTES') ?? 10) * 60_000;
  }

  onModuleInit(): void {
    this.subs.push(
      this.presence.statusChanges.subscribe((event) => void this.onStationStatus(event)),
      this.presence.sessionEnded.subscribe((event) => void this.onSessionEnded(event)),
      this.wallet.credited.subscribe((e) => void this.onWalletCredited(e.gamerProfileId)),
      this.wallet.debited.subscribe((e) => void this.onWalletDebited(e.gamerProfileId)),
    );
    this.wallet.setReserveProvider((gamerProfileId) => this.usedByRunningSessions(gamerProfileId));
    this.port.register(this);
    this.sweepTimer = setInterval(() => void this.sweep(), this.sweepIntervalMs);
    this.sweepTimer.unref();
  }

  onModuleDestroy(): void {
    for (const sub of this.subs) sub.unsubscribe();
    clearInterval(this.sweepTimer);
  }

  // --- PINs ----------------------------------------------------------------

  /**
   * Staff start: a fresh PIN for the booking, for the desk to hand the gamer
   * (e.g. one with no phone). Gamers get theirs with the booking.
   */
  async start(caller: AccessTokenPayload, reservationId: string) {
    const reservation = await this.repo.findReservationForStart(reservationId);
    if (!reservation) throw notFound('RESERVATION_NOT_FOUND', 'reservation not found');
    assertScope(caller, { branchId: reservation.machine.branchId });
    const { session, pin } = await this.issuePin(reservation, new Date(), false);
    return { ...toSessionDto(session as SessionRecord), pin };
  }

  /**
   * The gamer's PIN for their own booking: issued when the booking is made,
   * and on demand again (a new PIN replaces one nobody has typed yet, e.g.
   * after too many wrong tries). The caller has already resolved the profile.
   */
  async checkIn(gamerProfileId: string, reservationId: string) {
    const reservation = await this.repo.findReservationForStart(reservationId);
    if (!reservation || reservation.gamerProfileId !== gamerProfileId) {
      throw notFound('RESERVATION_NOT_FOUND', 'reservation not found');
    }
    const { session, pin } = await this.issuePin(reservation, new Date(), true);
    return { sessionId: session.id, reservationId, pin, pinExpiresAt: session.pinExpiresAt };
  }

  /**
   * Creates the booking's PENDING session with a fresh PIN: its hash for the
   * login check, and a sealed copy so the gamer's app can show it again. The
   * PIN works on this PC only, from the booking's start until the no-show
   * deadline (NO_SHOW_GRACE_MINUTES later); nothing is sent to the station,
   * which unlocks only after an accepted login. Serialized per station.
   * `replaceUnusedPin` lets a PIN nobody typed yet be replaced even while
   * it is still valid.
   */
  private async issuePin(reservation: StartableReservation, now: Date, replaceUnusedPin: boolean) {
    const reservationId = reservation.id;
    if (reservation.status !== 'CONFIRMED') {
      throw new ConflictException({ code: 'RESERVATION_NOT_CONFIRMED', error: 'reservation is not confirmed' });
    }
    const deadline = this.noShowDeadline(reservation);
    if (deadline <= now) {
      throw new ConflictException({ code: 'RESERVATION_EXPIRED', error: 'the booking is over, or passed its no-show deadline' });
    }

    const playStarts = new Date(Math.max(now.getTime(), reservation.startTime.getTime()));
    const rate = await this.computeRate(reservation.machine.branchId, reservation.gamerProfileId, reservation.isWalkIn, playStarts);
    const pin = generatePin();
    const pinHash = await hashPin(pin);

    const session = await this.repo.withMachineLock(reservation.machineId, async (tx) => {
      const open = await this.repo.findOpenForReservation(reservationId, tx);
      if (open) {
        // A PIN that expired or was burned unused can be replaced; anything else is a live session.
        if (!(replaceUnusedPin ? open.status === 'PENDING' && !open.pinUsedAt : this.isDeadPin(open, now))) {
          throw new ConflictException({ code: 'SESSION_ALREADY_STARTED', error: 'reservation already has an open session' });
        }
        await this.repo.cancelPending(open.id, tx);
      }
      return this.repo.create(
        {
          reservationId,
          appliedMembershipId: rate.membershipId,
          startTime: reservation.startTime,
          endTime: reservation.endTime,
          rateCentsPerMinute: rate.centsPerMinute,
          pinHash,
          pinCipher: this.vault.seal(pin),
          pinExpiresAt: deadline,
        },
        tx,
      );
    });

    return { session, pin };
  }

  /** The gamer's unused PINs by reservation, for the app to show on each booking. */
  async pinsForGamer(gamerProfileId: string): Promise<Map<string, { pin: string; validFrom: string; validUntil: string | null }>> {
    const pins = new Map<string, { pin: string; validFrom: string; validUntil: string | null }>();
    for (const row of await this.repo.findUnusedPinsForGamer(gamerProfileId)) {
      const pin = this.vault.open(row.pinCipher);
      if (pin) pins.set(row.reservationId, { pin, validFrom: row.startTime.toISOString(), validUntil: row.pinExpiresAt?.toISOString() ?? null });
    }
    return pins;
  }

  /** A booking nobody logged into by then is a NO_SHOW (never past its own end). */
  private noShowDeadline(reservation: { startTime: Date; endTime: Date }): Date {
    return new Date(Math.min(reservation.startTime.getTime() + this.noShowGraceMs, reservation.endTime.getTime()));
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
  private async usedByRunningSessions(gamerProfileId: string): Promise<number> {
    const now = new Date();
    const sessions = await this.repo.findGrantedByGamer(gamerProfileId);
    return sessions.reduce((sum, s) => sum + costAt(s as Meter, now), 0);
  }

  /** Free play always does; paid play needs the balance for the minimum play time (at least a minute). */
  private async coversMinimumPlay(gamerProfileId: string, centsPerMinute: number): Promise<boolean> {
    if (centsPerMinute <= 0) return true;
    const { balance } = await this.wallet.getWalletForGamer(gamerProfileId);
    const used = await this.usedByRunningSessions(gamerProfileId);
    return balance - used >= centsPerMinute * Math.max(this.minPlayMinutes, 1);
  }

  // --- extensions ----------------------------------------------------------

  /** The extensions the gamer can buy now: the PC must be free and the wallet cover it. */
  async extendOptions(gamerProfileId: string, reservationId: string) {
    const { session, now } = await this.extendable(gamerProfileId, reservationId);
    const [{ balance }, committed] = await Promise.all([
      this.wallet.getWalletForGamer(gamerProfileId),
      this.committedCents(gamerProfileId, now),
    ]);
    const options = [];
    for (const minutes of EXTEND_MINUTES) {
      const to = new Date(session.endTime.getTime() + minutes * 60_000);
      const quote = await this.quote(gamerProfileId, session.reservation.machine.branchId, true, session.endTime, minutes);
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
    const quote = await this.quote(gamerProfileId, session.reservation.machine.branchId, true, from, minutes);

    const [{ balance }, committed] = await Promise.all([
      this.wallet.getWalletForGamer(gamerProfileId),
      this.committedCents(gamerProfileId, now),
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
    await this.scheduleRunout(updated);
    await this.notify(updated, 'CLEAR');
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
    if (!session || !this.isGranted(session, now)) {
      throw new ConflictException({ code: 'SESSION_NOT_RUNNING', error: 'you can only extend a session that is running' });
    }
    return { session, now };
  }

  // --- lists ---------------------------------------------------------------

  /** Sessions for the desk: its branch (HQ: any, or every branch), with station, gamer and cost so far. */
  async list(caller: AccessTokenPayload, query: { branchId?: string; status?: string; from?: Date; limit: number }) {
    if (query.branchId) assertScope(caller, { branchId: query.branchId });
    const branchId = caller.scope === 'hq' ? (query.branchId ?? null) : caller.branchId;
    if (caller.scope !== 'hq' && !branchId) return [];
    const now = new Date();
    const rows = await this.repo.list({ branchId, status: query.status as Session['status'] | undefined, from: query.from, limit: query.limit });
    return rows.map((s) => ({
      ...toSessionDto(s as unknown as SessionRecord),
      station: s.reservation.machine,
      gamerUsername: s.reservation.gamerProfile.user.username,
      costSoFarCents: OPEN_SESSION_STATUSES.includes(s.status) ? costAt(s as Meter, now) : null,
    }));
  }

  /**
   * The gamer's own session now: station, rate, time played, cost so far,
   * balance, when it ends and why it is locked, or null when not playing.
   */
  async currentForGamer(userId: string) {
    const gamerProfileId = await this.repo.gamerProfileIdForUser(userId);
    if (!gamerProfileId) throw notFound('GAMER_PROFILE_NOT_FOUND', 'gamer profile not found');
    const session = await this.repo.findCurrentForGamer(gamerProfileId);
    if (!session) return null;
    const now = new Date();
    const meter = session as Meter;
    const { balance } = await this.wallet.getWalletForGamer(gamerProfileId);
    const played = session.meteredSeconds + (session.status === 'ACTIVE' && session.meteringStartedAt ? secondsBetween(session.meteringStartedAt, now) : 0);
    return {
      sessionId: session.id,
      reservationId: session.reservation.id,
      status: session.status,
      lockReason: session.lockReason,
      station: session.reservation.machine,
      startedAt: session.startTime.toISOString(),
      endsAt: session.endTime.toISOString(),
      rateCentsPerMinute: rateAt(meter, now),
      playedSeconds: played,
      costSoFarCents: costAt(meter, now),
      balance,
      balanceAfterCents: balance - costAt(meter, now),
    };
  }

  // --- staff ---------------------------------------------------------------

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
   * Staff close-out that does not wait for the station. Asks the station to
   * end the session (skipped if offline or it runs another one), then closes
   * at once from server state:
   * - ACTIVE/PAUSED (it played): settled, metered up to now -> COMPLETED.
   * - PENDING (never played): no metering, no debit -> CANCELLED / NO_SHOW.
   * A later presence sessionEnded finds the session closed and does nothing;
   * the debit key is shared, so it never bills twice.
   */
  async forceClose(caller: AccessTokenPayload, id: string, reason?: string) {
    const session = await this.repo.findByIdWithReservation(id);
    if (!session) throw notFound('SESSION_NOT_FOUND', 'session not found');
    assertScope(caller, { branchId: session.reservation.machine.branchId });
    if (!OPEN_SESSION_STATUSES.includes(session.status)) {
      throw new ConflictException({ code: 'SESSION_NOT_OPEN', error: 'session is already closed' });
    }
    try {
      await this.commands.issueSystemEndSession(session.reservation.machineId, reason ?? 'force_close', id);
    } catch (err) {
      // The station may be gone for good; settlement must not depend on it.
      this.logger.warn(`force-close END_SESSION for session ${id} failed: ${(err as Error).message}`);
    }
    // One retry covers a PENDING session that a login activated between the read and the close.
    for (let attempt = 0; attempt < 2; attempt++) {
      const current = await this.repo.findForSettlement(id);
      if (!current || !OPEN_SESSION_STATUSES.includes(current.status)) break;
      const closed =
        current.status === 'PENDING' && !current.pinUsedAt
          ? await this.repo.closeAsNoShow(current.id, current.reservationId, { unusedPinOnly: true })
          : await this.settle(current, new Date(), reason ?? 'force_close');
      if (closed) break;
    }
    await this.runoutTimer.cancel(id);
    const closed = await this.repo.findByIdWithReservation(id);
    return toSessionDto((closed ?? session) as SessionRecord);
  }

  /** A staff UNLOCK resumes the station's own open session; there is no unlocking without one. */
  async unlockFor(station: StationRef) {
    const now = new Date();
    const reported = this.presence.sessionOf(station.serialNumber);
    const sessions = (await this.repo.findGrantedOnMachine(station.machineId)).filter((s) => this.isGranted(s, now));
    const session = sessions.find((s) => s.id === reported) ?? sessions[sessions.length - 1];
    if (!session) {
      throw new ConflictException({
        code: 'NO_SESSION_TO_UNLOCK',
        error: 'this PC has no session to unlock: the gamer checks in with their PIN',
      });
    }
    if (session.lockReason === RUNOUT_LOCK && !(await this.coversMinimumPlay(session.reservation.gamerProfileId, rateAt(session as Meter, now)))) {
      throw insufficientFunds('the gamer ran out of money: top up their wallet first');
    }
    return { sessionId: session.id, ...this.leaseFor(session, now) };
  }

  /** Before a SHUTDOWN: the gamer stops playing now, so they pay until now. */
  async closeForShutdown(station: StationRef): Promise<void> {
    const now = new Date();
    for (const session of await this.repo.findGrantedOnMachine(station.machineId)) {
      await this.settle(session, now, 'shutdown');
    }
  }

  /**
   * A revoked or rejected PC: whatever runs on it is settled now, and its
   * bookings still ahead are cancelled (they can't be played there).
   */
  async retireMachine(machineId: string): Promise<void> {
    const now = new Date();
    for (const session of await this.repo.findGrantedOnMachine(machineId)) {
      await this.settle(session, now, 'station_revoked');
    }
    const cancelled = await this.repo.cancelFutureReservations(machineId, now);
    if (cancelled) this.logger.warn(`station ${machineId} retired: ${cancelled} booking(s) cancelled`);
  }

  // --- runout --------------------------------------------------------------

  /**
   * RUNOUT_LOCK_HANDLER seam for feat/runout-timer. Marks the session as
   * locked for funds (so a top-up can resume it) and requests the lock — the
   * PAUSED transition and metering close-out happen through onStationStatus
   * once presence reports the station actually locked, same as a staff LOCK.
   */
  async lockForRunout(sessionId: string): Promise<void> {
    const session = await this.repo.findByIdWithReservation(sessionId);
    if (!session || !OPEN_SESSION_STATUSES.includes(session.status)) return;
    await this.repo.update(session.id, { lockReason: RUNOUT_LOCK });
    await this.commands.issueSystemLock(session.reservation.machineId, RUNOUT_LOCK);
  }

  /** The runout warning: staff see it on the dashboard, the gamer on the station and in the portal. */
  async warnLowBalance(sessionId: string): Promise<void> {
    const session = await this.repo.findForSettlement(sessionId);
    if (!session || session.status !== 'ACTIVE') return;
    const machine = session.reservation;
    this.dashboard.publishToBranch(machine.machine.branchId, DASHBOARD_EVENTS.SESSION_RUNOUT_WARNING, {
      sessionId,
      machineId: machine.machineId,
    });
    await this.notify(session, 'LOW_BALANCE', await this.lockTime(session));
  }

  /** When this session's money runs out (lock margin included), or null for free play. */
  private async lockTime(session: SettlementSession): Promise<Date | null> {
    const now = new Date();
    const ms = await this.msUntilLock(session, now);
    return Number.isFinite(ms) ? new Date(now.getTime() + ms) : null;
  }

  private async msUntilLock(session: SettlementSession, now: Date): Promise<number> {
    const meter = session as Meter;
    const { balance } = await this.wallet.getWalletForGamer(session.reservation.gamerProfileId);
    // Other running sessions of the gamer's (rare) use the same wallet.
    const others = (await this.repo.findGrantedByGamer(session.reservation.gamerProfileId))
      .filter((s) => s.id !== session.id)
      .reduce((sum, s) => sum + exactCostAt(s as Meter, now), 0);
    const margin = (this.runoutMarginS / 60) * rateAt(meter, now);
    return msUntilSpent(meter, now, balance - others - exactCostAt(meter, now) - margin);
  }

  /** (Re)places the LOCK/WARN jobs from what the session has used and what the wallet holds. */
  private async scheduleRunout(session: SettlementSession): Promise<void> {
    if (session.status !== 'ACTIVE') return;
    const lockInMs = await this.msUntilLock(session, new Date());
    await this.runoutTimer.scheduleOrReschedule({
      sessionId: session.id,
      gamerProfileId: session.reservation.gamerProfileId,
      machineId: session.reservation.machineId,
      branchId: session.reservation.machine.branchId,
      serialNumber: session.reservation.machine.serialNumber,
      lockInMs,
    });
  }

  // --- station -------------------------------------------------------------

  /**
   * login_request from the station's lock screen. Checks the PIN of the
   * station's PENDING session whose booking has started: not expired, not
   * spent, within the attempt limit, and the wallet still covering the
   * minimum play time. Accepting spends the PIN, and closes any other session
   * still open on this PC (the previous booking has ended, so it can't resume
   * there any more). The gateway sends login_result and then the UNLOCK;
   * nothing is sent from here.
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
    // Money may have been spent since the booking: play starts only with enough for the minimum play time.
    if (!(await this.coversMinimumPlay(session.reservation.gamerProfileId, session.rateCentsPerMinute ?? 0))) {
      return rejected('insufficient_funds');
    }
    if (!(await this.repo.spendPin(session.id, now))) return rejected('pin_used');

    for (const other of await this.repo.findGrantedOnMachine(station.machineId)) {
      if (other.id !== session.id) await this.settle(other, other.lockedAt ?? now, 'replaced_by_login');
    }
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
   * A station that reports no session has dropped the ones we still think it
   * runs (it ended them while it, or we, were away): they are settled at the
   * last moment the station was known to be in use.
   */
  async reconcile(station: StationRef, report: StateReportPayload): Promise<void> {
    const now = new Date();
    if (!report.sessionId) {
      const lastSeen = this.presence.lastSeenBeforeConnect(station.serialNumber);
      for (const session of await this.repo.findGrantedOnMachine(station.machineId)) {
        const endedAt = session.lockedAt ?? lastSeen ?? now;
        this.logger.warn(`station ${station.serialNumber} no longer holds session ${session.id}; settling it at ${endedAt.toISOString()}`);
        await this.settle(session, endedAt, 'station_dropped');
      }
      return;
    }

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
    await this.commands.issueSystemEndSession(station.machineId, 'session_closed', report.sessionId);
  }

  private async onStationStatus(event: StationStatusEvent): Promise<void> {
    try {
      if (event.status === 'OFFLINE') {
        await this.pauseForOffline(event);
        return;
      }
      if (!event.sessionId) return;
      const found = await this.repo.findForSettlement(event.sessionId);
      if (!found || !OPEN_SESSION_STATUSES.includes(found.status)) return;
      const session = await this.foldRateSwitch(found, new Date());

      if (event.locked === false && session.status !== 'ACTIVE') {
        // The agent binds a session only from an UNLOCK, which only follows an accepted login.
        if (session.status === 'PENDING' && !session.pinUsedAt) return;
        const now = new Date();
        await this.repo.activate(session.id, session.reservationId, {
          status: 'ACTIVE',
          meteringStartedAt: now,
          lockedAt: null,
          lockReason: null,
        });
        await this.scheduleRunout({ ...session, status: 'ACTIVE', meteringStartedAt: now, lockedAt: null, lockReason: null });
      } else if (event.locked === true && session.status === 'ACTIVE') {
        await this.pause(session, new Date(), session.lockReason);
      }
    } catch (err) {
      this.logger.error(`station status handling failed for ${event.serialNumber}: ${(err as Error).message}`);
    }
  }

  /** The station went away: it locks itself when its lease runs out, so stop billing at its last heartbeat. */
  private async pauseForOffline(event: StationStatusEvent): Promise<void> {
    const station = this.presence.resolve(event.serialNumber);
    if (!station) return;
    const lastSeen = new Date(event.lastSeen);
    for (const found of await this.repo.findGrantedOnMachine(station.machineId)) {
      if (found.status !== 'ACTIVE') continue;
      const session = await this.foldRateSwitch(found, lastSeen);
      await this.pause(session, lastSeen, OFFLINE_LOCK);
      this.logger.log(`session ${session.id} paused: station ${event.serialNumber} offline since ${event.lastSeen}`);
    }
  }

  private async pause(session: SettlementSession, at: Date, lockReason: string | null): Promise<void> {
    const until = new Date(Math.min(at.getTime(), session.endTime.getTime()));
    const started = session.meteringStartedAt ?? until;
    const meteredSeconds = session.meteredSeconds + (until > started ? secondsBetween(started, until) : 0);
    await this.repo.update(session.id, { status: 'PAUSED', meteringStartedAt: null, meteredSeconds, lockedAt: at, lockReason });
    await this.runoutTimer.cancel(session.id);
  }

  private async onSessionEnded(event: SessionEndedEvent): Promise<void> {
    const session = await this.repo.findForSettlement(event.sessionId);
    if (!session || !OPEN_SESSION_STATUSES.includes(session.status)) return;
    await this.settle(session, new Date(event.endedAt), event.reason);
  }

  /**
   * A top-up moves the run-out time of a running session. A session the
   * runout timer locked is resumed once the balance covers the minimum play
   * time again: UNLOCK, and metering restarts when the station reports it.
   */
  private async onWalletCredited(gamerProfileId: string): Promise<void> {
    try {
      const session = await this.repo.findActiveByGamer(gamerProfileId);
      if (session) {
        await this.scheduleRunout(session);
        if (!this.runoutTimer.isWithinWarning(await this.msUntilLock(session, new Date()))) await this.notify(session, 'CLEAR');
        return;
      }

      const now = new Date();
      const paused = await this.repo.findPausedByGamer(gamerProfileId, RUNOUT_LOCK, now);
      if (!paused || !(await this.coversMinimumPlay(gamerProfileId, rateAt(paused as Meter, now)))) return;
      if (this.presence.sessionOf(paused.reservation.machine.serialNumber) !== paused.id) return; // the PC moved on
      await this.commands.issueSessionUnlock(paused.reservation.machineId, { sessionId: paused.id, ...this.leaseFor(paused, now) }, 'topup');
    } catch (err) {
      this.logger.error(`top-up handling failed for gamer ${gamerProfileId}: ${(err as Error).message}`);
    }
  }

  /** Spending (a plan, a desk debit) brings the run-out time closer. */
  private async onWalletDebited(gamerProfileId: string): Promise<void> {
    try {
      const session = await this.repo.findActiveByGamer(gamerProfileId);
      if (session) await this.scheduleRunout(session);
    } catch (err) {
      this.logger.error(`debit handling failed for gamer ${gamerProfileId}: ${(err as Error).message}`);
    }
  }

  // --- notices -------------------------------------------------------------

  /**
   * session_notice to the station (shown in a corner box) and to the gamer's
   * portal. `endsAt` is when the station locks: the run-out time for
   * LOW_BALANCE, the booking end for TIME_LEFT.
   */
  private async notify(session: SettlementSession, kind: 'LOW_BALANCE' | 'TIME_LEFT' | 'CLEAR', endsAt?: Date | null): Promise<void> {
    const payload = { sessionId: session.id, kind, endsAt: endsAt?.toISOString() ?? null, message: null };
    this.agents.sendControl(session.reservation.machine.serialNumber, SERVER_MESSAGE_TYPES.SESSION_NOTICE, payload);
    const userId = await this.repo.userIdForGamer(session.reservation.gamerProfileId);
    if (userId) {
      this.dashboard.publishToUser(userId, DASHBOARD_EVENTS.SESSION_NOTICE, { ...payload, reservationId: session.reservationId });
    }
  }

  // --- sweep ---------------------------------------------------------------

  /**
   * Every minute: folds due rate switches; closes reservations past their
   * window (a PENDING session nobody logged into is cancelled, any other open
   * session settled at its window end and ended on the station); marks
   * no-shows once the grace after their start has passed; and warns sessions
   * about to reach their end.
   */
  async sweep(): Promise<void> {
    try {
      const now = new Date();
      for (const session of await this.repo.findDueRateSwitches(now)) {
        await this.foldRateSwitch(session, now);
      }
      // No-shows: the PIN's deadline (NO_SHOW_GRACE_MINUTES after the start) passed unused: the station is free again.
      for (const expired of await this.repo.findExpiredUnusedPins(now)) {
        if (await this.repo.expireAsNoShow(expired.id, expired.reservationId)) {
          this.logger.log(`reservation ${expired.reservationId} NO_SHOW: PIN of session ${expired.id} unused by its deadline; station freed`);
        }
      }
      for (const session of await this.repo.findOverdueOpen(now)) {
        if (session.status === 'PENDING' && !session.pinUsedAt) {
          if (await this.repo.closeAsNoShow(session.id, session.reservationId, { unusedPinOnly: true })) {
            this.logger.log(`session ${session.id} cancelled, reservation NO_SHOW: window passed without a login`);
          }
        } else {
          await this.closeOverdue(session);
        }
      }
      // Bookings that never got a PIN (none is issued for them any more, but older rows exist).
      const noShows = await this.repo.markNoShows(now, this.noShowGraceMs);
      if (noShows) this.logger.log(`${noShows} reservation(s) marked NO_SHOW`);

      for (const session of await this.repo.findEndingSoon(now, new Date(now.getTime() + this.endingNoticeMs))) {
        await this.repo.update(session.id, { endingNoticeSentAt: now });
        await this.notify(session, 'TIME_LEFT', session.endTime);
      }
    } catch (err) {
      this.logger.error(`session sweep failed: ${(err as Error).message}`);
    }
  }

  /** Settles at the window end, and ends it on the station only if the station still runs this very session. */
  private async closeOverdue(session: SettlementSession): Promise<void> {
    await this.settle(session, session.endTime, 'reservation_ended');
    await this.commands.issueSystemEndSession(session.reservation.machineId, 'reservation_ended', session.id);
  }

  private async foldRateSwitch(session: SettlementSession, now: Date): Promise<SettlementSession> {
    const fold = foldDueRateSwitch(session as Meter, now);
    if (!fold) return session;
    await this.repo.update(session.id, fold);
    return { ...session, ...fold } as SettlementSession;
  }

  // --- helpers -------------------------------------------------------------

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

  /** The shorter of the remaining reservation window and the safety cap, re-granted on every heartbeat. */
  private leaseFor(session: Session, now: Date): StationLease {
    const windowSeconds = Math.floor((session.endTime.getTime() - now.getTime()) / 1000);
    return toLease(Math.min(windowSeconds, this.leaseCapSeconds), now);
  }

  /**
   * Closes the session and charges it. The runout lock (with its margin) and
   * the booking checks keep the bill within the wallet; the capped debit is
   * only a safety net, and a shortfall is logged as an error.
   */
  /** False if another path closed the session first; the shared debit key keeps a repeat from billing twice. */
  private async settle(found: SettlementSession, endedAt: Date, reason = 'normal'): Promise<boolean> {
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

  /**
   * Rates are per hour (Pricing convention): paygRate for Play now, bookingRate
   * for a booking made ahead. The better of the membership discount and a
   * pass window discount (at the time play starts) applies — they don't stack —
   * before converting to per minute.
   */
  private async computeRate(
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
}
