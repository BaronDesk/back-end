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
  let dashboard: Harness['dashboard'];
  let service: StationLinkService;

  beforeEach(() => {
    harness = createHarness();
    ({ repo, presence, wallet, commands, runoutTimer, dashboard } = harness);
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
      expect(repo.complete).toHaveBeenCalledWith('s1', 'res-1', expect.objectContaining({ status: 'COMPLETED', meteredSeconds: 600 }), { gamerProfileId: 'g1', amount: 16 });
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
      expect(repo.complete).toHaveBeenCalledWith('s1', 'res-1', expect.objectContaining({ status: 'COMPLETED' }), expect.anything());

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
      repo.findForSettlement.mockResolvedValueOnce(sessionRow({ status: 'PAUSED', lockReason: 'offline', pinUsedAt: new Date() }));
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
      expect(repo.complete).toHaveBeenCalledWith('s1', 'res-1', expect.objectContaining({ settledAt: lastSeen }), expect.anything());
    });

    it('settles the session before a shutdown', async () => {
      repo.findGrantedOnMachine.mockResolvedValueOnce([sessionRow({ status: 'PAUSED', pinUsedAt: new Date(), meteredSeconds: 60 })]);
      await service.closeForShutdown(STATION);
      expect(repo.complete).toHaveBeenCalledWith('s1', 'res-1', expect.objectContaining({ status: 'COMPLETED' }), expect.anything());
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

  describe('reconnect respects why a session is locked', () => {
    const paused = (lockReason: string | null, overrides: Record<string, unknown> = {}) =>
      sessionRow({ status: 'PAUSED', pinUsedAt: new Date(), lockedAt: new Date(Date.now() - 10 * 60_000), lockReason, ...overrides });

    it('keeps a staff lock through a reconnect, and locks a station that comes back unlocked', async () => {
      repo.findForSettlement.mockResolvedValue(paused('staff'));
      await service.reconcile(STATION, { locked: false, sessionId: 's1' });
      expect(commands.issueSessionUnlock).not.toHaveBeenCalled();
      expect(commands.issueSystemLock).toHaveBeenCalledWith('m1', 'staff');

      await service.reconcile(STATION, { locked: true, sessionId: 's1' });
      expect(commands.issueSystemLock).toHaveBeenCalledTimes(1);
      expect(commands.issueSessionUnlock).not.toHaveBeenCalled();
    });

    it('keeps a run-out lock through a reconnect', async () => {
      repo.findForSettlement.mockResolvedValue(paused('runout'));
      await service.reconcile(STATION, { locked: false, sessionId: 's1' });
      expect(commands.issueSessionUnlock).not.toHaveBeenCalled();
      expect(commands.issueSystemLock).toHaveBeenCalledWith('m1', 'runout');
    });

    it('keeps a session locked for no recorded reason locked', async () => {
      repo.findForSettlement.mockResolvedValue(paused(null));
      await service.reconcile(STATION, { locked: true, sessionId: 's1' });
      expect(commands.issueSessionUnlock).not.toHaveBeenCalled();
      expect(commands.issueSystemLock).not.toHaveBeenCalled();
    });

    it('resumes a session paused because the station went offline', async () => {
      repo.findForSettlement.mockResolvedValue(paused('offline'));
      await service.reconcile(STATION, { locked: true, sessionId: 's1' });
      expect(commands.issueSessionUnlock).toHaveBeenCalledWith('m1', expect.objectContaining({ sessionId: 's1', leaseSeconds: LEASE_CAP_S }), 'resume');
      expect(commands.issueSystemLock).not.toHaveBeenCalled();
    });

    it('does not resume metering when a station still unlocked from before reports a staff- or funds-locked session', async () => {
      for (const lockReason of ['staff', 'runout']) {
        repo.findForSettlement.mockResolvedValueOnce(paused(lockReason));
        presence.statusChanges.next({ ...STATION, status: 'ONLINE', sessionId: 's1', locked: false, branchId: 'b1' });
        await flush();
      }
      expect(repo.activate).not.toHaveBeenCalled();
    });

    it('keeps a staff lock on a session still ACTIVE when the station goes offline', async () => {
      const lastSeen = new Date(Date.now() - 60_000);
      repo.findGrantedOnMachine.mockResolvedValueOnce([
        sessionRow({ status: 'ACTIVE', pinUsedAt: new Date(), lockReason: 'staff', meteringStartedAt: new Date(lastSeen.getTime() - 60_000) }),
      ]);
      presence.statusChanges.next({ ...STATION, status: 'OFFLINE', lastSeen: lastSeen.toISOString(), sessionId: 's1', locked: false });
      await vi.waitFor(() => expect(repo.update).toHaveBeenCalled());
      expect(repo.update).toHaveBeenCalledWith('s1', expect.objectContaining({ status: 'PAUSED', lockedAt: lastSeen, lockReason: 'staff' }));
    });

    it('lets a staff UNLOCK lift the lock it holds', async () => {
      repo.findGrantedOnMachine.mockResolvedValueOnce([paused('staff')]);
      await expect(service.unlockFor(STATION)).resolves.toMatchObject({ sessionId: 's1' });
      expect(repo.update).toHaveBeenCalledWith('s1', { lockReason: null });
    });

    it('marks the open session locked by staff when a staff LOCK goes out', async () => {
      repo.findGrantedOnMachine.mockResolvedValueOnce([sessionRow({ status: 'ACTIVE', pinUsedAt: new Date() })]);
      await service.markStaffLock(STATION);
      expect(repo.update).toHaveBeenCalledWith('s1', { lockReason: 'staff' });
    });
  });

  describe('handshake after the station was unreachable (e.g. across a backend restart)', () => {
    const lastContact = new Date(Date.now() - 2 * 60_000);

    it('pauses a session still ACTIVE at the last contact, before reconcile resumes it', async () => {
      presence.unreachableSince.mockReturnValue(lastContact);
      repo.findGrantedOnMachine.mockResolvedValueOnce([
        sessionRow({ status: 'ACTIVE', pinUsedAt: new Date(), meteringStartedAt: new Date(lastContact.getTime() - 18 * 60_000) }),
      ]);
      await service.reconnected(STATION);
      expect(repo.update).toHaveBeenCalledWith('s1', expect.objectContaining({ status: 'PAUSED', meteredSeconds: 1080, lockedAt: lastContact, lockReason: 'offline' }));
      expect(runoutTimer.cancel).toHaveBeenCalledWith('s1');

      repo.findForSettlement.mockResolvedValueOnce(sessionRow({ status: 'PAUSED', pinUsedAt: new Date(), lockedAt: lastContact, lockReason: 'offline', meteredSeconds: 1080 }));
      await service.reconcile(STATION, { locked: true, sessionId: 's1' });
      expect(commands.issueSessionUnlock).toHaveBeenCalledWith('m1', expect.objectContaining({ sessionId: 's1' }), 'resume');
    });

    it('keeps a staff or funds lock it was paused under', async () => {
      presence.unreachableSince.mockReturnValue(lastContact);
      repo.findGrantedOnMachine.mockResolvedValueOnce([sessionRow({ status: 'ACTIVE', pinUsedAt: new Date(), lockReason: 'runout', meteringStartedAt: new Date(lastContact.getTime() - 60_000) })]);
      await service.reconnected(STATION);
      expect(repo.update).toHaveBeenCalledWith('s1', expect.objectContaining({ status: 'PAUSED', lockReason: 'runout' }));
    });

    it('changes nothing after a short drop, or for a session already paused', async () => {
      repo.findGrantedOnMachine.mockResolvedValue([sessionRow({ status: 'ACTIVE', pinUsedAt: new Date(), meteringStartedAt: new Date() })]);
      await service.reconnected(STATION); // unreachableSince: null
      expect(repo.findGrantedOnMachine).not.toHaveBeenCalled();

      presence.unreachableSince.mockReturnValue(lastContact);
      repo.findGrantedOnMachine.mockResolvedValue([sessionRow({ status: 'PAUSED', pinUsedAt: new Date(), lockReason: 'offline' })]);
      await service.reconnected(STATION);
      expect(repo.update).not.toHaveBeenCalled();
    });
  });

  describe('staff orders to an unreachable station', () => {
    const lastContact = new Date(Date.now() - 2 * 60_000);

    beforeEach(() => presence.lastContactOf.mockReturnValue(lastContact));

    it('LOCK: pauses a running session at the last contact, locked by staff', async () => {
      repo.findGrantedOnMachine.mockResolvedValueOnce([
        sessionRow({ status: 'ACTIVE', pinUsedAt: new Date(), meteringStartedAt: new Date(lastContact.getTime() - 5 * 60_000) }),
      ]);
      await expect(service.lockWhileOffline(STATION)).resolves.toBe(true);
      expect(repo.update).toHaveBeenCalledWith('s1', expect.objectContaining({ status: 'PAUSED', meteredSeconds: 300, lockedAt: lastContact, lockReason: 'staff' }));
      expect(runoutTimer.cancel).toHaveBeenCalledWith('s1');
    });

    it('LOCK: a session already paused offline becomes locked by staff, so the reconnect keeps it locked', async () => {
      repo.findGrantedOnMachine.mockResolvedValueOnce([sessionRow({ status: 'PAUSED', pinUsedAt: new Date(), lockReason: 'offline' })]);
      await expect(service.lockWhileOffline(STATION)).resolves.toBe(true);
      expect(repo.update).toHaveBeenCalledWith('s1', { lockReason: 'staff' });
    });

    it('END_SESSION: closes the session from server state, billed up to the last contact', async () => {
      repo.findGrantedOnMachine.mockResolvedValueOnce([sessionRow({ status: 'ACTIVE', pinUsedAt: new Date() })]);
      repo.findForSettlement.mockResolvedValueOnce(
        sessionRow({ status: 'ACTIVE', pinUsedAt: new Date(), meteringStartedAt: new Date(lastContact.getTime() - 10 * 60_000) }),
      );
      await expect(service.endWhileOffline(STATION, 'closing')).resolves.toBe(true);
      expect(wallet.debitUpTo).toHaveBeenCalledWith('g1', expect.objectContaining({ amount: 1000, sessionId: 's1' }));
      expect(repo.complete).toHaveBeenCalledWith('s1', 'res-1', expect.objectContaining({
        status: 'COMPLETED', meteredSeconds: 600, settledAt: lastContact, billingBreakdown: expect.objectContaining({ endReason: 'closing' }),
      }), { gamerProfileId: 'g1', amount: 16 });
      expect(commands.issueSystemEndSession).not.toHaveBeenCalled();
    });

    it('applies nothing when no session is open there', async () => {
      await expect(service.lockWhileOffline(STATION)).resolves.toBe(false);
      await expect(service.endWhileOffline(STATION, 'closing')).resolves.toBe(false);
      expect(repo.update).not.toHaveBeenCalled();
      expect(repo.complete).not.toHaveBeenCalled();
    });
  });

  describe('fair billing for a single station drop', () => {
    const pausedAt = new Date(Date.now() - 20 * 60_000);
    const pausedOffline = (overrides: Record<string, unknown> = {}) =>
      sessionRow({ status: 'PAUSED', pinUsedAt: new Date(), lockedAt: pausedAt, lockReason: 'offline', meteredSeconds: 600, ...overrides });
    const at = (seconds: number) => new Date(pausedAt.getTime() + seconds * 1000).toISOString();

    beforeEach(() => repo.findForSettlement.mockResolvedValue(pausedOffline()));

    it('bills from the last heartbeat to when the station locked itself, then resumes', async () => {
      presence.outageOf.mockReturnValue('single');
      await service.reconcile(STATION, { locked: true, sessionId: 's1', lockedAt: at(50), lockReason: 'lease_expired' });
      expect(repo.billOfflineOnce).toHaveBeenCalledWith('s1', pausedAt, 50);
      expect(commands.issueSessionUnlock).toHaveBeenCalledWith('m1', expect.objectContaining({ sessionId: 's1' }), 'resume');
    });

    it('caps it at the lease the station held plus grace (60 s + 10 s)', async () => {
      presence.outageOf.mockReturnValue('single');
      await service.reconcile(STATION, { locked: true, sessionId: 's1', lockedAt: at(900) });
      expect(repo.billOfflineOnce).toHaveBeenCalledWith('s1', pausedAt, 70);
    });

    it('bills a pause only once', async () => {
      presence.outageOf.mockReturnValue('single');
      repo.findForSettlement.mockResolvedValue(pausedOffline({ offlineBilledFor: pausedAt, offlineBilledSeconds: 100 }));
      await service.reconcile(STATION, { locked: true, sessionId: 's1', lockedAt: at(100) });
      expect(repo.billOfflineOnce).not.toHaveBeenCalled();
      expect(commands.issueSessionUnlock).toHaveBeenCalled();
    });

    it('bills nothing past the last contact for a venue outage, an unknown drop, a restart or a lock at startup', async () => {
      for (const [outage, report] of [
        ['venue', {}],
        [null, {}],
        ['single', { restarted: true }],
        ['single', { lockReason: 'startup' as const }],
      ] as const) {
        presence.outageOf.mockReturnValue(outage);
        await service.reconcile(STATION, { locked: true, sessionId: 's1', lockedAt: at(100), ...report });
      }
      expect(repo.billOfflineOnce).not.toHaveBeenCalled();
      expect(commands.issueSessionUnlock).toHaveBeenCalledTimes(4);
    });

    it('records it in the billing breakdown of a session the station dropped meanwhile', async () => {
      presence.outageOf.mockReturnValue('single');
      repo.findGrantedOnMachine.mockResolvedValueOnce([pausedOffline()]);
      await service.reconcile(STATION, { locked: true, sessionId: null, lockedAt: at(60), lockReason: 'gamer_ended' });
      expect(repo.billOfflineOnce).toHaveBeenCalledWith('s1', pausedAt, 60);
      // 600 s before the drop + 60 s after it, at 100/min.
      expect(wallet.debitUpTo).toHaveBeenCalledWith('g1', expect.objectContaining({ amount: 1100 }));
      expect(repo.complete).toHaveBeenCalledWith('s1', 'res-1', expect.objectContaining({
        meteredSeconds: 660,
        settledAt: pausedAt,
        billingBreakdown: expect.objectContaining({ offlineBilledSeconds: 60, totalCoins: 1100 }),
      }), { gamerProfileId: 'g1', amount: 18 }); // 660 s played, the 60 s after the drop included
    });

    it('without the new state_report fields, bills nothing extra and resumes as before', async () => {
      presence.outageOf.mockReturnValue('single');
      await service.reconcile(STATION, { locked: true, sessionId: 's1' });
      expect(repo.billOfflineOnce).not.toHaveBeenCalled();
      expect(commands.issueSessionUnlock).toHaveBeenCalledWith('m1', expect.objectContaining({ sessionId: 's1' }), 'resume');

      presence.outageOf.mockReturnValue(null);
      await service.reconcile(STATION, { locked: true, sessionId: 's1' });
      // Only the single drop above is flagged: classification is the backend's, not the agent's.
      expect(dashboard.publishToBranch).toHaveBeenCalledTimes(1);
    });

    it('flags a paid session whose station dropped on its own, or restarted, for staff', async () => {
      presence.outageOf.mockReturnValue('single');
      await service.reconcile(STATION, { locked: true, sessionId: 's1', offlineSince: at(5) });
      expect(dashboard.publishToBranch).toHaveBeenCalledWith('b1', 'station_attention', expect.objectContaining({
        machineId: 'm1', sessionId: 's1', reason: 'single_drop', offlineSince: at(5),
      }));

      presence.outageOf.mockReturnValue(null);
      repo.findForSettlement.mockResolvedValue(sessionRow({ status: 'ACTIVE', pinUsedAt: new Date(), meteringStartedAt: new Date() }));
      await service.reconcile(STATION, { locked: false, sessionId: 's1', restarted: true });
      expect(dashboard.publishToBranch).toHaveBeenLastCalledWith('b1', 'station_attention', expect.objectContaining({ reason: 'restarted' }));
    });

    it('does not flag a venue outage or free play', async () => {
      presence.outageOf.mockReturnValue('venue');
      await service.reconcile(STATION, { locked: true, sessionId: 's1' });
      presence.outageOf.mockReturnValue('single');
      repo.findForSettlement.mockResolvedValue(pausedOffline({ rateCoinsPerHour: 0 }));
      await service.reconcile(STATION, { locked: true, sessionId: 's1', restarted: true });
      expect(dashboard.publishToBranch).not.toHaveBeenCalled();
    });
  });

  describe('durable station events (queued, run by the worker)', () => {
    let events: Harness['events'];
    let jobs: Harness['jobs'];
    let processor: Harness['processor'];

    beforeEach(() => ({ events, jobs, processor } = harness));

    const ended = (sessionId = 's1') => ({ machineId: 'm1', branchId: 'b1', serialNumber: 'SN-1', sessionId, reason: 'normal', endedAt: new Date().toISOString() });

    it('queues a session end as settle-<sessionId>, retried with backoff', async () => {
      events.autoRun = false;
      presence.sessionEnded.next(ended());
      await flush();
      expect(events.add).toHaveBeenCalledWith('settle', { event: expect.objectContaining({ sessionId: 's1' }) }, expect.objectContaining({
        jobId: 'settle-s1', attempts: 5, backoff: { type: 'exponential', delay: 1_000 }, removeOnComplete: true,
      }));
      expect(repo.complete).not.toHaveBeenCalled();
    });

    it('queues a lock-state change stamped with when it was seen, under an id derived from the change', async () => {
      events.autoRun = false;
      presence.statusChanges.next({ ...STATION, status: 'ONLINE', lastSeen: new Date().toISOString(), sessionId: 's1', locked: true, branchId: 'b1' });
      await flush();
      const [{ name, data, opts }] = jobs;
      expect(name).toBe('status');
      expect(opts.jobId).toBe(`status-SN-1-ONLINE-s1-true-${Date.parse(data.at)}`);
      expect(opts.jobId).not.toContain(':');
    });

    it('settles an end whose worker never ran once a worker runs it: one debit, XP once, a retry changes nothing', async () => {
      events.autoRun = false; // the process died before handling it
      presence.sessionEnded.next(ended());
      await flush();
      expect(wallet.debitUpTo).not.toHaveBeenCalled();

      // The worker comes back and runs the waiting job; the session is then closed.
      repo.complete.mockImplementationOnce(async () => {
        repo.findForSettlement.mockResolvedValue(sessionRow({ status: 'COMPLETED' }));
        return true;
      });
      await processor.process({ name: jobs[0].name, data: jobs[0].data } as any);
      expect(wallet.debitUpTo).toHaveBeenCalledTimes(1);
      expect(wallet.debitUpTo).toHaveBeenCalledWith('g1', expect.objectContaining({ idempotencyKey: 'session-settlement:s1' }));
      expect(repo.complete).toHaveBeenCalledTimes(1);
      expect(repo.complete.mock.calls[0][3]).toEqual({ gamerProfileId: 'g1', amount: 8 });

      // The same job again (a retry after a crash past the commit): nothing more.
      await processor.process({ name: jobs[0].name, data: jobs[0].data } as any);
      expect(wallet.debitUpTo).toHaveBeenCalledTimes(1);
      expect(repo.complete).toHaveBeenCalledTimes(1);
    });

    it('stops metering when the station locked, not when the job finally runs', async () => {
      events.autoRun = false;
      const startedAt = new Date(Date.now() - 10 * 60_000);
      repo.findForSettlement.mockResolvedValue(sessionRow({ status: 'ACTIVE', pinUsedAt: new Date(), meteringStartedAt: startedAt }));
      const seen = new Date(Date.now() - 5 * 60_000);
      await service.enqueueStationStatus({ ...STATION, status: 'ONLINE', lastSeen: seen.toISOString(), sessionId: 's1', locked: true, branchId: 'b1' } as any, seen);
      await processor.process({ name: jobs[0].name, data: jobs[0].data } as any);
      expect(repo.update).toHaveBeenCalledWith('s1', expect.objectContaining({ status: 'PAUSED', meteredSeconds: 300, lockedAt: seen }));
    });

    it('skips a change the station has since reported otherwise, and an OFFLINE it is back from', async () => {
      presence.agentStateOf.mockReturnValue({ locked: false, sessionId: 's1', runningGameId: null });
      repo.findForSettlement.mockResolvedValue(sessionRow({ status: 'ACTIVE', pinUsedAt: new Date(), meteringStartedAt: new Date() }));
      await service.handleStationStatus({ ...STATION, status: 'ONLINE', lastSeen: '', sessionId: 's1', locked: true, branchId: 'b1' } as any, new Date());
      presence.isOnline.mockReturnValue(true);
      repo.findGrantedOnMachine.mockResolvedValue([sessionRow({ status: 'ACTIVE', pinUsedAt: new Date(), meteringStartedAt: new Date() })]);
      await service.handleStationStatus({ ...STATION, status: 'OFFLINE', lastSeen: new Date().toISOString(), sessionId: 's1', locked: false } as any, new Date());
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('handles the event in-process when the queue is unreachable', async () => {
      events.add.mockRejectedValueOnce(new Error('ECONNREFUSED'));
      await service.enqueueSessionEnded(ended());
      expect(repo.complete).toHaveBeenCalledTimes(1);
    });

    it('lets a failed handler throw so the queue retries it', async () => {
      repo.findForSettlement.mockRejectedValueOnce(new Error('db down'));
      await expect(service.handleSessionEnded(ended())).rejects.toThrow('db down');
    });
  });
});
