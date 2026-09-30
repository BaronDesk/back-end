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
    id: 'res-1', gamerProfileId: 'g1', machineId: 'm1', status: 'CONFIRMED', ...window(),
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
    ...window(),
    reservation: { gamerProfileId: 'g1', machineId: 'm1', machine: { id: 'm1', branchId: 'b1', serialNumber: 'SN-1' } },
    ...overrides,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('SessionsService', () => {
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let presence: { statusChanges: Subject<any>; sessionEnded: Subject<any>; isOnline: ReturnType<typeof vi.fn> };
  let pricing: { getRatesForBranch: ReturnType<typeof vi.fn> };
  let membership: { getActiveDiscountForGamer: ReturnType<typeof vi.fn> };
  let wallet: { debit: ReturnType<typeof vi.fn> };
  let commands: Record<string, ReturnType<typeof vi.fn>>;
  let runoutTimer: Record<string, ReturnType<typeof vi.fn>>;
  let port: StationSessionPort;
  let service: SessionsService;

  beforeEach(() => {
    repo = {
      findReservationForStart: vi.fn(async () => reservation()),
      withMachineLock: vi.fn(async (_machineId, fn) => fn('tx')),
      findOpenSessionForMachine: vi.fn(async () => null),
      create: vi.fn(async (data) => sessionRow(data)),
      cancelPending: vi.fn(async () => ({ count: 1 })),
      findById: vi.fn(async () => sessionRow({ status: 'PENDING', pinUsedAt: new Date() })),
      findForSettlement: vi.fn(async () => sessionRow({ status: 'ACTIVE', meteringStartedAt: new Date(Date.now() - 5 * 60_000) })),
      findByIdWithReservation: vi.fn(async () => sessionRow()),
      findLoginCandidate: vi.fn(async () => null),
      claimPinAttempt: vi.fn(async () => true),
      spendPin: vi.fn(async () => true),
      update: vi.fn(async (id, data) => sessionRow({ id, ...data })),
      activate: vi.fn(async () => undefined),
      complete: vi.fn(async () => true),
      findOverdueOpen: vi.fn(async () => []),
      markNoShows: vi.fn(async () => 0),
    };
    presence = { statusChanges: new Subject(), sessionEnded: new Subject(), isOnline: vi.fn(() => true) };
    pricing = { getRatesForBranch: vi.fn(async () => ({ paygRate: 6000, bookingRate: 9000 })) }; // 6000c/hr = 100c/min
    membership = { getActiveDiscountForGamer: vi.fn(async () => null) };
    wallet = { debit: vi.fn(async () => ({ id: 'e1' })), credited: new Subject() };
    commands = {
      issue: vi.fn(async () => ({})),
      issueSystemLock: vi.fn(async () => undefined),
      issueSessionUnlock: vi.fn(async () => true),
      issueSystemEndSession: vi.fn(async () => true),
    };
    runoutTimer = { scheduleOrReschedule: vi.fn(async () => undefined), cancel: vi.fn(async () => undefined) };
    port = new StationSessionPort();
    const config = {
      get: (key: string) =>
        ({ SESSION_LEASE_CAP_S: LEASE_CAP_S, SESSION_PIN_MAX_ATTEMPTS: MAX_ATTEMPTS, SESSION_PIN_TTL_S: 900 })[key],
    };
    service = new SessionsService(
      repo as any, presence as any, pricing as any, membership as any, wallet as any, commands as any, runoutTimer as any, port, config as any,
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
      expect(repo.create.mock.calls[0][0]).toMatchObject({ rateCentsPerMinute: 90, appliedMembershipId: 'ms1' });
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
      repo.findOpenSessionForMachine.mockResolvedValueOnce(sessionRow({ pinExpiresAt: new Date(Date.now() + 60_000) }));
      await expect(service.start(caller(), 'res-1')).rejects.toMatchObject({ response: { code: 'SESSION_ALREADY_STARTED' } });
      repo.findOpenSessionForMachine.mockResolvedValueOnce(sessionRow({ status: 'ACTIVE' }));
      await expect(service.start(caller(), 'res-1')).rejects.toBeInstanceOf(ConflictException);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('replaces a PENDING session whose PIN expired unused, inside the station lock', async () => {
      repo.findOpenSessionForMachine.mockResolvedValueOnce(sessionRow({ id: 'old', pinExpiresAt: new Date(Date.now() - 1000) }));
      await service.start(caller(), 'res-1');
      expect(repo.withMachineLock).toHaveBeenCalledWith('m1', expect.any(Function));
      expect(repo.cancelPending).toHaveBeenCalledWith('old', 'tx');
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ reservationId: 'res-1' }), 'tx');
    });

    it('replaces a PENDING session whose PIN ran out of attempts', async () => {
      repo.findOpenSessionForMachine.mockResolvedValueOnce(
        sessionRow({ id: 'old', pinExpiresAt: new Date(Date.now() + 60_000), pinAttempts: MAX_ATTEMPTS }),
      );
      await service.start(caller(), 'res-1');
      expect(repo.cancelPending).toHaveBeenCalledWith('old', 'tx');
      expect(repo.create).toHaveBeenCalled();
    });

    it('409s MACHINE_BUSY when another reservation holds an open session on the station', async () => {
      for (const open of [
        sessionRow({ id: 'other', reservationId: 'res-2', status: 'ACTIVE' }),
        sessionRow({ id: 'other', reservationId: 'res-2', status: 'PAUSED' }),
        // Even a dead PIN on another reservation is not this start's to replace.
        sessionRow({ id: 'other', reservationId: 'res-2', pinExpiresAt: new Date(Date.now() - 1000) }),
      ]) {
        repo.findOpenSessionForMachine.mockResolvedValueOnce(open);
        await expect(service.start(caller(), 'res-1')).rejects.toMatchObject({
          response: { code: 'MACHINE_BUSY', error: 'station already has an active session' },
        });
      }
      expect(repo.findOpenSessionForMachine).toHaveBeenCalledWith('m1', 'tx');
      expect(repo.cancelPending).not.toHaveBeenCalled();
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('409s MACHINE_BUSY if another open session remains after replacing a dead PIN', async () => {
      repo.findOpenSessionForMachine
        .mockResolvedValueOnce(sessionRow({ id: 'old', pinExpiresAt: new Date(Date.now() - 1000) }))
        .mockResolvedValueOnce(sessionRow({ id: 'other', reservationId: 'res-2', status: 'ACTIVE' }));
      await expect(service.start(caller(), 'res-1')).rejects.toMatchObject({ response: { code: 'MACHINE_BUSY' } });
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('lets exactly one of two concurrent starts on one station win', async () => {
      // In-memory station: the lock mock serializes callbacks the way pg_advisory_xact_lock does.
      const sessions: any[] = [];
      let tail: Promise<unknown> = Promise.resolve();
      repo.withMachineLock.mockImplementation((_machineId: string, fn: (tx: unknown) => Promise<unknown>) => {
        const run = tail.then(() => fn('tx'));
        tail = run.catch(() => undefined);
        return run;
      });
      repo.findOpenSessionForMachine.mockImplementation(async () => sessions.find((s) => ['PENDING', 'ACTIVE', 'PAUSED'].includes(s.status)) ?? null);
      repo.create.mockImplementation(async (data: Record<string, unknown>) => {
        await flush(); // yield, so an unlocked check-then-create would interleave
        const row = sessionRow({ id: `s${sessions.length + 1}`, ...data });
        sessions.push(row);
        return row;
      });
      repo.findReservationForStart.mockImplementation(async (id: string) => reservation({ id }));

      const results = await Promise.allSettled([service.start(caller(), 'res-1'), service.start(caller(), 'res-2')]);

      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      const [loser] = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected');
      expect(loser.reason).toMatchObject({ response: { code: 'MACHINE_BUSY' } });
      expect(sessions).toHaveLength(1);
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
      expect(wallet.debit).toHaveBeenCalledWith('g1', expect.objectContaining({ amount: 1000, sessionId: 's1' }));
      expect(repo.complete).toHaveBeenCalledWith('s1', 'res-1', expect.objectContaining({ status: 'COMPLETED', meteredSeconds: 600 }));
      expect(commands.issueSystemEndSession).toHaveBeenCalledWith('m1', 'reservation_ended');
      expect(commands.issueSessionUnlock).not.toHaveBeenCalled();
    });

    it('ends a session that is already closed without settling it again', async () => {
      repo.findForSettlement.mockResolvedValueOnce(sessionRow({ status: 'COMPLETED' }));
      await service.reconcile(STATION, { locked: false, sessionId: 's1' });
      expect(commands.issueSystemEndSession).toHaveBeenCalledWith('m1', 'session_closed');
      expect(wallet.debit).not.toHaveBeenCalled();
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
      expect(wallet.debit).toHaveBeenCalledWith('g1', expect.objectContaining({ amount: 500, sessionId: 's1' }));
      expect(repo.complete).toHaveBeenCalledWith('s1', 'res-1', expect.objectContaining({ status: 'COMPLETED', meteredSeconds: 300 }));
    });

    it('still completes the session, flagged, when the settlement debit fails', async () => {
      wallet.debit.mockRejectedValueOnce(new ConflictException());
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
      expect(wallet.debit).not.toHaveBeenCalled();
    });

    it('sweep: cancels a never-logged-in session past its window and marks no-shows', async () => {
      const past = { startTime: new Date(Date.now() - 2 * HOUR), endTime: new Date(Date.now() - HOUR) };
      repo.findOverdueOpen.mockResolvedValueOnce([sessionRow({ id: 'p1', status: 'PENDING', pinUsedAt: null, ...past })]);
      repo.markNoShows.mockResolvedValueOnce(1);
      await service.sweep();
      expect(repo.cancelPending).toHaveBeenCalledWith('p1');
      expect(repo.markNoShows).toHaveBeenCalledWith(expect.any(Date));
      expect(wallet.debit).not.toHaveBeenCalled();
      expect(commands.issueSystemEndSession).not.toHaveBeenCalled();
    });

    it('sweep: settles an open session past its window and ends it on the station', async () => {
      const endTime = new Date(Date.now() - 60_000);
      repo.findOverdueOpen.mockResolvedValueOnce([
        sessionRow({ status: 'PAUSED', meteredSeconds: 120, endTime, startTime: new Date(endTime.getTime() - HOUR) }),
      ]);
      await service.sweep();
      expect(repo.complete).toHaveBeenCalledWith('s1', 'res-1', expect.objectContaining({ status: 'COMPLETED', meteredSeconds: 120 }));
      expect(commands.issueSystemEndSession).toHaveBeenCalledWith('m1', 'reservation_ended');
      expect(repo.cancelPending).not.toHaveBeenCalled();
    });
  });

  describe('forceClose', () => {
    /** One stored session row that complete() closes only while it is still open, like the guarded repo write. */
    let row: ReturnType<typeof sessionRow>;

    beforeEach(() => {
      row = sessionRow({ status: 'ACTIVE', meteringStartedAt: new Date(Date.now() - 5 * 60_000) });
      repo.findByIdWithReservation.mockImplementation(async () => ({ ...row }));
      repo.findForSettlement.mockImplementation(async () => ({ ...row }));
      repo.complete.mockImplementation(async (_id: string, _reservationId: string, data: Record<string, unknown>) => {
        if (!['PENDING', 'ACTIVE', 'PAUSED'].includes(row.status)) return false;
        row = { ...row, ...data };
        return true;
      });
    });

    it('settles an ACTIVE session at once, completes the reservation, ends it on the station and cancels the run-out timer', async () => {
      const result = await service.forceClose(caller(), 's1', 'agent crashed');

      expect(commands.issueSystemEndSession).toHaveBeenCalledWith('m1', 'agent crashed');
      // 5 minutes active at 100c/min = 500c
      expect(wallet.debit).toHaveBeenCalledOnce();
      expect(wallet.debit).toHaveBeenCalledWith('g1', expect.objectContaining({
        amount: 500, sessionId: 's1', idempotencyKey: 'session-settlement:s1',
      }));
      expect(repo.complete).toHaveBeenCalledOnce();
      expect(repo.complete).toHaveBeenCalledWith('s1', 'res-1', expect.objectContaining({ status: 'COMPLETED', meteredSeconds: 300 }));
      expect(runoutTimer.cancel).toHaveBeenCalledWith('s1');
      expect(result).toMatchObject({ id: 's1', status: 'COMPLETED' });
    });

    it('meters no further than the reservation window', async () => {
      row = sessionRow({ status: 'PAUSED', meteredSeconds: 120, endTime: new Date(Date.now() - 60_000) });
      await service.forceClose(caller(), 's1');
      expect(repo.complete).toHaveBeenCalledWith('s1', 'res-1', expect.objectContaining({ meteredSeconds: 120 }));
      expect(commands.issueSystemEndSession).toHaveBeenCalledWith('m1', 'force_close');
    });

    it('still settles when END_SESSION cannot reach the station', async () => {
      commands.issueSystemEndSession.mockRejectedValueOnce(new Error('dispatch failed'));
      await service.forceClose(caller(), 's1');
      expect(repo.complete).toHaveBeenCalledOnce();
      expect(row.status).toBe('COMPLETED');
    });

    it('a later presence sessionEnded does not settle or debit again', async () => {
      await service.forceClose(caller(), 's1');
      presence.sessionEnded.next({ sessionId: 's1', endedAt: new Date().toISOString() });
      await flush();

      expect(wallet.debit).toHaveBeenCalledOnce();
      expect(repo.complete).toHaveBeenCalledOnce();
      expect(row.billingBreakdown).toMatchObject({ meteredSeconds: 300, totalCents: 500 });
    });

    it('racing sessionEnded that read the session while open closes nothing twice and reuses the debit key', async () => {
      const staleOpen = { ...row };
      repo.findForSettlement.mockResolvedValueOnce(staleOpen); // presence path read before force-close wrote
      const firstBreakdown = (await service.forceClose(caller(), 's1'), row.billingBreakdown);
      presence.sessionEnded.next({ sessionId: 's1', endedAt: new Date().toISOString() });
      await flush();

      // Only one close-out lands; any repeat debit carries the same idempotency key, so the wallet applies it once.
      expect(repo.complete).toHaveBeenCalledTimes(2);
      expect(await repo.complete.mock.results[1].value).toBe(false);
      expect(row.billingBreakdown).toBe(firstBreakdown);
      const keys = new Set(wallet.debit.mock.calls.map((c) => c[1].idempotencyKey));
      expect(keys).toEqual(new Set(['session-settlement:s1']));
    });

    it.each(['COMPLETED', 'CANCELLED'])('409s SESSION_NOT_OPEN for a %s session and touches nothing', async (status) => {
      row = sessionRow({ status });
      await expect(service.forceClose(caller(), 's1')).rejects.toMatchObject({ response: { code: 'SESSION_NOT_OPEN' } });
      expect(commands.issueSystemEndSession).not.toHaveBeenCalled();
      expect(wallet.debit).not.toHaveBeenCalled();
      expect(repo.complete).not.toHaveBeenCalled();
    });

    it('404s a missing session and rejects a cross-branch caller', async () => {
      repo.findByIdWithReservation.mockResolvedValueOnce(null);
      await expect(service.forceClose(caller(), 's1')).rejects.toBeInstanceOf(NotFoundException);
      await expect(service.forceClose(caller({ branchId: 'other' }), 's1')).rejects.toThrow();
      expect(repo.complete).not.toHaveBeenCalled();
    });
  });

  it("lockForRunout issues a system LOCK for the session's station", async () => {
    await service.lockForRunout('s1');
    expect(commands.issueSystemLock).toHaveBeenCalledWith('m1', 'runout');
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
});
