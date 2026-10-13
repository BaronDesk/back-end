import { ConflictException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createHarness,
  flush,
  HOUR,
  sessionRow,
  type Harness,
} from './session-billing.harness-spec.js';
import { SessionMeteringService } from './session-metering.service.js';

describe('SessionMeteringService', () => {
  let harness: Harness;
  let repo: Harness['repo'];
  let presence: Harness['presence'];
  let wallet: Harness['wallet'];
  let service: SessionMeteringService;

  beforeEach(() => {
    harness = createHarness();
    ({ repo, presence, wallet } = harness);
    service = harness.metering;
  });

  afterEach(() => harness.destroy());

  describe('metering and reservation lifecycle', () => {
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
  });

  describe('pricing, funds and run-out', () => {
    it('charges what the wallet holds when the bill is bigger, and records the shortfall', async () => {
      wallet.debitUpTo.mockResolvedValueOnce(320);
      presence.sessionEnded.next({ sessionId: 's1', endedAt: new Date().toISOString() });
      await vi.waitFor(() => expect(repo.complete).toHaveBeenCalled());
      expect(repo.complete.mock.calls[0][2].billingBreakdown).toMatchObject({ totalCents: 500, chargedCents: 320, shortfallCents: 180 });
    });
  });

  describe('money never runs short', () => {
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

  describe('billOfflineDrop', () => {
    const pausedAt = new Date(Date.now() - 20 * 60_000);
    const paused = (overrides: Record<string, unknown> = {}) =>
      sessionRow({ status: 'PAUSED', pinUsedAt: new Date(), lockedAt: pausedAt, lockReason: 'offline', meteredSeconds: 600, ...overrides }) as any;
    const after = (seconds: number) => new Date(pausedAt.getTime() + seconds * 1000);

    it('adds the time from the pause to the station lock, capped, and returns the session as billed', async () => {
      const billed = await service.billOfflineDrop(paused(), after(120), 190);
      expect(repo.billOfflineOnce).toHaveBeenCalledWith('s1', pausedAt, 120);
      expect(billed).toMatchObject({ meteredSeconds: 720, offlineBilledSeconds: 120, offlineBilledFor: pausedAt });

      await service.billOfflineDrop(paused(), after(3600), 190);
      expect(repo.billOfflineOnce).toHaveBeenLastCalledWith('s1', pausedAt, 190);
    });

    it('never bills past the booking end', async () => {
      await service.billOfflineDrop(paused({ endTime: after(30) }), after(120), 190);
      expect(repo.billOfflineOnce).toHaveBeenCalledWith('s1', pausedAt, 30);
    });

    it('bills a pause once: already billed, lost the race, or nothing to bill', async () => {
      const already = paused({ offlineBilledFor: pausedAt });
      await expect(service.billOfflineDrop(already, after(120), 190)).resolves.toBe(already);

      repo.billOfflineOnce.mockResolvedValueOnce(false);
      await expect(service.billOfflineDrop(paused(), after(120), 190)).resolves.toMatchObject({ meteredSeconds: 600 });

      await service.billOfflineDrop(paused(), after(-5), 190);
      await service.billOfflineDrop(paused({ status: 'ACTIVE' }), after(120), 190);
      expect(repo.billOfflineOnce).toHaveBeenCalledTimes(1);
    });
  });
});
