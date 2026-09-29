import { ConflictException, NotFoundException } from '@nestjs/common';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { SessionsService } from './sessions.service.js';

function caller(overrides: Partial<AccessTokenPayload> = {}): AccessTokenPayload {
  return { sub: 'user-1', role: 'EMPLOYEE', scope: 'staff', branchId: 'b1', jti: 'j1', ...overrides };
}

const RESERVATION = {
  id: 'res-1', gamerProfileId: 'g1', machineId: 'm1', status: 'CONFIRMED',
  startTime: new Date('2026-01-01T10:00:00Z'), endTime: new Date('2026-01-01T11:00:00Z'),
  machine: { id: 'm1', branchId: 'b1', serialNumber: 'SN-1' },
};

function sessionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1', reservationId: 'res-1', appliedMembershipId: null, status: 'PENDING',
    rateCentsPerMinute: 100, meteredSeconds: 0, meteringStartedAt: null, lockedAt: null,
    settledAt: null, billingBreakdown: null,
    startTime: RESERVATION.startTime, endTime: RESERVATION.endTime, createdAt: new Date(),
    reservation: { gamerProfileId: 'g1', machineId: 'm1', machine: RESERVATION.machine },
    ...overrides,
  };
}

function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

describe('SessionsService', () => {
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let presence: { statusChanges: Subject<any>; sessionEnded: Subject<any> };
  let pricing: { getRatesForBranch: ReturnType<typeof vi.fn> };
  let membership: { getActiveDiscountForGamer: ReturnType<typeof vi.fn> };
  let wallet: { debit: ReturnType<typeof vi.fn> };
  let commands: { issue: ReturnType<typeof vi.fn>; issueSystemLock: ReturnType<typeof vi.fn> };
  let service: SessionsService;

  beforeEach(() => {
    repo = {
      findReservationForStart: vi.fn(async () => RESERVATION),
      findActiveForReservation: vi.fn(async () => null),
      create: vi.fn(async (data) => sessionRow(data)),
      findById: vi.fn(async () => sessionRow({ status: 'PENDING' })),
      findForSettlement: vi.fn(async () => sessionRow({ status: 'ACTIVE', meteringStartedAt: new Date('2026-01-01T10:00:00Z') })),
      findByIdWithReservation: vi.fn(async () => sessionRow()),
      update: vi.fn(async (id, data) => sessionRow({ id, ...data })),
    };
    presence = { statusChanges: new Subject(), sessionEnded: new Subject() };
    pricing = { getRatesForBranch: vi.fn(async () => ({ paygRate: 6000, bookingRate: 9000 })) }; // 6000c/hr = 100c/min
    membership = { getActiveDiscountForGamer: vi.fn(async () => null) };
    wallet = { debit: vi.fn(async () => ({ id: 'e1' })) };
    commands = { issue: vi.fn(async () => ({})), issueSystemLock: vi.fn(async () => undefined) };
    service = new SessionsService(repo as any, presence as any, pricing as any, membership as any, wallet as any, commands as any);
    service.onModuleInit();
  });

  it('creates a PENDING session with the computed rate and sends the booking UNLOCK', async () => {
    const result = await service.start(caller(), 'res-1');
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ reservationId: 'res-1', rateCentsPerMinute: 100, appliedMembershipId: null }));
    expect(commands.issue).toHaveBeenCalledWith(caller(), 'm1', { type: 'UNLOCK', payload: { sessionId: 's1', pin: result.pin } });
    expect(result.pin).toMatch(/^\d{4}$/);
  });

  it('applies the active membership discount to the rate', async () => {
    membership.getActiveDiscountForGamer.mockResolvedValueOnce({ membershipId: 'ms1', discountPercent: 10 });
    await service.start(caller(), 'res-1');
    // 6000c/hr * 0.9 = 5400c/hr = 90c/min
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ rateCentsPerMinute: 90, appliedMembershipId: 'ms1' }));
  });

  it('still returns the session (with a PIN) when the UNLOCK send fails', async () => {
    commands.issue.mockRejectedValueOnce(new Error('station offline'));
    const result = await service.start(caller(), 'res-1');
    expect(result.id).toBe('s1');
  });

  it('404s for a missing reservation, and rejects a cross-branch caller', async () => {
    repo.findReservationForStart.mockResolvedValueOnce(null);
    await expect(service.start(caller(), 'res-1')).rejects.toBeInstanceOf(NotFoundException);

    repo.findReservationForStart.mockResolvedValueOnce(RESERVATION);
    await expect(service.start(caller({ branchId: 'other' }), 'res-1')).rejects.toThrow();
  });

  it('rejects starting a reservation that already has an open session', async () => {
    repo.findActiveForReservation.mockResolvedValueOnce(sessionRow());
    await expect(service.start(caller(), 'res-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('goes ACTIVE and starts metering once presence reports the station unlocked for this session', async () => {
    presence.statusChanges.next({ sessionId: 's1', locked: false, branchId: 'b1' });
    await flush();
    expect(repo.update).toHaveBeenCalledWith('s1', expect.objectContaining({ status: 'ACTIVE', lockedAt: null }));
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
  });

  it('settles on session end: debits the derived metered amount and records the breakdown', async () => {
    presence.sessionEnded.next({ sessionId: 's1', endedAt: new Date('2026-01-01T10:05:00Z').toISOString() });
    await flush();
    // 5 minutes active at 100c/min = 500c
    expect(wallet.debit).toHaveBeenCalledWith('g1', expect.objectContaining({ amount: 500, sessionId: 's1' }));
    expect(repo.update).toHaveBeenCalledWith('s1', expect.objectContaining({ status: 'COMPLETED', meteredSeconds: 300 }));
  });

  it('still completes the session, flagged, when the settlement debit fails', async () => {
    wallet.debit.mockRejectedValueOnce(new ConflictException());
    presence.sessionEnded.next({ sessionId: 's1', endedAt: new Date('2026-01-01T10:05:00Z').toISOString() });
    await flush();
    expect(repo.update).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ status: 'COMPLETED', billingBreakdown: expect.objectContaining({ debitFailed: true }) }),
    );
  });

  it('skips settlement for a session that is already closed', async () => {
    repo.findForSettlement.mockResolvedValueOnce(sessionRow({ status: 'COMPLETED' }));
    presence.sessionEnded.next({ sessionId: 's1', endedAt: new Date().toISOString() });
    await flush();
    expect(wallet.debit).not.toHaveBeenCalled();
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
