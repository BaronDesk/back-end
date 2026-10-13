import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createHarness,
  sessionRow,
  type Harness,
} from './session-billing.harness-spec.js';
import { SessionExtensionsService } from './session-extensions.service.js';

describe('SessionExtensionsService', () => {
  let harness: Harness;
  let repo: Harness['repo'];
  let agents: Harness['agents'];
  let wallet: Harness['wallet'];
  let service: SessionExtensionsService;

  beforeEach(() => {
    harness = createHarness();
    ({ repo, agents, wallet } = harness);
    service = harness.extensions;
  });

  afterEach(() => harness.destroy());

  describe('extend', () => {
    const runningBooking = (overrides: Record<string, unknown> = {}) =>
      sessionRow({ status: 'ACTIVE', pinUsedAt: new Date(), meteringStartedAt: new Date(), rateCoinsPerHour: 9000, ...overrides });

    beforeEach(() => {
      repo.findActiveForReservation.mockResolvedValue({ id: 's1' });
      repo.findForSettlement.mockResolvedValue(runningBooking());
    });

    it('adds time at the walk-in rate, switching rate at the old end, and clears the station notice', async () => {
      const result = await service.extend('g1', 'res-1', 30);
      const input = repo.extendIfFree.mock.calls[0][0];
      expect(input.to.getTime() - input.from.getTime()).toBe(30 * 60_000);
      expect(input.session).toMatchObject({ nextRateCoinsPerHour: 6000, rateSwitchAt: input.from, endingNoticeSentAt: null });
      expect(result).toMatchObject({ costCoins: 3000 });
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
});
