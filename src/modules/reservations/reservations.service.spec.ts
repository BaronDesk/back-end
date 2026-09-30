import { ConflictException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccessTokenPayload } from '../../common/types/jwt-payload.js';
import { ReservationsRepository } from './reservations.repository.js';
import { ReservationsService } from './reservations.service.js';

const GAMER: AccessTokenPayload = { sub: 'user-1', role: 'GAMER', scope: 'self', branchId: null, jti: 'j' } as AccessTokenPayload;
const MACHINE_ID = '7b0e7a57-2c4e-4d4f-9d5f-0e7c6a1f1a11';

/** A Prisma stand-in whose interactive transaction runs the callback against `tx`. */
function prismaWith(tx: Record<string, any>) {
  return { $transaction: vi.fn(async (fn: (t: unknown) => unknown) => fn(tx)) };
}

describe('ReservationsRepository.createIfAvailable', () => {
  let tx: Record<string, any>;
  let repo: ReservationsRepository;

  beforeEach(() => {
    tx = {
      $executeRaw: vi.fn(async () => undefined),
      machine: { findUnique: vi.fn(async () => ({ id: MACHINE_ID, enrollmentStatus: 'ENROLLED', status: 'ONLINE' })) },
      session: { findFirst: vi.fn(async () => null) },
      reservation: {
        findFirst: vi.fn(async () => null),
        create: vi.fn(async ({ data }) => ({ id: 'r1', ...data })),
      },
    };
    repo = new ReservationsRepository(prismaWith(tx) as any);
  });

  const slot = () => ({ machineId: MACHINE_ID, startTime: new Date(), endTime: new Date(Date.now() + 30 * 60_000) });

  it('creates a walk-in CONFIRMED, like a booking: only session activation makes a reservation ACTIVE', async () => {
    const walkIn = await repo.createIfAvailable('g1', slot(), true);
    const booking = await repo.createIfAvailable('g1', { ...slot(), startTime: new Date(Date.now() + 60 * 60_000), endTime: new Date(Date.now() + 2 * 60 * 60_000) });
    expect(walkIn).toMatchObject({ kind: 'created', reservation: { status: 'CONFIRMED' } });
    expect(booking).toMatchObject({ kind: 'created', reservation: { status: 'CONFIRMED' } });
  });

  it('treats PENDING, CONFIRMED and ACTIVE (session running) reservations as holding the slot', async () => {
    tx.reservation.findFirst.mockResolvedValueOnce({ id: 'other' });
    expect(await repo.createIfAvailable('g1', slot(), true)).toEqual({ kind: 'slot_taken' });
    expect(tx.reservation.findFirst.mock.calls[0][0].where.status).toEqual({ in: ['PENDING', 'CONFIRMED', 'ACTIVE'] });
    expect(tx.reservation.create).not.toHaveBeenCalled();
  });

  it('rejects a walk-in while the station holds an open session, under the station lock', async () => {
    tx.session.findFirst.mockResolvedValueOnce({ id: 's-open' });
    expect(await repo.createIfAvailable('g1', slot(), true)).toEqual({ kind: 'slot_taken' });
    expect(tx.$executeRaw).toHaveBeenCalledBefore(tx.session.findFirst);
    expect(tx.session.findFirst.mock.calls[0][0].where).toEqual({
      status: { in: ['PENDING', 'ACTIVE', 'PAUSED'] },
      reservation: { machineId: MACHINE_ID },
    });
    expect(tx.reservation.create).not.toHaveBeenCalled();
  });

  it('does not check open sessions for a future booking', async () => {
    const later = { ...slot(), startTime: new Date(Date.now() + 60 * 60_000), endTime: new Date(Date.now() + 2 * 60 * 60_000) };
    expect(await repo.createIfAvailable('g1', later)).toMatchObject({ kind: 'created' });
    expect(tx.session.findFirst).not.toHaveBeenCalled();
  });
});

describe('ReservationsService.cancel', () => {
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let service: ReservationsService;
  const future = () => new Date(Date.now() + 60 * 60_000);

  beforeEach(() => {
    repo = {
      findGamerProfileId: vi.fn(async () => ({ id: 'g1' })),
      findOwned: vi.fn(),
      cancel: vi.fn(async (id) => ({ id, status: 'CANCELLED' })),
    };
    service = new ReservationsService(repo as any);
  });

  it.each(['PENDING', 'CONFIRMED'])('cancels a %s reservation that has not started', async (status) => {
    repo.findOwned.mockResolvedValueOnce({ id: 'r1', status, startTime: future() });
    await expect(service.cancel(GAMER, 'r1')).resolves.toMatchObject({ status: 'CANCELLED' });
  });

  it.each(['ACTIVE', 'COMPLETED', 'CANCELLED', 'NO_SHOW'])('refuses to cancel a %s reservation', async (status) => {
    repo.findOwned.mockResolvedValueOnce({ id: 'r1', status, startTime: future() });
    await expect(service.cancel(GAMER, 'r1')).rejects.toBeInstanceOf(ConflictException);
    expect(repo.cancel).not.toHaveBeenCalled();
  });
});
