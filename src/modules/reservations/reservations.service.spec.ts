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

  it('needs the PC online for Play now only: a booking for later just needs it enrolled', async () => {
    tx.machine.findUnique.mockResolvedValue({ id: MACHINE_ID, enrollmentStatus: 'ENROLLED', status: 'OFFLINE' });
    expect(await repo.createIfAvailable('g1', slot(), true)).toEqual({ kind: 'machine_unavailable' });
    const later = { ...slot(), startTime: new Date(Date.now() + 60 * 60_000), endTime: new Date(Date.now() + 2 * 60 * 60_000) };
    expect(await repo.createIfAvailable('g1', later)).toMatchObject({ kind: 'created', reservation: { isWalkIn: false } });
  });

  it('marks Play now bookings as walk-ins', async () => {
    expect(await repo.createIfAvailable('g1', slot(), true)).toMatchObject({ kind: 'created', reservation: { isWalkIn: true } });
  });

  it('refuses a booking that overlaps another one of the same gamer, on any PC', async () => {
    tx.reservation.findFirst.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: 'mine-elsewhere' });
    expect(await repo.createIfAvailable('g1', slot(), true)).toEqual({ kind: 'gamer_busy' });
    expect(tx.reservation.findFirst.mock.calls[1][0].where).toMatchObject({ gamerProfileId: 'g1' });
    expect(tx.reservation.create).not.toHaveBeenCalled();
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
    service = new ReservationsService(repo as any, {} as any, {} as any);
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

describe('ReservationsService for the desk', () => {
  const STAFF = { sub: 's1', role: 'EMPLOYEE', scope: 'staff', branchId: 'b1', jti: 'j' } as AccessTokenPayload;
  const HQ = { sub: 'h1', role: 'ADMIN', scope: 'hq', branchId: null, jti: 'j' } as AccessTokenPayload;
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let service: ReservationsService;

  beforeEach(() => {
    repo = {
      listForStaff: vi.fn(async () => [{ id: 'r1', gamerProfile: { id: 'g1', user: { username: 'ali' } } }]),
      findForStaff: vi.fn(async () => ({ id: 'r1', status: 'CONFIRMED', machine: { branchId: 'b1' }, sessions: [] })),
      cancel: vi.fn(async (id) => ({ id, status: 'CANCELLED' })),
    };
    service = new ReservationsService(repo as any, {} as any, {} as any);
  });

  it("lists the caller's branch with who booked, HQ any branch or all", async () => {
    await expect(service.listForStaff(STAFF, { limit: 200 })).resolves.toEqual([{ id: 'r1', gamerUsername: 'ali' }]);
    expect(repo.listForStaff).toHaveBeenLastCalledWith(expect.objectContaining({ branchId: 'b1' }));
    await service.listForStaff(HQ, { limit: 200 });
    expect(repo.listForStaff).toHaveBeenLastCalledWith(expect.objectContaining({ branchId: null }));
    await expect(service.listForStaff(STAFF, { limit: 200, branchId: '00000000-0000-0000-0000-000000000009' })).rejects.toThrow();
  });

  it('cancels a booking nobody plays on, never a running one or another branch’s', async () => {
    await expect(service.cancelByStaff(STAFF, 'r1')).resolves.toMatchObject({ status: 'CANCELLED' });
    repo.findForStaff.mockResolvedValueOnce({ id: 'r1', status: 'CONFIRMED', machine: { branchId: 'b1' }, sessions: [{ id: 's' }] });
    await expect(service.cancelByStaff(STAFF, 'r1')).rejects.toMatchObject({ response: { code: 'SESSION_RUNNING' } });
    repo.findForStaff.mockResolvedValueOnce({ id: 'r1', status: 'CONFIRMED', machine: { branchId: 'b2' }, sessions: [] });
    await expect(service.cancelByStaff(STAFF, 'r1')).rejects.toThrow();
    expect(repo.cancel).toHaveBeenCalledTimes(1);
  });
});

