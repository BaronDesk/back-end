import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createHarness,
  caller,
  sessionRow,
  type Harness,
} from './session-billing.harness-spec.js';
import { SessionQueriesService } from './session-queries.service.js';

describe('SessionQueriesService', () => {
  let harness: Harness;
  let repo: Harness['repo'];
  let service: SessionQueriesService;

  beforeEach(() => {
    harness = createHarness();
    ({ repo } = harness);
    service = harness.queries;
  });

  afterEach(() => harness.destroy());

  describe('lists', () => {
    it("shows the gamer their own session: time played, cost so far and what's left", async () => {
      repo.gamerProfileIdForUser = vi.fn(async () => 'g1');
      repo.findCurrentForGamer = vi.fn(async () => ({
        ...sessionRow({ status: 'ACTIVE', pinUsedAt: new Date(), meteredSeconds: 300, meteringStartedAt: new Date(Date.now() - 5 * 60_000) }),
        reservation: { id: 'res-1', machine: { id: 'm1', name: 'PC-01', serialNumber: 'SN-1', branchId: 'b1' } },
      }));
      const current = await service.currentForGamer('user-g1');
      expect(current).toMatchObject({ sessionId: 's1', station: { name: 'PC-01' }, playedSeconds: 600, costSoFarCoins: 1000, balanceAfterCoins: 99_000 });

      repo.findCurrentForGamer.mockResolvedValueOnce(null);
      await expect(service.currentForGamer('user-g1')).resolves.toBeNull();
    });

    it("lists the gamer's settled sessions: time played, bill and XP, a free one and an old one too", async () => {
      repo.gamerProfileIdForUser = vi.fn(async () => 'g1');
      const row = (id: string, bill: unknown, name: string | null = 'PC-01') => ({
        id,
        startTime: new Date('2026-10-10T14:00:00Z'),
        settledAt: new Date('2026-10-10T15:00:00Z'),
        meteredSeconds: 3600,
        billingBreakdown: bill,
        reservation: { isWalkIn: false, machine: { name, serialNumber: 'SN-1', branch: { name: 'CENTRE El Manar' } } },
      });
      repo.listSettledForGamer = vi.fn(async () => [
        row('paid', { totalCoins: 4000, chargedCoins: 4000, xpEarned: 100 }),
        row('free', { totalCoins: 0, xpEarned: 100 }),
        row('old', { totalCoins: 600, chargedCoins: 600 }, null),
      ]);
      const history = await service.historyForGamer('user-g1');
      expect(repo.listSettledForGamer).toHaveBeenCalledWith('g1', 50);
      expect(history).toEqual([
        expect.objectContaining({ sessionId: 'paid', stationName: 'PC-01', branchName: 'CENTRE El Manar', meteredSeconds: 3600, totalCoins: 4000, chargedCoins: 4000, xpEarned: 100 }),
        expect.objectContaining({ sessionId: 'free', totalCoins: 0, chargedCoins: 0, xpEarned: 100 }),
        // No PC name: its serial number. Settled before XP existed: none.
        expect.objectContaining({ sessionId: 'old', stationName: 'SN-1', chargedCoins: 600, xpEarned: null }),
      ]);
    });

    it("lists the desk's branch sessions with station, gamer and cost so far", async () => {
      repo.list = vi.fn(async () => [
        {
          ...sessionRow({ status: 'ACTIVE', pinUsedAt: new Date(), meteringStartedAt: new Date(Date.now() - 60_000) }),
          reservation: { machine: { id: 'm1', name: 'PC-01', serialNumber: 'SN-1', branchId: 'b1' }, gamerProfile: { user: { username: 'ali' } } },
        },
      ]);
      const [row] = await service.list(caller(), { limit: 50 });
      expect(row).toMatchObject({ id: 's1', gamerUsername: 'ali', station: { name: 'PC-01' }, costSoFarCoins: 100 });
      expect(repo.list).toHaveBeenCalledWith(expect.objectContaining({ branchId: 'b1' }));
    });
  });
});
