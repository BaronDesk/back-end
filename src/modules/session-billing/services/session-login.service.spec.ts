import { ConflictException, NotFoundException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { hashPin } from '../util/pin.js';
import {
  createHarness,
  caller,
  HOUR,
  LEASE_CAP_S,
  MAX_ATTEMPTS,
  reservation,
  sessionRow,
  STATION,
  type Harness,
} from './session-billing.harness-spec.js';
import { SessionLoginService } from './session-login.service.js';

describe('SessionLoginService', () => {
  let harness: Harness;
  let repo: Harness['repo'];
  let presence: Harness['presence'];
  let membership: Harness['membership'];
  let subscriptions: Harness['subscriptions'];
  let wallet: Harness['wallet'];
  let commands: Harness['commands'];
  let service: SessionLoginService;

  beforeEach(() => {
    harness = createHarness();
    ({ repo, presence, membership, subscriptions, wallet, commands } = harness);
    service = harness.login;
  });

  afterEach(() => harness.destroy());

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

    it('makes the PIN work until the no-show deadline (30 min after the start), never past the booking end', async () => {
      await service.start(caller(), 'res-1');
      // The default window started 10 minutes ago: the deadline is 20 minutes away.
      const deadline = repo.create.mock.calls[0][0].pinExpiresAt.getTime();
      expect(deadline).toBeGreaterThan(Date.now() + 19 * 60_000);
      expect(deadline).toBeLessThanOrEqual(Date.now() + 20 * 60_000);

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

    it('409s a reservation that is not CONFIRMED, already over, or past its no-show deadline', async () => {
      repo.findReservationForStart.mockResolvedValueOnce(reservation({ status: 'PENDING' }));
      await expect(service.start(caller(), 'res-1')).rejects.toMatchObject({ response: { code: 'RESERVATION_NOT_CONFIRMED' } });

      repo.findReservationForStart.mockResolvedValueOnce(reservation({ endTime: new Date(Date.now() - 1000) }));
      await expect(service.start(caller(), 'res-1')).rejects.toMatchObject({ response: { code: 'RESERVATION_EXPIRED' } });

      const now = Date.now();
      repo.findReservationForStart.mockResolvedValueOnce(reservation({ startTime: new Date(now - 31 * 60_000), endTime: new Date(now + HOUR) }));
      await expect(service.start(caller(), 'res-1')).rejects.toMatchObject({ response: { code: 'RESERVATION_EXPIRED' } });
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('issues the PIN for a booking later on, even while its station is switched off, under the station lock', async () => {
      presence.isOnline.mockReturnValue(false);
      const now = Date.now();
      repo.findReservationForStart.mockResolvedValueOnce(reservation({ startTime: new Date(now + 2 * 24 * HOUR), endTime: new Date(now + 2 * 24 * HOUR + HOUR) }));
      await expect(service.start(caller(), 'res-1')).resolves.toMatchObject({ pin: expect.stringMatching(/^\d{6}$/) });
      expect(repo.withMachineLock).toHaveBeenCalledWith('m1', expect.any(Function));
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
      repo.findOpenForReservation.mockResolvedValueOnce(sessionRow({ pinExpiresAt: new Date(Date.now() + 60_000) }));
      await expect(service.start(caller(), 'res-1')).rejects.toBeInstanceOf(ConflictException);
      repo.findOpenForReservation.mockResolvedValueOnce(sessionRow({ status: 'ACTIVE' }));
      await expect(service.start(caller(), 'res-1')).rejects.toBeInstanceOf(ConflictException);
    });

    it('replaces a PENDING session whose PIN expired unused', async () => {
      repo.findOpenForReservation.mockResolvedValueOnce(sessionRow({ id: 'old', pinExpiresAt: new Date(Date.now() - 1000) }));
      await service.start(caller(), 'res-1');
      expect(repo.cancelPending).toHaveBeenCalledWith('old', {});
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

    it('keeps the PIN recoverable for the app: the sealed copy opens to the same PIN, never stored in clear', async () => {
      const { pin } = await service.checkIn('g1', 'res-1');
      const { pinCipher, pinExpiresAt } = repo.create.mock.calls[0][0];
      expect(pinCipher).not.toContain(pin);
      repo.findUnusedPinsForGamer.mockResolvedValueOnce([{ reservationId: 'res-1', pinCipher, pinExpiresAt, startTime: new Date() }]);
      const pins = await service.pinsForGamer('g1');
      expect(pins.get('res-1')).toMatchObject({ pin, validUntil: pinExpiresAt.toISOString() });
    });

    it('replaces a still-valid PIN nobody typed, but not a session already logged into', async () => {
      repo.findOpenForReservation.mockResolvedValueOnce(sessionRow({ id: 'old', pinExpiresAt: new Date(Date.now() + 60_000) }));
      await service.checkIn('g1', 'res-1');
      expect(repo.cancelPending).toHaveBeenCalledWith('old', {});

      repo.findOpenForReservation.mockResolvedValueOnce(sessionRow({ pinUsedAt: new Date() }));
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
      repo.findOpenForReservation.mockResolvedValueOnce(sessionRow({ id: 'old', pinExpiresAt: new Date(Date.now() - 1000) }));
      await service.start(caller(), 'res-1');
      expect(repo.create.mock.calls[1][0]).toMatchObject({ rateCentsPerMinute: 90, appliedMembershipId: 'ms1' });
    });

    it('refuses the login, keeping the PIN, when the wallet no longer covers the minimum play time', async () => {
      wallet.getWalletForGamer.mockResolvedValue({ balance: 499 }); // 5 min at 100/min = 500
      const pinHash = await hashPin('123456');
      repo.findLoginCandidate.mockResolvedValueOnce(sessionRow({ pinHash, pinExpiresAt: new Date(Date.now() + 60_000) }));
      await expect(service.login(STATION, 'pin', '123456')).resolves.toEqual({ accepted: false, reason: 'insufficient_funds' });
      expect(repo.spendPin).not.toHaveBeenCalled();
    });

    it('lets free play start with an empty wallet', async () => {
      wallet.getWalletForGamer.mockResolvedValue({ balance: 0 });
      subscriptions.getWindowDiscountForGamer.mockResolvedValueOnce({ subscriptionId: 'sub1', discountPercent: 100 });
      await expect(service.checkIn('g1', 'res-1')).resolves.toMatchObject({ pin: expect.any(String) });
    });
  });

  describe('stations', () => {
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
});
