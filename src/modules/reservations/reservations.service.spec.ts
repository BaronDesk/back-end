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

/** Equality, `{ in: [...] }` and null filters: enough for the cancel queries. */
function matches(row: Record<string, unknown>, where: Record<string, any>): boolean {
  return Object.entries(where).every(([key, cond]) =>
    cond !== null && typeof cond === 'object' && 'in' in cond ? cond.in.includes(row[key]) : row[key] === cond,
  );
}

/** In-memory reservation + session tables; a transaction that throws rolls both back. */
function fakeDb(reservations: Record<string, any>[], sessions: Record<string, any>[]) {
  const db = { reservations, sessions };
  const table = (rows: () => Record<string, any>[]) => ({
    findFirst: vi.fn(async ({ where }) => rows().find((r) => matches(r, where)) ?? null),
    findMany: vi.fn(async ({ where }) => rows().filter((r) => matches(r, where))),
    findUniqueOrThrow: vi.fn(async ({ where }) => {
      const row = rows().find((r) => matches(r, where));
      if (!row) throw new Error('not found');
      return { ...row };
    }),
    updateMany: vi.fn(async ({ where, data }) => {
      const hit = rows().filter((r) => matches(r, where));
      for (const r of hit) Object.assign(r, data);
      return { count: hit.length };
    }),
  });
  const client: Record<string, any> = {
    gamerProfile: { findUnique: vi.fn(async () => ({ id: 'g1' })) },
    reservation: table(() => db.reservations),
    session: table(() => db.sessions),
  };
  client.$transaction = vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
    const snapshot = structuredClone({ reservations: db.reservations, sessions: db.sessions });
    try {
      return await fn(client);
    } catch (err) {
      db.reservations.splice(0, Infinity, ...snapshot.reservations);
      db.sessions.splice(0, Infinity, ...snapshot.sessions);
      throw err;
    }
  });
  return client;
}

describe('ReservationsService.cancel', () => {
  const future = () => new Date(Date.now() + 60 * 60_000);
  const opened = () => ({ startTime: new Date(Date.now() - 10 * 60_000), endTime: new Date(Date.now() + 50 * 60_000) });

  let reservations: Record<string, any>[];
  let sessions: Record<string, any>[];
  let service: ReservationsService;

  function setup(reservation: Record<string, unknown>, sessionRows: Record<string, unknown>[] = []) {
    reservations = [{ id: 'r1', gamerProfileId: 'g1', machineId: MACHINE_ID, status: 'CONFIRMED', startTime: future(), ...reservation }];
    sessions = sessionRows.map((s, i) => ({ id: `s${i + 1}`, reservationId: 'r1', pinUsedAt: null, ...s }));
    service = new ReservationsService(new ReservationsRepository(fakeDb(reservations, sessions) as any));
  }

  it.each(['PENDING', 'CONFIRMED'])('cancels a %s reservation that has not started', async (status) => {
    setup({ status });
    await expect(service.cancel(GAMER, 'r1')).resolves.toMatchObject({ id: 'r1', status: 'CANCELLED' });
    expect(reservations[0].status).toBe('CANCELLED');
  });

  it('cancels an opened reservation whose only session is an unused PIN, and burns the PIN', async () => {
    setup({ ...opened() }, [{ status: 'PENDING', pinHash: '$argon2id$hash', pinExpiresAt: new Date(Date.now() + 5 * 60_000) }]);

    await expect(service.cancel(GAMER, 'r1')).resolves.toMatchObject({ status: 'CANCELLED' });

    expect(reservations[0].status).toBe('CANCELLED');
    // No hash and no longer PENDING: session-billing's login (PENDING + CONFIRMED reservation + pinHash) cannot redeem it.
    expect(sessions[0]).toMatchObject({ status: 'CANCELLED', pinHash: null });
  });

  it.each([
    ['ACTIVE', { status: 'ACTIVE' }],
    ['PAUSED', { status: 'PAUSED' }],
    ['PENDING with its PIN already spent', { status: 'PENDING', pinUsedAt: new Date(), pinHash: null }],
  ])('409s SESSION_IN_PROGRESS for a %s session and changes nothing', async (_label, session) => {
    setup({ ...opened() }, [session, { status: 'PENDING', pinHash: '$argon2id$other' }]);

    await expect(service.cancel(GAMER, 'r1')).rejects.toMatchObject({
      response: { code: 'SESSION_IN_PROGRESS', error: 'end the session instead' },
    });

    expect(reservations[0].status).toBe('CONFIRMED');
    // The PIN burn rolled back with the rest of the transaction.
    expect(sessions[1]).toMatchObject({ status: 'PENDING', pinHash: '$argon2id$other' });
  });

  it.each(['ACTIVE', 'COMPLETED', 'CANCELLED', 'NO_SHOW'])('refuses to cancel a %s reservation', async (status) => {
    setup({ status });
    await expect(service.cancel(GAMER, 'r1')).rejects.toMatchObject({ response: { code: 'RESERVATION_NOT_CANCELLABLE' } });
    expect(reservations[0].status).toBe(status);
  });

  it('refuses when the reservation left CONFIRMED between the read and the cancel', async () => {
    setup({ ...opened() });
    const repo = (service as any).reservations as ReservationsRepository;
    const findOwned = repo.findOwned.bind(repo);
    vi.spyOn(repo, 'findOwned').mockImplementationOnce(async (...args) => {
      const row = await findOwned(...args);
      reservations[0].status = 'ACTIVE'; // session activated meanwhile
      return row;
    });
    await expect(service.cancel(GAMER, 'r1')).rejects.toMatchObject({ response: { code: 'RESERVATION_NOT_CANCELLABLE' } });
  });

  it('404s a reservation the caller does not own', async () => {
    setup({ gamerProfileId: 'someone-else' });
    await expect(service.cancel(GAMER, 'r1')).rejects.toMatchObject({ response: { code: 'RESERVATION_NOT_FOUND' } });
  });
});