describe('ReservationsService walk-in and check-in', () => {
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let sessions: Record<string, ReturnType<typeof vi.fn>>;
  let membership: { getBookingAdvanceDays: ReturnType<typeof vi.fn> };
  let service: ReservationsService;
  const pin = { sessionId: 's1', reservationId: 'r1', pin: '123456', pinExpiresAt: new Date() };

  beforeEach(() => {
    repo = {
      findGamerProfileId: vi.fn(async () => ({ id: 'g1' })),
      createIfAvailable: vi.fn(async () => ({ kind: 'created', reservation: { id: 'r1', status: 'CONFIRMED' } })),
      findMachine: vi.fn(async () => ({ id: MACHINE_ID, branchId: 'b1' })),
    };
    sessions = {
      checkIn: vi.fn(async () => pin),
      assertAffordable: vi.fn(async () => ({ centsPerMinute: 100, totalCents: 6000, membershipId: null })),
      extend: vi.fn(async () => ({ endsAt: 'x' })),
      extendOptions: vi.fn(async () => ({ options: [] })),
    };
    membership = { getBookingAdvanceDays: vi.fn(async () => 0) };
    service = new ReservationsService(repo as any, sessions as any, membership as any);
  });

  const inHours = (h: number) => new Date(Date.now() + h * 60 * 60_000);
  const booking = (startHours: number) => ({ machineId: MACHINE_ID, startTime: inHours(startHours), endTime: inHours(startHours + 1) });

  it('lets anyone book the next 24 hours, and further only as far as their plan allows', async () => {
    await expect(service.create(GAMER, booking(20))).resolves.toMatchObject({ id: 'r1' });
    await expect(service.create(GAMER, booking(30))).rejects.toMatchObject({ response: { code: 'BOOKING_TOO_FAR_AHEAD' } });

    membership.getBookingAdvanceDays.mockResolvedValue(7);
    await expect(service.create(GAMER, booking(6 * 24))).resolves.toMatchObject({ id: 'r1' });
    await expect(service.create(GAMER, booking(8 * 24))).rejects.toMatchObject({ response: { code: 'BOOKING_TOO_FAR_AHEAD' } });
  });

  it('refuses a booking or walk-in the wallet cannot pay for, before anything is created', async () => {
    sessions.assertAffordable.mockRejectedValue(new ConflictException({ code: 'INSUFFICIENT_FUNDS' }));
    await expect(service.create(GAMER, booking(2))).rejects.toMatchObject({ response: { code: 'INSUFFICIENT_FUNDS' } });
    await expect(service.walkIn(GAMER, { machineId: MACHINE_ID, durationMinutes: 60 })).rejects.toMatchObject({
      response: { code: 'INSUFFICIENT_FUNDS' },
    });
    expect(repo.createIfAvailable).not.toHaveBeenCalled();
  });

  it('quotes a booking at the booking rate and a walk-in at the walk-in rate, for their length', async () => {
    await service.create(GAMER, booking(2));
    expect(sessions.assertAffordable).toHaveBeenLastCalledWith(expect.objectContaining({ gamerProfileId: 'g1', branchId: 'b1', isWalkIn: false, minutes: 60 }));
    await service.walkIn(GAMER, { machineId: MACHINE_ID, durationMinutes: 90 });
    expect(sessions.assertAffordable).toHaveBeenLastCalledWith(expect.objectContaining({ isWalkIn: true, minutes: 90 }));
  });

  it('extends on the caller’s own gamer profile', async () => {
    await service.extend(GAMER, 'r1', 30);
    expect(sessions.extend).toHaveBeenCalledWith('g1', 'r1', 30);
  });

  it('refuses a second booking overlapping one the gamer already holds', async () => {
    repo.createIfAvailable.mockResolvedValueOnce({ kind: 'gamer_busy' });
    await expect(service.create(GAMER, booking(2))).rejects.toMatchObject({ response: { code: 'GAMER_ALREADY_BOOKED' } });
  });

  it('gives the walk-in gamer their PIN in the same answer', async () => {
    await expect(service.walkIn(GAMER, { machineId: MACHINE_ID, durationMinutes: 60 })).resolves.toMatchObject({ id: 'r1', checkIn: pin });
    expect(sessions.checkIn).toHaveBeenCalledWith('g1', 'r1');
  });

  it('keeps the walk-in when the PIN cannot be issued yet, without a PIN', async () => {
    sessions.checkIn.mockRejectedValueOnce(new ConflictException({ code: 'STATION_OFFLINE' }));
    await expect(service.walkIn(GAMER, { machineId: MACHINE_ID, durationMinutes: 60 })).resolves.toMatchObject({ id: 'r1', checkIn: null });
  });

  it("checks in on the caller's own gamer profile", async () => {
    await expect(service.checkIn(GAMER, 'r1')).resolves.toBe(pin);
    expect(sessions.checkIn).toHaveBeenCalledWith('g1', 'r1');
  });
});
