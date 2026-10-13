import { ConflictException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createHarness,
  caller,
  flush,
  LEASE_CAP_S,
  sessionRow,
  STATION,
  type Harness,
} from './session-billing.harness-spec.js';
import { StationLinkService } from './station-link.service.js';

describe('StationLinkService', () => {
  let harness: Harness;
  let repo: Harness['repo'];
  let presence: Harness['presence'];
  let wallet: Harness['wallet'];
  let commands: Harness['commands'];
  let runoutTimer: Harness['runoutTimer'];
  let service: StationLinkService;

  beforeEach(() => {
    harness = createHarness();
    ({ repo, presence, wallet, commands, runoutTimer } = harness);
    service = harness.stationLink;
  });

  afterEach(() => harness.destroy());

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

    it('skips settlement for a session that is already closed', async () => {
      repo.findForSettlement.mockResolvedValueOnce(sessionRow({ status: 'COMPLETED' }));
      presence.sessionEnded.next({ sessionId: 's1', endedAt: new Date().toISOString() });
      await flush();
      expect(wallet.debitUpTo).not.toHaveBeenCalled();
    });
  });

  describe('pricing, funds and run-out', () => {
    it('force-closes: settles a session that played, closes one that never did as a no-show, and ends it on its station', async () => {
      repo.findByIdWithReservation.mockResolvedValue(sessionRow({ status: 'ACTIVE', pinUsedAt: new Date() }));
      repo.findForSettlement.mockResolvedValueOnce(sessionRow({ status: 'ACTIVE', pinUsedAt: new Date(), meteringStartedAt: new Date(Date.now() - 60_000) }));
      await service.forceClose(caller(), 's1', 'desk');
      expect(commands.issueSystemEndSession).toHaveBeenCalledWith('m1', 'desk', 's1');
      expect(repo.complete).toHaveBeenCalledWith('s1', 'res-1', expect.objectContaining({ status: 'COMPLETED' }));

      repo.findByIdWithReservation.mockResolvedValue(sessionRow({ status: 'PENDING' }));
      repo.findForSettlement.mockResolvedValueOnce(sessionRow({ status: 'PENDING' }));
      await service.forceClose(caller(), 's1');
      expect(repo.closeAsNoShow).toHaveBeenCalledWith('s1', 'res-1', { unusedPinOnly: true });

      repo.findByIdWithReservation.mockResolvedValue(sessionRow({ status: 'COMPLETED' }));
      await expect(service.forceClose(caller(), 's1')).rejects.toMatchObject({ response: { code: 'SESSION_NOT_OPEN' } });
    });

    it('force-close still settles when the END_SESSION cannot be sent', async () => {
      commands.issueSystemEndSession.mockRejectedValueOnce(new Error('queue down'));
      repo.findByIdWithReservation.mockResolvedValue(sessionRow({ status: 'PAUSED', pinUsedAt: new Date(), meteredSeconds: 60 }));
      repo.findForSettlement.mockResolvedValueOnce(sessionRow({ status: 'PAUSED', pinUsedAt: new Date(), meteredSeconds: 60 }));
      await service.forceClose(caller(), 's1');
      expect(repo.complete).toHaveBeenCalled();
    });

    it('clears the lock reason when the session runs again', async () => {
      repo.findForSettlement.mockResolvedValueOnce(sessionRow({ status: 'PAUSED', lockReason: 'runout', pinUsedAt: new Date() }));
      presence.statusChanges.next({ sessionId: 's1', locked: false, branchId: 'b1' });
      await vi.waitFor(() => expect(repo.activate).toHaveBeenCalled());
      expect(repo.activate.mock.calls[0][2]).toMatchObject({ status: 'ACTIVE', lockReason: null });
    });
  });

  it('end() forwards to CommandsService as END_SESSION', async () => {
    await service.end(caller(), 's1', 'closing');
    expect(commands.issue).toHaveBeenCalledWith(caller(), 'm1', { type: 'END_SESSION', reason: 'closing' });
  });

  it('end() rejects a session that is already closed', async () => {
    repo.findByIdWithReservation.mockResolvedValueOnce(sessionRow({ status: 'COMPLETED' }));
    await expect(service.end(caller(), 's1')).rejects.toBeInstanceOf(ConflictException);
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
  });
});
