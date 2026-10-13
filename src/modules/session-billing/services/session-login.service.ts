import { ConflictException, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { assertScope } from '../../../common/utils/assert-scope.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import type { LoginDecision, StationLease } from '../../ops/services/station-session.port.js';
import type { StationRef } from '../../station/services/presence.service.js';
import { SessionsRepository } from '../repository/sessions.repository.js';
import { generatePin, hashPin, PinVault, verifyPin } from '../util/pin.js';
import { toSessionDto, type SessionRecord } from '../util/public-session.js';
import {
  isDeadPin,
  isGranted,
  isHeldLock,
  leaseFor,
  notFound,
  sessionConfig,
  toLease,
  type StartableReservation,
} from '../util/session-rules.js';

import { SessionMeteringService } from './session-metering.service.js';

/** The only login method the backend accepts from the lock screen. */
const PIN_METHOD = 'pin';

const rejected = (reason: string): LoginDecision => ({ accepted: false, reason });

/**
 * PINs, station login and leases. start()/checkIn() create a PENDING session
 * with a hashed, single-use PIN and send the station nothing. The gamer types
 * the PIN on the lock screen, the agent relays it as login_request, and
 * login() checks it here; the agent gateway answers login_result and only
 * then sends UNLOCK { sessionId, lease }.
 */
@Injectable()
export class SessionLoginService {
  private readonly pinMaxAttempts: number;
  private readonly vault: PinVault;
  private readonly leaseCapSeconds: number;
  private readonly noShowGraceMs: number;

  constructor(
    private readonly repo: SessionsRepository,
    private readonly metering: SessionMeteringService,
    config: ConfigService,
  ) {
    this.vault = new PinVault(config.get<string>('PIN_ENCRYPTION_KEY') ?? config.getOrThrow<string>('JWT_ACCESS_SECRET'));
    const settings = sessionConfig(config);
    this.pinMaxAttempts = settings.pinMaxAttempts;
    this.leaseCapSeconds = settings.leaseCapSeconds;
    this.noShowGraceMs = settings.noShowGraceMs;
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
    const rate = await this.metering.computeRate(reservation.gamerProfileId, reservation.isWalkIn, playStarts);
    const pin = generatePin();
    const pinHash = await hashPin(pin);

    const session = await this.repo.withMachineLock(reservation.machineId, async (tx) => {
      const open = await this.repo.findOpenForReservation(reservationId, tx);
      if (open) {
        // A PIN that expired or was burned unused can be replaced; anything else is a live session.
        if (!(replaceUnusedPin ? open.status === 'PENDING' && !open.pinUsedAt : isDeadPin(open, now, this.pinMaxAttempts))) {
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
          rateCoinsPerHour: rate.coinsPerHour,
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
    if (!(await this.metering.coversMinimumPlay(session.reservation.gamerProfileId, session.rateCoinsPerHour ?? 0))) {
      return rejected('insufficient_funds');
    }
    if (!(await this.repo.spendPin(session.id, now))) return rejected('pin_used');

    for (const other of await this.repo.findGrantedOnMachine(station.machineId)) {
      if (other.id !== session.id) await this.metering.settle(other, other.lockedAt ?? now, 'replaced_by_login');
    }
    return { accepted: true, sessionId: session.id, lease: leaseFor(session, now, this.leaseCapSeconds) };
  }

  /**
   * heartbeat_ack lease. Zero unless the station reports a session of its own
   * that was logged into and is still open and inside its window, and not
   * locked by staff or for funds: a station is never left unlocked without a
   * reason to be.
   */
  async lease(station: StationRef, sessionId: string | null): Promise<StationLease> {
    const now = new Date();
    if (!sessionId) return toLease(0, now);
    const session = await this.repo.findForSettlement(sessionId);
    if (!session || session.reservation.machineId !== station.machineId || !isGranted(session, now)) {
      return toLease(0, now);
    }
    if (session.status === 'PAUSED' && isHeldLock(session.lockReason)) return toLease(0, now);
    return leaseFor(session, now, this.leaseCapSeconds);
  }
}
