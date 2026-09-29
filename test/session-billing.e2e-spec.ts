import { randomUUID } from 'node:crypto';

import { hash } from '@node-rs/argon2';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import type { Redis } from 'ioredis';
import WebSocket from 'ws';

import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';
import { REDIS } from '../src/infra/redis/redis.module.js';
import { makeFrame } from '../src/infra/realtime/frame.js';
import type { OutboundEnvelope } from '../src/infra/realtime/envelope.js';
import { SYSTEM_ACTOR_ID } from '../src/modules/ops/services/commands.service.js';
import { SessionsService } from '../src/modules/session-billing/services/sessions.service.js';
import { mintStationToken } from './station-token.js';

describe('session billing (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let baseUrl: string;
  let branchId: string;
  let otherBranchId: string;
  let staffToken: string;
  let adminToken: string;
  let otherToken: string;
  let membershipPlanId: string;

  const password = 'super-secret-1';
  const usernames: string[] = [];
  const branchIds: string[] = [];

  const as = (token: string) => ({ authorization: `Bearer ${token}` });

  async function createGamer(): Promise<{ username: string; profileId: string; token: string }> {
    const username = `sb-gamer-${randomUUID()}`;
    usernames.push(username);
    await app.inject({ method: 'POST', url: '/users', payload: { username, password } });
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { username, password } });
    const user = await prisma.user.findUniqueOrThrow({ where: { username }, include: { gamerProfile: true } });
    return { username, profileId: user.gamerProfile!.id, token: login.json().accessToken };
  }

  async function createMachine(branch = branchId) {
    return prisma.machine.create({
      data: { serialNumber: `SB-${randomUUID()}`, branchId: branch, agentPublicKey: '', enrollmentStatus: 'ENROLLED' },
    });
  }

  async function createConfirmedReservation(gamerProfileId: string, machineId: string, overrides: Record<string, unknown> = {}) {
    const startTime = new Date();
    const endTime = new Date(startTime.getTime() + 60 * 60_000);
    return prisma.reservation.create({
      data: { gamerProfileId, machineId, startTime, endTime, status: 'CONFIRMED', ...overrides },
    });
  }

  async function creditWallet(gamerProfileId: string, amount: number) {
    await app.inject({ method: 'POST', url: `/wallets/${gamerProfileId}/credit`, headers: as(adminToken), payload: { amount } });
  }

  async function walletBalance(gamerProfileId: string): Promise<number> {
    return (await app.inject({ method: 'GET', url: `/wallets/${gamerProfileId}`, headers: as(adminToken) })).json().balance;
  }

  /** Minimal fake agent: acks every command it receives, and exposes `send` for heartbeat/state_report. */
  async function connectAgent(machine: { id: string; serialNumber: string; branchId: string }) {
    const stationToken = mintStationToken(app, machine);
    const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/agent-ws`, {
      headers: { authorization: `Bearer ${stationToken}` },
    });
    const commands: OutboundEnvelope[] = [];
    let seq = 0;
    let handshaken = false;
    const send = (type: string, payload: unknown) =>
      socket.send(makeFrame({ type, id: randomUUID(), ts: new Date().toISOString(), seq: ++seq, payload }));

    socket.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as OutboundEnvelope;
      if (frame.type === 'handshake_ack') handshaken = true;
      if (!['LOCK', 'UNLOCK', 'SHUTDOWN', 'LAUNCH_GAME', 'END_SESSION', 'CATALOG_UPDATE'].includes(frame.type)) return;
      commands.push(frame);
      send('command_ack', { commandId: frame.id });
    });
    await new Promise((resolve, reject) => {
      socket.on('open', resolve);
      socket.on('error', reject);
    });
    send('handshake', { serialNumber: machine.serialNumber });
    await vi.waitFor(() => expect(handshaken).toBe(true));
    return { socket, commands, send };
  }

  const start = (reservationId: string, token = staffToken) =>
    app.inject({ method: 'POST', url: '/sessions', headers: as(token), payload: { reservationId } });

  const get = (id: string, token = staffToken) =>
    app.inject({ method: 'GET', url: `/sessions/${id}`, headers: as(token) });

  const end = (id: string, reason?: string, token = staffToken) =>
    app.inject({ method: 'POST', url: `/sessions/${id}/end`, headers: as(token), payload: reason ? { reason } : {} });

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;

    prisma = app.get(PrismaService);
    redis = app.get<Redis>(REDIS);

    branchId = (await prisma.branch.create({ data: { name: `sb-${randomUUID()}`, location: 'test' } })).id;
    otherBranchId = (await prisma.branch.create({ data: { name: `sb-o-${randomUUID()}`, location: 'test' } })).id;
    branchIds.push(branchId, otherBranchId);

    const passwordHash = await hash(password);
    await prisma.user.create({ data: { username: `sb-admin-${randomUUID()}`, passwordHash, role: 'ADMIN' } }).then(async (u) => {
      usernames.push(u.username);
    });
    const staffUsername = `sb-staff-${randomUUID()}`;
    const otherStaffUsername = `sb-staff-other-${randomUUID()}`;
    usernames.push(staffUsername, otherStaffUsername);
    await prisma.user.create({
      data: { username: staffUsername, passwordHash, role: 'EMPLOYEE', employeeProfile: { create: { managedBranchId: branchId, hireDate: new Date() } } },
    });
    await prisma.user.create({
      data: { username: otherStaffUsername, passwordHash, role: 'EMPLOYEE', employeeProfile: { create: { managedBranchId: otherBranchId, hireDate: new Date() } } },
    });

    const login = async (username: string) =>
      (await app.inject({ method: 'POST', url: '/auth/login', payload: { username, password } })).json().accessToken;
    adminToken = await login(usernames[0]);
    staffToken = await login(staffUsername);
    otherToken = await login(otherStaffUsername);

    await app.inject({ method: 'PUT', url: `/branches/${branchId}/pricing`, headers: as(adminToken), payload: { paygRate: 6000, bookingRate: 9000 } });

    const plan = await app.inject({
      method: 'POST',
      url: '/membership-plans',
      headers: as(adminToken),
      payload: { name: `sb-gold-${randomUUID()}`, price: 0, durationDays: 30, discountPercent: 10 },
    });
    membershipPlanId = plan.json().id;
  }, 30_000);

  afterAll(async () => {
    const machines = await prisma.machine.findMany({ where: { branchId: { in: branchIds } } });
    if (machines.length) await redis.del(...machines.map((m) => `node:${m.serialNumber}`));
    await prisma.user.deleteMany({ where: { username: { in: usernames } } });
    await prisma.membershipPlan.deleteMany({ where: { id: membershipPlanId } });
    await prisma.branch.deleteMany({ where: { id: { in: branchIds } } });
    await app.close();
  });

  it('starts a session at the branch payg rate and sends a booking UNLOCK with a fresh PIN', async () => {
    const gamer = await createGamer();
    const machine = await createMachine();
    const reservation = await createConfirmedReservation(gamer.profileId, machine.id);
    const agent = await connectAgent(machine);

    const res = await start(reservation.id);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ status: 'PENDING', rateCentsPerMinute: 100, appliedMembershipId: null });
    expect(body.pin).toMatch(/^\d{4}$/);

    await vi.waitFor(() => expect(agent.commands).toHaveLength(1));
    expect(agent.commands[0]).toMatchObject({ type: 'UNLOCK', payload: { sessionId: body.id, pin: body.pin } });

    agent.socket.close();
  });

  it('rejects a second session for a reservation that already has an open one', async () => {
    const gamer = await createGamer();
    const machine = await createMachine();
    const reservation = await createConfirmedReservation(gamer.profileId, machine.id);
    const agent = await connectAgent(machine);

    const first = await start(reservation.id);
    expect(first.statusCode).toBe(201);

    const second = await start(reservation.id);
    expect(second.statusCode).toBe(409);
    expect(second.json().code).toBe('SESSION_ALREADY_STARTED');

    agent.socket.close();
  });

  it('runs the full lifecycle: PENDING -> ACTIVE -> PAUSED -> ACTIVE, then settles on session end', async () => {
    const gamer = await createGamer();
    await creditWallet(gamer.profileId, 100_000);
    const machine = await createMachine();
    const reservation = await createConfirmedReservation(gamer.profileId, machine.id);
    const agent = await connectAgent(machine);

    const { id: sessionId } = (await start(reservation.id)).json();

    agent.send('heartbeat', { locked: false, sessionId });
    await vi.waitFor(async () => expect((await get(sessionId)).json().status).toBe('ACTIVE'));

    await new Promise((r) => setTimeout(r, 1100));
    agent.send('heartbeat', { locked: true, sessionId });
    await vi.waitFor(async () => {
      const paused = (await get(sessionId)).json();
      expect(paused.status).toBe('PAUSED');
      expect(paused.meteredSeconds).toBeGreaterThanOrEqual(1);
    });
    const pausedSeconds = (await get(sessionId)).json().meteredSeconds;

    agent.send('heartbeat', { locked: false, sessionId });
    await vi.waitFor(async () => expect((await get(sessionId)).json().status).toBe('ACTIVE'));

    const before = await walletBalance(gamer.profileId);
    const endRes = await end(sessionId, 'closing');
    expect(endRes.statusCode).toBe(202);
    await vi.waitFor(() => expect(agent.commands.some((c) => c.type === 'END_SESSION')).toBe(true));
    expect(agent.commands.find((c) => c.type === 'END_SESSION')).toMatchObject({ payload: { reason: 'closing' } });

    // The ack alone changes nothing; settlement only runs once the station reports the session gone.
    expect((await get(sessionId)).json().status).toBe('ACTIVE');
    agent.send('heartbeat', { locked: true, sessionId: null });

    await vi.waitFor(async () => expect((await get(sessionId)).json().status).toBe('COMPLETED'));
    const settled = (await get(sessionId)).json();
    expect(settled.meteredSeconds).toBeGreaterThanOrEqual(pausedSeconds);
    expect(settled.billingBreakdown).toMatchObject({ rateCentsPerMinute: 100, totalCents: Math.round((settled.meteredSeconds / 60) * 100) });
    expect(await walletBalance(gamer.profileId)).toBe(before - settled.billingBreakdown.totalCents);

    const again = await end(sessionId);
    expect(again.statusCode).toBe(409);
    expect(again.json().code).toBe('SESSION_NOT_OPEN');

    agent.socket.close();
  });

  it('still completes the session, flagged, when settlement cannot cover the metered amount', async () => {
    const gamer = await createGamer(); // zero balance
    const machine = await createMachine();
    const reservation = await createConfirmedReservation(gamer.profileId, machine.id);
    const agent = await connectAgent(machine);

    const { id: sessionId } = (await start(reservation.id)).json();
    agent.send('heartbeat', { locked: false, sessionId });
    await vi.waitFor(async () => expect((await get(sessionId)).json().status).toBe('ACTIVE'));
    await new Promise((r) => setTimeout(r, 1100));

    await end(sessionId);
    await vi.waitFor(() => expect(agent.commands.some((c) => c.type === 'END_SESSION')).toBe(true));
    agent.send('heartbeat', { locked: true, sessionId: null });

    await vi.waitFor(async () => expect((await get(sessionId)).json().status).toBe('COMPLETED'));
    expect((await get(sessionId)).json().billingBreakdown).toMatchObject({ debitFailed: true });
    expect(await walletBalance(gamer.profileId)).toBe(0);

    agent.socket.close();
  });

  it('applies an active membership discount to the rate and records it on the session', async () => {
    const gamer = await createGamer();
    await app.inject({
      method: 'POST',
      url: `/membership-plans/${membershipPlanId}/purchase`,
      headers: as(gamer.token),
      payload: {},
    });
    const machine = await createMachine();
    const reservation = await createConfirmedReservation(gamer.profileId, machine.id);
    const agent = await connectAgent(machine);

    const body = (await start(reservation.id)).json();
    expect(body.rateCentsPerMinute).toBe(90); // 6000c/hr * 0.9 = 5400c/hr = 90c/min
    const membership = await prisma.membership.findFirstOrThrow({ where: { gamerProfileId: gamer.profileId } });
    expect(body.appliedMembershipId).toBe(membership.id);

    agent.socket.close();
  });

  it('still returns a session with a PIN when the station has no connected agent', async () => {
    const gamer = await createGamer();
    const machine = await createMachine(); // no agent connected
    const reservation = await createConfirmedReservation(gamer.profileId, machine.id);

    const res = await start(reservation.id);
    expect(res.statusCode).toBe(201);
    expect(res.json().pin).toMatch(/^\d{4}$/);
    expect(await prisma.command.count({ where: { machineId: machine.id } })).toBe(0);
  });

  it('404s for an unknown reservation and 409s a reservation that is not CONFIRMED', async () => {
    const missing = await start(randomUUID());
    expect(missing.statusCode).toBe(404);
    expect(missing.json().code).toBe('RESERVATION_NOT_FOUND');

    const gamer = await createGamer();
    const machine = await createMachine();
    const pending = await prisma.reservation.create({
      data: { gamerProfileId: gamer.profileId, machineId: machine.id, startTime: new Date(), endTime: new Date(Date.now() + 3_600_000) },
    });
    const res = await start(pending.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('RESERVATION_NOT_CONFIRMED');
  });

  it('keeps sessions branch-scoped: cross-branch start and get are rejected', async () => {
    const gamer = await createGamer();
    const machine = await createMachine();
    const reservation = await createConfirmedReservation(gamer.profileId, machine.id);

    const crossStart = await start(reservation.id, otherToken);
    expect(crossStart.statusCode).toBe(403);

    const agent = await connectAgent(machine);
    const { id: sessionId } = (await start(reservation.id)).json();
    const crossGet = await get(sessionId, otherToken);
    expect(crossGet.statusCode).toBe(403);

    agent.socket.close();
  });

  it('lockForRunout issues a system LOCK for the session station, distinct from a staff-issued one', async () => {
    const gamer = await createGamer();
    const machine = await createMachine();
    const reservation = await createConfirmedReservation(gamer.profileId, machine.id);
    const agent = await connectAgent(machine);

    const { id: sessionId } = (await start(reservation.id)).json();
    agent.send('heartbeat', { locked: false, sessionId });
    await vi.waitFor(async () => expect((await get(sessionId)).json().status).toBe('ACTIVE'));

    await app.get(SessionsService).lockForRunout(sessionId);
    await vi.waitFor(() => expect(agent.commands.some((c) => c.type === 'LOCK')).toBe(true));

    const list = (await app.inject({ method: 'GET', url: `/api/v1/stations/${machine.id}/commands`, headers: as(staffToken) })).json();
    const lockCommand = list.find((c: { type: string }) => c.type === 'LOCK');
    expect(lockCommand.issuedBy).toBe(SYSTEM_ACTOR_ID);

    agent.send('heartbeat', { locked: true, sessionId });
    await vi.waitFor(async () => expect((await get(sessionId)).json().status).toBe('PAUSED'));

    agent.socket.close();
  });
});