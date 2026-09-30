import { randomUUID } from 'node:crypto';

import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, TestingModule } from '@nestjs/testing';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { vi } from 'vitest';

import { ReservationsController } from '../src/modules/reservations/reservations.controller.js';
import { ReservationsService } from '../src/modules/reservations/reservations.service.js';

describe('reservations API', () => {
  let app: NestFastifyApplication;

  const reservations = {
    list: vi.fn(),
    create: vi.fn(),
    walkIn: vi.fn(),
    cancel: vi.fn(),
  };
  const authenticatedGamer: CanActivate = {
    canActivate(context: ExecutionContext) {
      context.switchToHttp().getRequest().user = {
        sub: 'user-1',
        role: 'GAMER',
        scope: 'self',
        branchId: null,
        jti: 'test-token',
      };
      return true;
    },
  };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      controllers: [ReservationsController],
      providers: [{ provide: ReservationsService, useValue: reservations }],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    app.useGlobalGuards(authenticatedGamer);
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    reservations.list.mockResolvedValue([{ id: 'reservation-1', status: 'CONFIRMED' }]);
    reservations.create.mockImplementation((_caller, input) => Promise.resolve({ id: 'reservation-1', ...input }));
    reservations.walkIn.mockResolvedValue({ id: 'walk-in-1', status: 'ACTIVE' });
    reservations.cancel.mockResolvedValue({ id: 'reservation-1', status: 'CANCELLED' });
  });

  afterAll(async () => {
    await app.close();
  });

  it('lists the authenticated gamer reservations', async () => {
    const response = await app.inject({ method: 'GET', url: '/reservations' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual([{ id: 'reservation-1', status: 'CONFIRMED' }]);
    expect(reservations.list).toHaveBeenCalledWith(expect.objectContaining({ sub: 'user-1' }));
  });

  it('creates a future reservation and validates the request body', async () => {
    const startTime = new Date(Date.now() + 60_000).toISOString();
    const endTime = new Date(Date.now() + 120_000).toISOString();
    const response = await app.inject({
      method: 'POST',
      url: '/reservations',
      payload: { machineId: randomUUID(), startTime, endTime },
    });

    expect(response.statusCode).toBe(201);
    expect(reservations.create).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'user-1' }),
      expect.objectContaining({ startTime: new Date(startTime), endTime: new Date(endTime) }),
    );

    const invalid = await app.inject({
      method: 'POST',
      url: '/reservations',
      payload: { machineId: 'not-a-uuid', startTime, endTime },
    });
    expect(invalid.statusCode).toBe(400);
  });

  it('creates a walk-in reservation', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/reservations/walk-in',
      payload: { machineId: randomUUID(), durationMinutes: 30 },
    });

    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ id: 'walk-in-1', status: 'ACTIVE' });
    expect(reservations.walkIn).toHaveBeenCalledWith(
      expect.objectContaining({ sub: 'user-1' }),
      { machineId: expect.any(String), durationMinutes: 30 },
    );
  });

  it('rejects invalid walk-in duration', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/reservations/walk-in',
      payload: { machineId: randomUUID(), durationMinutes: 0 },
    });

    expect(response.statusCode).toBe(400);
    expect(reservations.walkIn).not.toHaveBeenCalled();
  });

  it('cancels a reservation by UUID', async () => {
    const id = randomUUID();
    const response = await app.inject({ method: 'DELETE', url: `/reservations/${id}` });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ id: 'reservation-1', status: 'CANCELLED' });
    expect(reservations.cancel).toHaveBeenCalledWith(expect.objectContaining({ sub: 'user-1' }), id);
  });
});
