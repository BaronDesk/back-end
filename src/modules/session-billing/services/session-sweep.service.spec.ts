import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  createHarness,
  HOUR,
  sessionRow,
  type Harness,
} from './session-billing.harness-spec.js';
import { SessionSweepService } from './session-sweep.service.js';

describe('SessionSweepService', () => {
  let harness: Harness;
  let repo: Harness['repo'];
  let agents: Harness['agents'];
  let dashboard: Harness['dashboard'];
  let wallet: Harness['wallet'];
  let commands: Harness['commands'];
  let service: SessionSweepService;

  beforeEach(() => {
    harness = createHarness();
    ({ repo, agents, dashboard, wallet, commands } = harness);
    service = harness.sweep;
  });

  afterEach(() => harness.destroy());

  describe('metering and reservation lifecycle', () => {
    it('sweep: a booking nobody logged into by its no-show deadline becomes NO_SHOW and frees the PC', async () => {
      repo.findExpiredUnusedPins.mockResolvedValueOnce([{ id: 'e1', reservationId: 'r-late' }]);
      await service.sweep();
      expect(repo.expireAsNoShow).toHaveBeenCalledWith('e1', 'r-late');
      expect(repo.markNoShows).toHaveBeenCalledWith(expect.any(Date), 30 * 60_000);
    });

    it('sweep: closes a never-logged-in session past its window as a no-show', async () => {
      const past = { startTime: new Date(Date.now() - 2 * HOUR), endTime: new Date(Date.now() - HOUR) };
      repo.findOverdueOpen.mockResolvedValueOnce([sessionRow({ id: 'p1', status: 'PENDING', pinUsedAt: null, ...past })]);
      await service.sweep();
      expect(repo.closeAsNoShow).toHaveBeenCalledWith('p1', 'res-1', { unusedPinOnly: true });
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

  describe('notices', () => {
    it('warns the station and the gamer before the booking ends, once', async () => {
      const endTime = new Date(Date.now() + 5 * 60_000);
      repo.findEndingSoon.mockResolvedValueOnce([sessionRow({ status: 'ACTIVE', pinUsedAt: new Date(), endTime })]);
      await service.sweep();
      expect(repo.update).toHaveBeenCalledWith('s1', { endingNoticeSentAt: expect.any(Date) });
      expect(agents.sendControl).toHaveBeenCalledWith('SN-1', 'session_notice', { sessionId: 's1', kind: 'TIME_LEFT', endsAt: endTime.toISOString(), message: null });
      expect(dashboard.publishToUser).toHaveBeenCalledWith('user-g1', 'session_notice', expect.objectContaining({ kind: 'TIME_LEFT' }));
    });
  });
});
