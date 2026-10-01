import { describe, expect, it, vi } from 'vitest';

import { SessionsRepository } from './sessions.repository.js';

describe('SessionsRepository station lock', () => {
  it('runs the callback in one transaction holding the station advisory lock', async () => {
    const order: string[] = [];
    const tx = {
      $executeRaw: vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
        order.push(`lock:${strings.join('?')}:${values.join(',')}`);
      }),
    };
    const prisma = { $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)) };
    const repo = new SessionsRepository(prisma as any);

    const result = await repo.withMachineLock('m1', async (t) => {
      order.push('fn');
      expect(t).toBe(tx);
      return 'done';
    });

    expect(result).toBe('done');
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(order).toEqual(['lock:SELECT pg_advisory_xact_lock(hashtext(?)):m1', 'fn']);
  });

  it("finds the reservation's open session on the given transaction", async () => {
    // Every booking holds its PIN session from the start, so a station can have
    // several open sessions (future bookings): the lookup is per reservation.
    const tx = { session: { findFirst: vi.fn(async () => null) } };
    const prisma = { session: { findFirst: vi.fn() } };
    const repo = new SessionsRepository(prisma as any);

    await repo.findOpenForReservation('r1', tx as any);

    expect(prisma.session.findFirst).not.toHaveBeenCalled();
    expect(tx.session.findFirst).toHaveBeenCalledWith({
      where: { reservationId: 'r1', status: { in: ['PENDING', 'ACTIVE', 'PAUSED'] } },
    });
  });
});

describe('SessionsRepository.complete', () => {
  function setup(sessionCount: number) {
    const tx = {
      session: { updateMany: vi.fn(async () => ({ count: sessionCount })) },
      reservation: { updateMany: vi.fn(async () => ({ count: 1 })) },
    };
    const prisma = { $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)) };
    return { tx, repo: new SessionsRepository(prisma as any) };
  }

  it('closes only an open session, then completes its reservation', async () => {
    const { tx, repo } = setup(1);
    expect(await repo.complete('s1', 'r1', { status: 'COMPLETED' })).toBe(true);
    expect(tx.session.updateMany).toHaveBeenCalledWith({
      where: { id: 's1', status: { in: ['PENDING', 'ACTIVE', 'PAUSED'] } },
      data: { status: 'COMPLETED' },
    });
    expect(tx.reservation.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1', status: { in: ['CONFIRMED', 'ACTIVE'] } },
      data: { status: 'COMPLETED' },
    });
  });

  it('is a no-op once the session is already closed', async () => {
    const { tx, repo } = setup(0);
    expect(await repo.complete('s1', 'r1', { status: 'COMPLETED' })).toBe(false);
    expect(tx.reservation.updateMany).not.toHaveBeenCalled();
  });
});

describe('SessionsRepository early no-show', () => {
  it('finds PENDING sessions whose PIN expired unused on a still-CONFIRMED reservation', async () => {
    const prisma = { session: { findMany: vi.fn(async (_args: any) => []) } };
    const now = new Date();
    await new SessionsRepository(prisma as any).findExpiredUnusedPins(now);
    expect(prisma.session.findMany.mock.calls[0][0].where).toEqual({
      status: 'PENDING', pinUsedAt: null, pinExpiresAt: { lte: now }, reservation: { status: 'CONFIRMED' },
    });
  });

  function setup(sessionCount: number) {
    const tx = {
      session: { updateMany: vi.fn(async (_args: any) => ({ count: sessionCount })) },
      reservation: { updateMany: vi.fn(async (_args: any) => ({ count: 1 })) },
    };
    const prisma = { $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)) };
    return { tx, prisma, repo: new SessionsRepository(prisma as any) };
  }

  it('cancels the session (dropping its PIN) and marks the reservation NO_SHOW in one transaction', async () => {
    const { tx, prisma, repo } = setup(1);
    expect(await repo.expireAsNoShow('s1', 'r1')).toBe(true);
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(tx.session.updateMany).toHaveBeenCalledWith({
      where: { id: 's1', status: 'PENDING', pinUsedAt: null, reservation: { status: 'CONFIRMED' } },
      data: { status: 'CANCELLED', pinHash: null, pinCipher: null },
    });
    expect(tx.reservation.updateMany).toHaveBeenCalledWith({ where: { id: 'r1', status: 'CONFIRMED' }, data: { status: 'NO_SHOW' } });
  });

  it('touches nothing when a login spent the PIN first', async () => {
    const { tx, repo } = setup(0);
    expect(await repo.expireAsNoShow('s1', 'r1')).toBe(false);
    expect(tx.reservation.updateMany).not.toHaveBeenCalled();
  });
});

describe('SessionsRepository.closeAsNoShow', () => {
  function setup(sessionCount: number) {
    const tx = {
      session: { updateMany: vi.fn(async (_args: any) => ({ count: sessionCount })) },
      reservation: { updateMany: vi.fn(async (_args: any) => ({ count: 1 })) },
    };
    const prisma = { $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)) };
    return { tx, prisma, repo: new SessionsRepository(prisma as any) };
  }

  it('cancels a PENDING session, drops its PIN, and marks the reservation NO_SHOW in one transaction', async () => {
    const { tx, prisma, repo } = setup(1);
    expect(await repo.closeAsNoShow('s1', 'r1')).toBe(true);
    expect(prisma.$transaction).toHaveBeenCalledOnce();
    expect(tx.session.updateMany).toHaveBeenCalledWith({
      where: { id: 's1', status: 'PENDING' },
      data: { status: 'CANCELLED', pinHash: null, pinCipher: null },
    });
    expect(tx.reservation.updateMany).toHaveBeenCalledWith({
      where: { id: 'r1', status: { in: ['CONFIRMED', 'ACTIVE'] } },
      data: { status: 'NO_SHOW' },
    });
  });

  it('can require the PIN unused, and leaves the reservation alone when the session was not PENDING', async () => {
    const { tx, repo } = setup(0);
    expect(await repo.closeAsNoShow('s1', 'r1', { unusedPinOnly: true })).toBe(false);
    expect(tx.session.updateMany.mock.calls[0][0].where).toEqual({ id: 's1', status: 'PENDING', pinUsedAt: null });
    expect(tx.reservation.updateMany).not.toHaveBeenCalled();
  });
});

describe('SessionsRepository.list', () => {
  function setup() {
    const prisma = { session: { findMany: vi.fn(async () => []) } };
    return { prisma, repo: new SessionsRepository(prisma as any) };
  }

  it('leaves out sessions still waiting for their PIN (bookings nobody logged into)', async () => {
    const { prisma, repo } = setup();
    await repo.list({ branchId: 'b1', limit: 50 });
    const [args] = prisma.session.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown>; take: number }];
    expect(args.where).toEqual({
      reservation: { machine: { branchId: 'b1' } },
      status: { not: 'CANCELLED' },
      OR: [{ status: { not: 'PENDING' } }, { pinUsedAt: { not: null } }],
    });
    expect(args.take).toBe(50);
  });

  it('keeps the status and start filters, every branch for HQ', async () => {
    const { prisma, repo } = setup();
    const from = new Date('2026-10-01T00:00:00Z');
    await repo.list({ branchId: null, status: 'COMPLETED', from, limit: 10 });
    const [args] = prisma.session.findMany.mock.calls[0] as unknown as [{ where: Record<string, unknown> }];
    expect(args.where).toEqual({
      status: 'COMPLETED',
      startTime: { gte: from },
      OR: [{ status: { not: 'PENDING' } }, { pinUsedAt: { not: null } }],
    });
  });
});
