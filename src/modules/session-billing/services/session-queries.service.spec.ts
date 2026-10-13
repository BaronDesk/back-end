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
});
