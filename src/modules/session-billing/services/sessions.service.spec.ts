import { ConflictException, NotFoundException } from '@nestjs/common';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { StationSessionPort } from '../../ops/services/station-session.port.js';
import { hashPin } from '../util/pin.js';
import { SessionsService } from './sessions.service.js';

function caller(overrides: Partial<AccessTokenPayload> = {}): AccessTokenPayload {
  return { sub: 'user-1', role: 'EMPLOYEE', scope: 'staff', branchId: 'b1', jti: 'j1', ...overrides };
}

const STATION = { machineId: 'm1', branchId: 'b1', serialNumber: 'SN-1' };
const HOUR = 60 * 60_000;
const LEASE_CAP_S = 180;
const MAX_ATTEMPTS = 3;

/** A reservation window that is open right now: started 10 minutes ago, ends in 50. */
function window() {
  const now = Date.now();
  return { startTime: new Date(now - 10 * 60_000), endTime: new Date(now + 50 * 60_000) };
}

function reservation(overrides: Record<string, unknown> = {}) {
  return {
    id: 'res-1', gamerProfileId: 'g1', machineId: 'm1', status: 'CONFIRMED', isWalkIn: true, ...window(),
    machine: { id: 'm1', branchId: 'b1', serialNumber: 'SN-1' },
    ...overrides,
  };
}

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1', reservationId: 'res-1', appliedMembershipId: null, status: 'PENDING',
    rateCentsPerMinute: 100, meteredSeconds: 0, meteringStartedAt: null, lockedAt: null,
    settledAt: null, billingBreakdown: null, createdAt: new Date(),
    pinHash: null, pinExpiresAt: null, pinUsedAt: null, pinAttempts: 0,
    accruedCents: 0, nextRateCentsPerMinute: null, rateSwitchAt: null, endingNoticeSentAt: null, lockReason: null,
    ...window(),
    reservation: { gamerProfileId: 'g1', machineId: 'm1', isWalkIn: true, machine: { id: 'm1', branchId: 'b1', serialNumber: 'SN-1' } },
    ...overrides,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('SessionsService', () => {
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let presence: Record<string, any>;
  let agents: { sendControl: ReturnType<typeof vi.fn> };
  let dashboard: { publishToBranch: ReturnType<typeof vi.fn>; publishToUser: ReturnType<typeof vi.fn> };
  let pricing: { getRatesForBranch: ReturnType<typeof vi.fn> };
  let membership: { getActiveDiscountForGamer: ReturnType<typeof vi.fn> };
  let subscriptions: { getWindowDiscountForGamer: ReturnType<typeof vi.fn> };
  let wallet: Record<string, any>;
  let commands: Record<string, ReturnType<typeof vi.fn>>;
  let runoutTimer: Record<string, ReturnType<typeof vi.fn>>;
  let port: StationSessionPort;
  let service: SessionsService;

  beforeEach(() => {
    repo = {
      findReservationForStart: vi.fn(async () => reservation()),
      findActiveForReservation: vi.fn(async () => null),
      create: vi.fn(async (data) => sessionRow(data)),
      cancelPending: vi.fn(async () => ({ count: 1 })),
      findById: vi.fn(async () => sessionRow({ status: 'PENDING', pinUsedAt: new Date() })),
      findForSettlement: vi.fn(async () => sessionRow({ status: 'ACTIVE', meteringStartedAt: new Date(Date.now() - 5 * 60_000) })),
      findByIdWithReservation: vi.fn(async () => sessionRow()),
      findLoginCandidate: vi.fn(async () => null),
      claimPinAttempt: vi.fn(async () => true),
      spendPin: vi.fn(async () => true),
      update: vi.fn(async (id, data) => sessionRow({ id, ...data })),
      findPausedByGamer: vi.fn(async () => null),
      findActiveByGamer: vi.fn(async () => null),
      activate: vi.fn(async () => undefined),
      complete: vi.fn(async () => undefined),
      findOverdueOpen: vi.fn(async () => []),
      markNoShows: vi.fn(async () => 0),
      findGrantedByGamer: vi.fn(async () => []),
      findGrantedOnMachine: vi.fn(async () => []),
      findUpcomingUnstarted: vi.fn(async () => []),
      userIdForGamer: vi.fn(async () => 'user-g1'),
      findDueRateSwitches: vi.fn(async () => []),
      findEndingSoon: vi.fn(async () => []),
      extendIfFree: vi.fn(async (input) => ({ kind: 'extended', session: sessionRow({ ...input.session, endTime: input.to }) })),
      isMachineBusy: vi.fn(async () => false),
    };
    presence = {
      statusChanges: new Subject(),
      sessionEnded: new Subject(),
      isOnline: vi.fn(() => true),
      resolve: vi.fn(() => STATION),
      sessionOf: vi.fn(() => 's1'),
      lastSeenBeforeConnect: vi.fn(() => null),
    };
    agents = { sendControl: vi.fn(() => true) };
    dashboard = { publishToBranch: vi.fn(), publishToUser: vi.fn() };
    pricing = { getRatesForBranch: vi.fn(async () => ({ paygRate: 6000, bookingRate: 9000 })) }; // 6000c/hr = 100c/min
    membership = { getActiveDiscountForGamer: vi.fn(async () => null) };
    subscriptions = { getWindowDiscountForGamer: vi.fn(async () => null) };
    wallet = {
      debitUpTo: vi.fn(async (_gamer: string, dto: { amount: number }) => dto.amount),
      getWalletForGamer: vi.fn(async () => ({ balance: 100_000 })),
      credited: new Subject(),
      debited: new Subject(),
      setReserveProvider: vi.fn(),
    };
    commands = {
      issue: vi.fn(async () => ({})),
      issueSystemLock: vi.fn(async () => undefined),
      issueSessionUnlock: vi.fn(async () => true),
      issueSystemEndSession: vi.fn(async () => true),
    };
    runoutTimer = {
      scheduleOrReschedule: vi.fn(async () => undefined),
      cancel: vi.fn(async () => undefined),
      isWithinWarning: vi.fn(() => false),
    };
    port = new StationSessionPort();
    const config = {
      get: (key: string) =>
        ({ SESSION_LEASE_CAP_S: LEASE_CAP_S, SESSION_PIN_MAX_ATTEMPTS: MAX_ATTEMPTS, SESSION_PIN_TTL_S: 900 })[key],
    };
    service = new SessionsService(
      repo as any, presence as any, pricing as any, membership as any, subscriptions as any, wallet as any, commands as any, runoutTimer as any, port,
      agents as any, dashboard as any, config as any,
    );
    service.onModuleInit();
  });

  afterEach(() => service.onModuleDestroy());

  describe('start', () => {
    it('creates a PENDING session with a PIN hash, returns the plaintext PIN once, and sends the station nothing', async () => {
      const result = await service.start(caller(), 'res-1');
      expect(result.pin).toMatch(/^\d{6}$/);

      const data = repo.create.mock.calls[0][0];
      expect(data).toMatchObject({ reservationId: 'res-1', rateCentsPerMinute: 100, appliedMembershipId: null });
      expect(data.pinHash).toMatch(/^\$argon2id\$/);
      expect(data.pinHash).not.toContain(result.pin);
      expect(JSON.stringify(result)).not.toContain(data.pinHash);

      for (const fn of Object.values(commands)) expect(fn).not.toHaveBeenCalled();
    });

    it('expires the PIN after the TTL, never past the reservation window', async () => {
      await service.start(caller(), 'res-1');
      const ttlBound = repo.create.mock.calls[0][0].pinExpiresAt.getTime();
      expect(ttlBound).toBeGreaterThan(Date.now() + 14 * 60_000);
      expect(ttlBound).toBeLessThanOrEqual(Date.now() + 15 * 60_000);

      const endTime = new Date(Date.now() + 5 * 60_000);
      repo.findReservationForStart.mockResolvedValueOnce(reservation({ endTime }));
      await service.start(caller(), 'res-1');
      expect(repo.create.mock.calls[1][0].pinExpiresAt).toEqual(endTime);
    });

    it('applies the active membership discount to the rate', async () => {
      membership.getActiveDiscountForGamer.mockResolvedValueOnce({ membershipId: 'ms1', discountPercent: 10 });
      await service.start(caller(), 'res-1');
      // 6000c/hr * 0.9 = 5400c/hr = 90c/min
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ rateCentsPerMinute: 90, appliedMembershipId: 'ms1' }));
    });

    it('404s for a missing reservation, and rejects a cross-branch caller', async () => {
      repo.findReservationForStart.mockResolvedValueOnce(null);
      await expect(service.start(caller(), 'res-1')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.start(caller({ branchId: 'other' }), 'res-1')).rejects.toThrow();
    });

    it('409s a reservation that is not CONFIRMED, already over, or whose station is offline', async () => {
      repo.findReservationForStart.mockResolvedValueOnce(reservation({ status: 'PENDING' }));
      await expect(service.start(caller(), 'res-1')).rejects.toMatchObject({ response: { code: 'RESERVATION_NOT_CONFIRMED' } });

      repo.findReservationForStart.mockResolvedValueOnce(reservation({ endTime: new Date(Date.now() - 1000) }));
      await expect(service.start(caller(), 'res-1')).rejects.toMatchObject({ response: { code: 'RESERVATION_EXPIRED' } });

      presence.isOnline.mockReturnValueOnce(false);
      await expect(service.start(caller(), 'res-1')).rejects.toMatchObject({ response: { code: 'STATION_OFFLINE' } });
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('starts from a CONFIRMED walk-in (window starting now) just like a booking', async () => {
      const now = Date.now();
      repo.findReservationForStart.mockResolvedValueOnce(
        reservation({ startTime: new Date(now), endTime: new Date(now + 30 * 60_000) }),
      );
      const result = await service.start(caller(), 'res-1');
      expect(result).toMatchObject({ status: 'PENDING', pin: expect.stringMatching(/^\d{6}$/) });
    });

    it.each(['ACTIVE', 'CANCELLED', 'COMPLETED', 'NO_SHOW', 'PENDING'])('refuses to start a %s reservation', async (status) => {
      repo.findReservationForStart.mockResolvedValueOnce(reservation({ status }));
      await expect(service.start(caller(), 'res-1')).rejects.toMatchObject({ response: { code: 'RESERVATION_NOT_CONFIRMED' } });
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('rejects a reservation with a live open session', async () => {
      repo.findActiveForReservation.mockResolvedValueOnce(sessionRow({ pinExpiresAt: new Date(Date.now() + 60_000) }));
      await expect(service.start(caller(), 'res-1')).rejects.toBeInstanceOf(ConflictException);
      repo.findActiveForReservation.mockResolvedValueOnce(sessionRow({ status: 'ACTIVE' }));
      await expect(service.start(caller(), 'res-1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('replaces a PENDING session whose PIN expired unused', async () => {
      repo.findActiveForReservation.mockResolvedValueOnce(sessionRow({ id: 'old', pinExpiresAt: new Date(Date.now() - 1000) }));
      await service.start(caller(), 'res-1');
      expect(repo.cancelPending).toHaveBeenCalledWith('old');
      expect(repo.create).toHaveBeenCalled();
    });
  });

  describe('checkIn (the gamer gets the PIN)', () => {
    it('hands the gamer the PIN of a fresh PENDING session for their own booking', async () => {
      const result = await service.checkIn('g1', 'res-1');
      expect(result).toMatchObject({ sessionId: 's1', reservationId: 'res-1', pin: expect.stringMatching(/^\d{6}$/) });
      expect(result.pinExpiresAt).toBeInstanceOf(Date);
      expect(repo.create.mock.calls[0][0].pinHash).not.toContain(result.pin);
      for (const fn of Object.values(commands)) expect(fn).not.toHaveBeenCalled();
    });

    it("404s another gamer's booking", async () => {
      await expect(service.checkIn('someone-else', 'res-1')).rejects.toBeInstanceOf(NotFoundException);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('opens 15 minutes before the booking', async () => {
      const now = Date.now();
      repo.findReservationForStart.mockResolvedValueOnce(reservation({ startTime: new Date(now + 20 * 60_000), endTime: new Date(now + HOUR) }));
      await expect(service.checkIn('g1', 'res-1')).rejects.toMatchObject({ response: { code: 'RESERVATION_NOT_STARTED' } });

      repo.findReservationForStart.mockResolvedValueOnce(reservation({ startTime: new Date(now + 10 * 60_000), endTime: new Date(now + HOUR) }));
      await expect(service.checkIn('g1', 'res-1')).resolves.toMatchObject({ pin: expect.any(String) });
    });

    it('replaces a still-valid PIN nobody typed, but not a session already logged into', async () => {
      repo.findActiveForReservation.mockResolvedValueOnce(sessionRow({ id: 'old', pinExpiresAt: new Date(Date.now() + 60_000) }));
      await service.checkIn('g1', 'res-1');
      expect(repo.cancelPending).toHaveBeenCalledWith('old');

      repo.findActiveForReservation.mockResolvedValueOnce(sessionRow({ pinUsedAt: new Date() }));
      await expect(service.checkIn('g1', 'res-1')).rejects.toMatchObject({ response: { code: 'SESSION_ALREADY_STARTED' } });
    });
  });

  describe('login', () => {
    let pin: string;

    beforeEach(async () => {
      pin = '482193';
      repo.findLoginCandidate.mockResolvedValue(
        sessionRow({ pinHash: await hashPin(pin), pinExpiresAt: new Date(Date.now() + 10 * 60_000) }),
      );
    });

    it('accepts the right PIN, spends it, and grants a lease capped by the safety cap', async () => {
      const decision = await service.login(STATION, 'pin', pin);
      expect(decision).toMatchObject({ accepted: true, sessionId: 's1', lease: { leaseSeconds: LEASE_CAP_S } });
      expect(repo.findLoginCandidate).toHaveBeenCalledWith('m1', expect.any(Date));
      expect(repo.claimPinAttempt).toHaveBeenCalledWith('s1', MAX_ATTEMPTS);
      expect(repo.spendPin).toHaveBeenCalledWith('s1', expect.any(Date));
      // login() decides only; the gateway sends login_result and then the UNLOCK.
      expect(commands.issueSessionUnlock).not.toHaveBeenCalled();
    });

    it('grants only the rest of the reservation window when that is shorter than the cap', async () => {
      repo.findLoginCandidate.mockResolvedValueOnce(
        sessionRow({ pinHash: await hashPin(pin), pinExpiresAt: new Date(Date.now() + 60_000), endTime: new Date(Date.now() + 60_000) }),
      );
      const decision = await service.login(STATION, 'pin', pin);
      expect(decision.accepted && decision.lease.leaseSeconds).toBeGreaterThanOrEqual(59);
      expect(decision.accepted && decision.lease.leaseSeconds).toBeLessThanOrEqual(60);
    });

    it('rejects a wrong PIN without spending it', async () => {
      expect(await service.login(STATION, 'pin', '000000')).toEqual({ accepted: false, reason: 'invalid_pin' });
      expect(repo.spendPin).not.toHaveBeenCalled();
    });

    it('rejects an expired PIN before taking an attempt', async () => {
      repo.findLoginCandidate.mockResolvedValueOnce(
        sessionRow({ pinHash: await hashPin(pin), pinExpiresAt: new Date(Date.now() - 1000) }),
      );
      expect(await service.login(STATION, 'pin', pin)).toEqual({ accepted: false, reason: 'pin_expired' });
      expect(repo.claimPinAttempt).not.toHaveBeenCalled();
    });

    it('rejects a PIN that already opened the session', async () => {
      repo.findLoginCandidate.mockResolvedValueOnce(sessionRow({ pinHash: null, pinUsedAt: new Date() }));
      expect(await service.login(STATION, 'pin', pin)).toEqual({ accepted: false, reason: 'pin_used' });
      // Lost the race to a parallel login that spent it first.
      repo.spendPin.mockResolvedValueOnce(false);
      expect(await service.login(STATION, 'pin', pin)).toEqual({ accepted: false, reason: 'pin_used' });
    });

    it('stops checking the PIN once the attempt guard is hit, even for the right PIN', async () => {
      repo.claimPinAttempt.mockResolvedValue(false);
      repo.findLoginCandidate.mockResolvedValue(
        sessionRow({ pinHash: await hashPin(pin), pinExpiresAt: new Date(Date.now() + 60_000), pinAttempts: MAX_ATTEMPTS }),
      );
      expect(await service.login(STATION, 'pin', pin)).toEqual({ accepted: false, reason: 'too_many_attempts' });
      expect(repo.spendPin).not.toHaveBeenCalled();
    });

    it('rejects when the station has no PENDING session, or for a non-PIN method', async () => {
      repo.findLoginCandidate.mockResolvedValueOnce(null);
      expect(await service.login(STATION, 'pin', pin)).toEqual({ accepted: false, reason: 'no_pending_session' });
      expect(await service.login(STATION, 'card', pin)).toEqual({ accepted: false, reason: 'unsupported_method' });
    });

    it('registers itself as the gateway login handler', () => {
      expect(port.current).toBe(service);
    });
  });

  describe('lease', () => {
    it('is the shorter of the remaining window and the cap for a logged-in session on this station', async () => {
      expect((await service.lease(STATION, 's1')).leaseSeconds).toBe(LEASE_CAP_S);

      repo.findForSettlement.mockResolvedValueOnce(sessionRow({ status: 'ACTIVE', endTime: new Date(Date.now() + 30_000) }));
      const short = await service.lease(STATION, 's1');
      expect(short.leaseSeconds).toBeGreaterThanOrEqual(29);
      expect(short.leaseSeconds).toBeLessThanOrEqual(30);
      expect(Number.isNaN(Date.parse(short.serverTime))).toBe(false);
    });

    it('is zero with no session, a closed or expired session, a never-logged-in session, or another station\'s session', async () => {
      expect((await service.lease(STATION, null)).leaseSeconds).toBe(0);
      repo.findForSettlement.mockResolvedValueOnce(sessionRow({ status: 'COMPLETED' }));
      expect((await service.lease(STATION, 's1')).leaseSeconds).toBe(0);
      repo.findForSettlement.mockResolvedValueOnce(sessionRow({ status: 'ACTIVE', endTime: new Date(Date.now() - 1000) }));
      expect((await service.lease(STATION, 's1')).leaseSeconds).toBe(0);
      repo.findForSettlement.mockResolvedValueOnce(sessionRow({ status: 'PENDING', pinUsedAt: null }));
      expect((await service.lease(STATION, 's1')).leaseSeconds).toBe(0);
      repo.findForSettlement.mockResolvedValueOnce(sessionRow({ status: 'ACTIVE', reservation: { gamerProfileId: 'g1', machineId: 'other' } }));
      expect((await service.lease(STATION, 's1')).leaseSeconds).toBe(0);
    });
  });

  describe('reconcile (state_report on reconnect)', () => {
    it('re-grants an open in-window session with a fresh UNLOCK and lease', async () => {
      await service.reconcile(STATION, { locked: true, sessionId: 's1' });
      expect(commands.issueSessionUnlock).toHaveBeenCalledWith(
        'm1',
        { sessionId: 's1', leaseSeconds: LEASE_CAP_S, serverTime: expect.any(String) },
        'resume',
      );
      expect(commands.issueSystemEndSession).not.toHaveBeenCalled();
      // Resuming is not activating: that waits for presence to see locked=false.
      expect(repo.activate).not.toHaveBeenCalled();
    });

    it('settles a session whose window ended meanwhile, metered to the window end, and ends it on the station', async () => {
      const endTime = new Date(Date.now() - 60_000);
      repo.findForSettlement.mockResolvedValueOnce(
        sessionRow({ status: 'ACTIVE', meteringStartedAt: new Date(endTime.getTime() - 10 * 60_000), endTime }),
      );
      await service.reconcile(STATION, { locked: false, sessionId: 's1' });
      expect(wallet.debitUpTo).toHaveBeenCalledWith('g1', expect.objectContaining({ amount: 1000, sessionId: 's1' }));
      expect(repo.complete).toHaveBeenCalledWith('s1', 'res-1', expect.objectContaining({ status: 'COMPLETED', meteredSeconds: 600 }));
      expect(commands.issueSystemEndSession).toHaveBeenCalledWith('m1', 'reservation_ended', 's1');
      expect(commands.issueSessionUnlock).not.toHaveBeenCalled();
    });

    it('ends a session that is already closed without settling it again', async () => {
      repo.findForSettlement.mockResolvedValueOnce(sessionRow({ status: 'COMPLETED' }));
      await service.reconcile(STATION, { locked: false, sessionId: 's1' });
      expect(commands.issueSystemEndSession).toHaveBeenCalledWith('m1', 'session_closed', 's1');
      expect(wallet.debitUpTo).not.toHaveBeenCalled();
      expect(commands.issueSessionUnlock).not.toHaveBeenCalled();
    });

    it('does nothing for a report without a session', async () => {
      await service.reconcile(STATION, { locked: true, sessionId: null });
      expect(repo.findForSettlement).not.toHaveBeenCalled();
    });
  });

  describe('metering and reservation lifecycle', () => {
    it('goes ACTIVE, and moves the reservation CONFIRMED -> ACTIVE, once presence reports the station unlocked', async () => {
      repo.findForSettlement = vi.fn(async () => sessionRow({ status: 'PENDING', pinUsedAt: new Date() }));
      presence.statusChanges.next({ sessionId: 's1', locked: false, branchId: 'b1' });
      await flush();
      expect(repo.activate).toHaveBeenCalledWith('s1', 'res-1', expect.objectContaining({ status: 'ACTIVE', lockedAt: null }));
    });

    it('does not activate a PENDING session nobody logged into', async () => {
      repo.findById.mockResolvedValueOnce(sessionRow({ status: 'PENDING', pinUsedAt: null }));
      presence.statusChanges.next({ sessionId: 's1', locked: false, branchId: 'b1' });
      await flush();
      expect(repo.activate).not.toHaveBeenCalled();
    });

    it('accumulates metered seconds and goes PAUSED when presence reports the station locked mid-session', async () => {
      const startedAt = new Date(Date.now() - 90_000); // 90s ago
      repo.findById.mockResolvedValueOnce(sessionRow({ status: 'ACTIVE', meteringStartedAt: startedAt }));
      presence.statusChanges.next({ sessionId: 's1', locked: true, branchId: 'b1' });
      await flush();
      const call = repo.update.mock.calls[0];
      expect(call[1]).toMatchObject({ status: 'PAUSED', meteringStartedAt: null, lockedAt: expect.any(Date) });
      expect(call[1].meteredSeconds).toBeGreaterThanOrEqual(89);
    });

    it('ignores station-status events with no session, or for a session already closed', async () => {
      presence.statusChanges.next({ sessionId: null, locked: false });
      repo.findById.mockResolvedValueOnce(sessionRow({ status: 'COMPLETED' }));
      presence.statusChanges.next({ sessionId: 's1', locked: false });
      await flush();
      expect(repo.update).not.toHaveBeenCalled();
      expect(repo.activate).not.toHaveBeenCalled();
    });

    it('settles on session end, moving the reservation to COMPLETED', async () => {
      presence.sessionEnded.next({ sessionId: 's1', endedAt: new Date().toISOString() });
      await flush();
      // 5 minutes active at 100c/min = 500c
      expect(wallet.debitUpTo).toHaveBeenCalledWith('g1', expect.objectContaining({ amount: 500, sessionId: 's1' }));
      expect(repo.complete).toHaveBeenCalledWith('s1', 'res-1', expect.objectContaining({ status: 'COMPLETED', meteredSeconds: 300 }));
    });

    it('still completes the session, flagged, when the settlement debit fails', async () => {
      wallet.debitUpTo.mockRejectedValueOnce(new ConflictException());
      presence.sessionEnded.next({ sessionId: 's1', endedAt: new Date().toISOString() });
      await flush();
      expect(repo.complete).toHaveBeenCalledWith(
        's1',
        'res-1',
        expect.objectContaining({ status: 'COMPLETED', billingBreakdown: expect.objectContaining({ debitFailed: true }) }),
      );
    });

    it('skips settlement for a session that is already closed', async () => {
      repo.findForSettlement.mockResolvedValueOnce(sessionRow({ status: 'COMPLETED' }));
      presence.sessionEnded.next({ sessionId: 's1', endedAt: new Date().toISOString() });
      await flush();
      expect(wallet.debitUpTo).not.toHaveBeenCalled();
    });

    it('sweep: cancels a never-logged-in session past its window and marks no-shows', async () => {
      const past = { startTime: new Date(Date.now() - 2 * HOUR), endTime: new Date(Date.now() - HOUR) };
      repo.findOverdueOpen.mockResolvedValueOnce([sessionRow({ id: 'p1', status: 'PENDING', pinUsedAt: null, ...past })]);
      repo.markNoShows.mockResolvedValueOnce(1);
      await service.sweep();
      expect(repo.cancelPending).toHaveBeenCalledWith('p1');
      expect(repo.markNoShows).toHaveBeenCalledWith(expect.any(Date), 15 * 60_000);
      expect(wallet.debitUpTo).not.toHaveBeenCalled();
      expect(commands.issueSystemEndSession).not.toHaveBeenCalled();
    });

    it('sweep: settles an open session past its window and ends it on the station', async () => {
      const endTime = new Date(Date.now() - 60_000);
      repo.findOverdueOpen.mockResolvedValueOnce([
        sessionRow({ status: 'PAUSED', meteredSeconds: 120, endTime, startTime: new Date(endTime.getTime() - HOUR) }),
      ]);
      await service.sweep();
      expect(repo.complete).toHaveBeenCalledWith('s1', 'res-1', expect.objectContaining({ status: 'COMPLETED', meteredSeconds: 120 }));
      expect(commands.issueSystemEndSession).toHaveBeenCalledWith('m1', 'reservation_ended', 's1');
      expect(repo.cancelPending).not.toHaveBeenCalled();
    });
  });

  it("lockForRunout marks the session locked for funds and issues a system LOCK for its station", async () => {
    await service.lockForRunout('s1');
    expect(repo.update).toHaveBeenCalledWith('s1', { lockReason: 'runout' });
    expect(commands.issueSystemLock).toHaveBeenCalledWith('m1', 'runout');
  });

  describe('pricing, funds and run-out', () => {
    it('bills a booking made ahead at the booking rate, Play now at the walk-in rate', async () => {
      repo.findReservationForStart.mockResolvedValueOnce(reservation({ isWalkIn: false }));
      await service.start(caller(), 'res-1');
      expect(repo.create.mock.calls[0][0].rateCentsPerMinute).toBe(150); // 9000/hr booking rate
    });

    it('applies the better of the membership and pass discounts, without stacking them', async () => {
      membership.getActiveDiscountForGamer.mockResolvedValue({ membershipId: 'ms1', discountPercent: 10 });
      subscriptions.getWindowDiscountForGamer.mockResolvedValueOnce({ subscriptionId: 'sub1', discountPercent: 100 });
      await service.start(caller(), 'res-1');
      expect(repo.create.mock.calls[0][0]).toMatchObject({ rateCentsPerMinute: 0, appliedMembershipId: null });

      subscriptions.getWindowDiscountForGamer.mockResolvedValueOnce({ subscriptionId: 'sub1', discountPercent: 5 });
      repo.findActiveForReservation.mockResolvedValueOnce(sessionRow({ id: 'old', pinExpiresAt: new Date(Date.now() - 1000) }));
      await service.start(caller(), 'res-1');
      expect(repo.create.mock.calls[1][0]).toMatchObject({ rateCentsPerMinute: 90, appliedMembershipId: 'ms1' });
    });

    it('refuses a PIN without the balance for the minimum play time, keeping any PIN already issued', async () => {
      wallet.getWalletForGamer.mockResolvedValue({ balance: 499 }); // 5 min at 100/min = 500
      repo.findActiveForReservation.mockResolvedValueOnce(sessionRow({ id: 'old', pinExpiresAt: new Date(Date.now() + 60_000) }));
      await expect(service.checkIn('g1', 'res-1')).rejects.toMatchObject({ response: { code: 'INSUFFICIENT_FUNDS' } });
      expect(repo.cancelPending).not.toHaveBeenCalled();
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('lets free play start with an empty wallet', async () => {
      wallet.getWalletForGamer.mockResolvedValue({ balance: 0 });
      subscriptions.getWindowDiscountForGamer.mockResolvedValueOnce({ subscriptionId: 'sub1', discountPercent: 100 });
      await expect(service.checkIn('g1', 'res-1')).resolves.toMatchObject({ pin: expect.any(String) });
    });

    it('never issues a PIN earlier than 15 minutes before the booking, from the desk either', async () => {
      const now = Date.now();
      repo.findReservationForStart.mockResolvedValueOnce(reservation({ startTime: new Date(now + 2 * HOUR), endTime: new Date(now + 3 * HOUR) }));
      await expect(service.start(caller(), 'res-1')).rejects.toMatchObject({ response: { code: 'RESERVATION_NOT_STARTED' } });
    });

    it('charges what the wallet holds when the bill is bigger, and records the shortfall', async () => {
      wallet.debitUpTo.mockResolvedValueOnce(320);
      presence.sessionEnded.next({ sessionId: 's1', endedAt: new Date().toISOString() });
      await vi.waitFor(() => expect(repo.complete).toHaveBeenCalled());
      expect(repo.complete.mock.calls[0][2].billingBreakdown).toMatchObject({ totalCents: 500, chargedCents: 320, shortfallCents: 180 });
    });

    it('resumes a session locked for funds once a top-up covers the minimum play time', async () => {
      repo.findPausedByGamer.mockResolvedValue(sessionRow({ status: 'PAUSED', lockReason: 'runout', pinUsedAt: new Date() }));
      wallet.credited.next({ gamerProfileId: 'g1' });
      await vi.waitFor(() => expect(commands.issueSessionUnlock).toHaveBeenCalled());
      expect(repo.findPausedByGamer).toHaveBeenCalledWith('g1', 'runout', expect.any(Date));
      expect(commands.issueSessionUnlock).toHaveBeenCalledWith('m1', expect.objectContaining({ sessionId: 's1' }), 'topup');
    });

    it('keeps a session locked for funds locked when the top-up is still too small', async () => {
      wallet.getWalletForGamer.mockResolvedValue({ balance: 100 });
      repo.findPausedByGamer.mockResolvedValue(sessionRow({ status: 'PAUSED', lockReason: 'runout' }));
      wallet.credited.next({ gamerProfileId: 'g1' });
      await vi.waitFor(() => expect(wallet.getWalletForGamer).toHaveBeenCalled());
      await flush();
      expect(commands.issueSessionUnlock).not.toHaveBeenCalled();
    });

    it('clears the lock reason when the session runs again', async () => {
      repo.findForSettlement.mockResolvedValueOnce(sessionRow({ status: 'PAUSED', lockReason: 'runout', pinUsedAt: new Date() }));
      presence.statusChanges.next({ sessionId: 's1', locked: false, branchId: 'b1' });
      await vi.waitFor(() => expect(repo.activate).toHaveBeenCalled());
      expect(repo.activate.mock.calls[0][2]).toMatchObject({ status: 'ACTIVE', lockReason: null });
    });
  });

  it('lockForRunout is a no-op for a session that is already closed', async () => {
    repo.findByIdWithReservation.mockResolvedValueOnce(sessionRow({ status: 'COMPLETED' }));
    await service.lockForRunout('s1');
    expect(commands.issueSystemLock).not.toHaveBeenCalled();
  });

  it('end() forwards to CommandsService as END_SESSION', async () => {
    await service.end(caller(), 's1', 'closing');
    expect(commands.issue).toHaveBeenCalledWith(caller(), 'm1', { type: 'END_SESSION', reason: 'closing' });
  });

  it('end() rejects a session that is already closed', async () => {
    repo.findByIdWithReservation.mockResolvedValueOnce(sessionRow({ status: 'COMPLETED' }));
    await expect(service.end(caller(), 's1')).rejects.toBeInstanceOf(ConflictException);
  });

  describe('money never runs short', () => {
    const running = (overrides: Record<string, unknown> = {}) =>
      sessionRow({ status: 'ACTIVE', pinUsedAt: new Date(), meteringStartedAt: new Date(), ...overrides });

    it('locks when the balance minus what the session already used (and a margin) is spent', async () => {
      // Resumed after 10 min already played (1000) with 100 000 in the wallet, margin 30 s = 50.
      repo.findForSettlement.mockResolvedValueOnce(sessionRow({ status: 'PAUSED', pinUsedAt: new Date(), meteredSeconds: 600 }));
      repo.findGrantedByGamer.mockResolvedValue([]);
      presence.statusChanges.next({ ...STATION, status: 'ONLINE', sessionId: 's1', locked: false, branchId: 'b1' });
      await vi.waitFor(() => expect(runoutTimer.scheduleOrReschedule).toHaveBeenCalled());
      const { lockInMs } = runoutTimer.scheduleOrReschedule.mock.calls[0][0];
      expect(Math.round(lockInMs / 1000)).toBe(Math.round(((100_000 - 1000 - 50) / 100) * 60));
    });

    it('holds what running sessions used against other spending, and reschedules on a debit', async () => {
      const provider = wallet.setReserveProvider.mock.calls[0][0];
      repo.findGrantedByGamer.mockResolvedValueOnce([running({ meteringStartedAt: new Date(Date.now() - 10 * 60_000) })]);
      expect(await provider('g1')).toBe(1000);

      repo.findActiveByGamer.mockResolvedValueOnce(running());
      wallet.debited.next({ gamerProfileId: 'g1', amount: 500, balanceAfter: 99_500 });
      await vi.waitFor(() => expect(runoutTimer.scheduleOrReschedule).toHaveBeenCalled());
    });

    it('refuses a booking the wallet cannot pay once other bookings and running sessions are set aside', async () => {
      wallet.getWalletForGamer.mockResolvedValue({ balance: 10_000 });
      // An upcoming 60 min booking at the booking rate (150/min) = 9000 promised.
      const start = new Date(Date.now() + HOUR);
      repo.findUpcomingUnstarted.mockResolvedValue([
        { id: 'r9', startTime: start, endTime: new Date(start.getTime() + HOUR), isWalkIn: false, machine: { branchId: 'b1' } },
      ]);
      await expect(
        service.assertAffordable({ gamerProfileId: 'g1', branchId: 'b1', isWalkIn: true, start: new Date(), minutes: 30 }),
      ).rejects.toMatchObject({ response: { code: 'INSUFFICIENT_FUNDS' } });
      await expect(
        service.assertAffordable({ gamerProfileId: 'g1', branchId: 'b1', isWalkIn: true, start: new Date(), minutes: 10 }),
      ).resolves.toMatchObject({ totalCents: 1000 });
    });
  });

  describe('stations', () => {
    it('stops billing at the last heartbeat when a station goes offline', async () => {
      const lastSeen = new Date(Date.now() - 2 * 60_000);
      repo.findGrantedOnMachine.mockResolvedValueOnce([
        sessionRow({ status: 'ACTIVE', pinUsedAt: new Date(), meteringStartedAt: new Date(lastSeen.getTime() - 5 * 60_000) }),
      ]);
      presence.statusChanges.next({ ...STATION, status: 'OFFLINE', lastSeen: lastSeen.toISOString(), sessionId: 's1', locked: false });
      await vi.waitFor(() => expect(repo.update).toHaveBeenCalled());
      expect(repo.update).toHaveBeenCalledWith('s1', expect.objectContaining({ status: 'PAUSED', meteredSeconds: 300, lockedAt: lastSeen, lockReason: 'offline' }));
      expect(runoutTimer.cancel).toHaveBeenCalledWith('s1');
    });

    it('settles a session the station dropped while away, at the last moment it was seen', async () => {
      const lastSeen = new Date(Date.now() - 20 * 60_000);
      presence.lastSeenBeforeConnect.mockReturnValue(lastSeen);
      repo.findGrantedOnMachine.mockResolvedValueOnce([
        sessionRow({ status: 'ACTIVE', pinUsedAt: new Date(), meteringStartedAt: new Date(lastSeen.getTime() - 10 * 60_000) }),
      ]);
      await service.reconcile(STATION, { locked: true, sessionId: null });
      expect(wallet.debitUpTo).toHaveBeenCalledWith('g1', expect.objectContaining({ amount: 1000 }));
      expect(repo.complete).toHaveBeenCalledWith('s1', 'res-1', expect.objectContaining({ settledAt: lastSeen }));
    });

    it('settles the session before a shutdown', async () => {
      repo.findGrantedOnMachine.mockResolvedValueOnce([sessionRow({ status: 'PAUSED', pinUsedAt: new Date(), meteredSeconds: 60 })]);
      await service.closeForShutdown(STATION);
      expect(repo.complete).toHaveBeenCalledWith('s1', 'res-1', expect.objectContaining({ status: 'COMPLETED' }));
    });

    it('unlocks for staff only into the station’s own session', async () => {
      await expect(service.unlockFor(STATION)).rejects.toMatchObject({ response: { code: 'NO_SESSION_TO_UNLOCK' } });
      repo.findGrantedOnMachine.mockResolvedValueOnce([sessionRow({ status: 'PAUSED', pinUsedAt: new Date() })]);
      await expect(service.unlockFor(STATION)).resolves.toMatchObject({ sessionId: 's1', leaseSeconds: LEASE_CAP_S });

      wallet.getWalletForGamer.mockResolvedValue({ balance: 100 });
      repo.findGrantedOnMachine.mockResolvedValueOnce([sessionRow({ status: 'PAUSED', pinUsedAt: new Date(), lockReason: 'runout' })]);
      await expect(service.unlockFor(STATION)).rejects.toMatchObject({ response: { code: 'INSUFFICIENT_FUNDS' } });
    });

    it('a new login on the PC closes the session still open there, without ending the new one', async () => {
      const pinHash = await hashPin('123456');
      repo.findLoginCandidate.mockResolvedValueOnce(sessionRow({ id: 'new', pinHash, pinExpiresAt: new Date(Date.now() + 60_000) }));
      const lockedAt = new Date(Date.now() - 60_000);
      repo.findGrantedOnMachine.mockResolvedValueOnce([sessionRow({ id: 'old', status: 'PAUSED', pinUsedAt: new Date(), lockedAt, meteredSeconds: 60 })]);
      await expect(service.login(STATION, 'pin', '123456')).resolves.toMatchObject({ accepted: true, sessionId: 'new' });
      expect(repo.complete).toHaveBeenCalledWith('old', 'res-1', expect.objectContaining({ settledAt: lockedAt }));
      expect(commands.issueSystemEndSession).not.toHaveBeenCalled();
    });
  });

  describe('extend', () => {
    const runningBooking = (overrides: Record<string, unknown> = {}) =>
      sessionRow({ status: 'ACTIVE', pinUsedAt: new Date(), meteringStartedAt: new Date(), rateCentsPerMinute: 150, ...overrides });

    beforeEach(() => {
      repo.findActiveForReservation.mockResolvedValue({ id: 's1' });
      repo.findForSettlement.mockResolvedValue(runningBooking());
    });

    it('adds time at the walk-in rate, switching rate at the old end, and clears the station notice', async () => {
      const result = await service.extend('g1', 'res-1', 30);
      const input = repo.extendIfFree.mock.calls[0][0];
      expect(input.to.getTime() - input.from.getTime()).toBe(30 * 60_000);
      expect(input.session).toMatchObject({ nextRateCentsPerMinute: 100, rateSwitchAt: input.from, endingNoticeSentAt: null });
      expect(result).toMatchObject({ costCents: 3000 });
      expect(agents.sendControl).toHaveBeenCalledWith('SN-1', 'session_notice', expect.objectContaining({ kind: 'CLEAR' }));
    });

    it('refuses when the PC is booked right after, or the wallet does not cover it', async () => {
      repo.extendIfFree.mockResolvedValueOnce({ kind: 'slot_taken' });
      await expect(service.extend('g1', 'res-1', 60)).rejects.toMatchObject({ response: { code: 'RESERVATION_SLOT_TAKEN' } });

      wallet.getWalletForGamer.mockResolvedValue({ balance: 1000 });
      await expect(service.extend('g1', 'res-1', 90)).rejects.toMatchObject({ response: { code: 'INSUFFICIENT_FUNDS' } });
    });

    it('only extends the gamer’s own running session', async () => {
      await expect(service.extend('someone-else', 'res-1', 30)).rejects.toMatchObject({ response: { code: 'RESERVATION_NOT_FOUND' } });
      repo.findForSettlement.mockResolvedValue(sessionRow({ status: 'PENDING', pinUsedAt: null }));
      await expect(service.extend('g1', 'res-1', 30)).rejects.toMatchObject({ response: { code: 'SESSION_NOT_RUNNING' } });
    });

    it('lists the options with what makes each unavailable', async () => {
      repo.isMachineBusy.mockImplementation(async (_m: string, _from: Date, to: Date) => to.getTime() - Date.now() > 100 * 60_000);
      wallet.getWalletForGamer.mockResolvedValue({ balance: 100_000 });
      const { options } = await service.extendOptions('g1', 'res-1');
      expect(options.map((o) => [o.minutes, o.available])).toEqual([[30, true], [60, false], [90, false]]);
    });
  });

  describe('lists', () => {
    it("shows the gamer their own session: time played, cost so far and what's left", async () => {
      repo.gamerProfileIdForUser = vi.fn(async () => 'g1');
      repo.findCurrentForGamer = vi.fn(async () => ({
        ...sessionRow({ status: 'ACTIVE', pinUsedAt: new Date(), meteredSeconds: 300, meteringStartedAt: new Date(Date.now() - 5 * 60_000) }),
        reservation: { id: 'res-1', machine: { id: 'm1', name: 'PC-01', serialNumber: 'SN-1', branchId: 'b1' } },
      }));
      const current = await service.currentForGamer('user-g1');
      expect(current).toMatchObject({ sessionId: 's1', station: { name: 'PC-01' }, playedSeconds: 600, costSoFarCents: 1000, balanceAfterCents: 99_000 });

      repo.findCurrentForGamer.mockResolvedValueOnce(null);
      await expect(service.currentForGamer('user-g1')).resolves.toBeNull();
    });

    it("lists the desk's branch sessions with station, gamer and cost so far", async () => {
      repo.list = vi.fn(async () => [
        {
          ...sessionRow({ status: 'ACTIVE', pinUsedAt: new Date(), meteringStartedAt: new Date(Date.now() - 60_000) }),
          reservation: { machine: { id: 'm1', name: 'PC-01', serialNumber: 'SN-1', branchId: 'b1' }, gamerProfile: { user: { username: 'ali' } } },
        },
      ]);
      const [row] = await service.list(caller(), { limit: 50 });
      expect(row).toMatchObject({ id: 's1', gamerUsername: 'ali', station: { name: 'PC-01' }, costSoFarCents: 100 });
      expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ branchId: 'b1' }));
    });
  });

  describe('notices', () => {
    it('warns the station and the gamer before the booking ends, once', async () => {
      const endTime = new Date(Date.now() + 5 * 60_000);
      repo.findEndingSoon.mockResolvedValueOnce([sessionRow({ status: 'ACTIVE', pinUsedAt: new Date(), endTime })]);
      await service.sweep();
      expect(repo.update).toHaveBeenCalledWith('s1', { endingNoticeSentAt: expect.any(Date) });
      expect(agents.sendControl).toHaveBeenCalledWith('SN-1', 'session_notice', { sessionId: 's1', kind: 'TIME_LEFT', endsAt: endTime.toISOString(), message: null });
      expect(dashboard.publishToUser).toHaveBeenCalledWith('user-g1', 'session_notice', expect.objectContaining({ kind: 'TIME_LEFT' }));
    });

    it('sends the low-balance warning to staff, the station and the gamer', async () => {
      repo.findForSettlement.mockResolvedValueOnce(sessionRow({ status: 'ACTIVE', pinUsedAt: new Date(), meteringStartedAt: new Date() }));
      await service.warnLowBalance('s1');
      expect(dashboard.publishToBranch).toHaveBeenCalledWith('b1', 'session_runout_warning', { sessionId: 's1', machineId: 'm1' });
      expect(agents.sendControl).toHaveBeenCalledWith('SN-1', 'session_notice', expect.objectContaining({ kind: 'LOW_BALANCE' }));
      expect(dashboard.publishToUser).toHaveBeenCalledWith('user-g1', 'session_notice', expect.objectContaining({ kind: 'LOW_BALANCE' }));
    });
  });
});
