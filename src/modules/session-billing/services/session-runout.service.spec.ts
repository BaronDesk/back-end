import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  createHarness,
  flush,
  sessionRow,
  STATION,
  type Harness,
} from './session-billing.harness-spec.js';
import { SessionRunoutService } from './session-runout.service.js';

describe('SessionRunoutService', () => {
  let harness: Harness;
  let repo: Harness['repo'];
  let presence: Harness['presence'];
  let agents: Harness['agents'];
  let dashboard: Harness['dashboard'];
  let wallet: Harness['wallet'];
  let commands: Harness['commands'];
  let runoutTimer: Harness['runoutTimer'];
  let service: SessionRunoutService;

  beforeEach(() => {
    harness = createHarness();
    ({ repo, presence, agents, dashboard, wallet, commands, runoutTimer } = harness);
    service = harness.runout;
  });

  afterEach(() => harness.destroy());

  it("lockForRunout marks the session locked for funds and issues a system LOCK for its station", async () => {
    await service.lockForRunout('s1');
    expect(repo.update).toHaveBeenCalledWith('s1', { lockReason: 'runout' });
    expect(commands.issueSystemLock).toHaveBeenCalledWith('m1', 'runout');
  });

  describe('pricing, funds and run-out', () => {
    it('resumes a session locked for funds once a top-up covers the minimum play time', async () => {
      repo.findPausedByGamer.mockResolvedValue(sessionRow({ status: 'PAUSED', lockReason: 'runout', pinUsedAt: new Date() }));
      wallet.credited.next({ gamerProfileId: 'g1' });
      await vi.waitFor(() => expect(commands.issueSessionUnlock).toHaveBeenCalled());
      expect(repo.findPausedByGamer).toHaveBeenCalledWith('g1', 'runout', expect.any(Date));
      expect(commands.issueSessionUnlock).toHaveBeenCalledWith('m1', expect.objectContaining({ sessionId: 's1' }), 'topup');
    });

    it('lifts the funds lock before the top-up UNLOCK, and puts it back when the UNLOCK cannot go out', async () => {
      repo.findPausedByGamer.mockResolvedValue(sessionRow({ status: 'PAUSED', lockReason: 'runout', pinUsedAt: new Date() }));
      wallet.credited.next({ gamerProfileId: 'g1' });
      await vi.waitFor(() => expect(commands.issueSessionUnlock).toHaveBeenCalled());
      expect(repo.update).toHaveBeenCalledWith('s1', { lockReason: null });
      expect(repo.update.mock.invocationCallOrder[0]).toBeLessThan(commands.issueSessionUnlock.mock.invocationCallOrder[0]);

      commands.issueSessionUnlock.mockResolvedValueOnce(false);
      wallet.credited.next({ gamerProfileId: 'g1' });
      await vi.waitFor(() => expect(repo.update).toHaveBeenLastCalledWith('s1', { lockReason: 'runout' }));
    });

    it('keeps a session locked for funds locked when the top-up is still too small', async () => {
      wallet.getWalletForGamer.mockResolvedValue({ balance: 100 });
      repo.findPausedByGamer.mockResolvedValue(sessionRow({ status: 'PAUSED', lockReason: 'runout' }));
      wallet.credited.next({ gamerProfileId: 'g1' });
      await vi.waitFor(() => expect(wallet.getWalletForGamer).toHaveBeenCalled());
      await flush();
      expect(commands.issueSessionUnlock).not.toHaveBeenCalled();
    });
  });

  it('lockForRunout is a no-op for a session that is already closed', async () => {
    repo.findByIdWithReservation.mockResolvedValueOnce(sessionRow({ status: 'COMPLETED' }));
    await service.lockForRunout('s1');
    expect(commands.issueSystemLock).not.toHaveBeenCalled();
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
  });

  describe('notices', () => {
    it('sends the low-balance warning to staff, the station and the gamer', async () => {
      repo.findForSettlement.mockResolvedValueOnce(sessionRow({ status: 'ACTIVE', pinUsedAt: new Date(), meteringStartedAt: new Date() }));
      await service.warnLowBalance('s1');
      expect(dashboard.publishToBranch).toHaveBeenCalledWith('b1', 'session_runout_warning', { sessionId: 's1', machineId: 'm1' });
      expect(agents.sendControl).toHaveBeenCalledWith('SN-1', 'session_notice', expect.objectContaining({ kind: 'LOW_BALANCE' }));
      expect(dashboard.publishToUser).toHaveBeenCalledWith('user-g1', 'session_notice', expect.objectContaining({ kind: 'LOW_BALANCE' }));
    });
  });
});
