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

  /**
   * Minimal fake agent: acks every command it receives, records login_result
   * and heartbeat_ack frames, and exposes `send` for any agent frame.
   */
  async function connectAgent(machine: { id: string; serialNumber: string; branchId: string }) {
    const stationToken = mintStationToken(app, machine);
    const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/agent-ws`, {
      headers: { authorization: `Bearer ${stationToken}` },
    });
    const commands: OutboundEnvelope<Record<string, unknown>>[] = [];
    const loginResults: OutboundEnvelope<{ requestId: string; accepted: boolean; reason?: string }>[] = [];
    const heartbeatAcks: OutboundEnvelope<{ leaseSeconds: number; serverTime: string }>[] = [];
    let seq = 0;
    let handshaken = false;
    const send = (type: string, payload: unknown, id: string = randomUUID()) =>
      socket.send(makeFrame({ type, id, ts: new Date().toISOString(), seq: ++seq, payload }));

    socket.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString());
      if (frame.type === 'handshake_ack') handshaken = true;
      if (frame.type === 'login_result') loginResults.push(frame);
      if (frame.type === 'heartbeat_ack') heartbeatAcks.push(frame);
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
    return { socket, commands, loginResults, heartbeatAcks, send };
  }

  type Agent = Awaited<ReturnType<typeof connectAgent>>;

  /** The lock screen relays a PIN; resolves with the login_result answering it. */
  async function typePin(agent: Agent, credential: string) {
    const requestId = randomUUID();
    agent.send('login_request', { method: 'pin', credential }, requestId);
    await vi.waitFor(() => expect(agent.loginResults.some((r) => r.payload?.requestId === requestId)).toBe(true));
    return agent.loginResults.find((r) => r.payload?.requestId === requestId)!.payload!;
  }

  /** Start + accepted login + the agent reporting itself unlocked: the session is ACTIVE. */
  async function startAndLogIn(agent: Agent, reservationId: string): Promise<string> {
    const { id: sessionId, pin } = (await start(reservationId)).json();
    expect(await typePin(agent, pin)).toMatchObject({ accepted: true });
    await vi.waitFor(() => expect(agent.commands.some((c) => c.type === 'UNLOCK')).toBe(true));
    agent.send('heartbeat', { locked: false, sessionId });
    await vi.waitFor(async () => expect((await get(sessionId)).json().status).toBe('ACTIVE'));
    return sessionId;
  }

  const wrongPin = (pin: string) => (pin === '000000' ? '111111' : '000000');

  const reservationStatus = async (id: string) => (await prisma.reservation.findUniqueOrThrow({ where: { id } })).status;

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

  it('starts a PENDING session at the payg rate, returns the PIN once, stores only its hash, and sends nothing', async () => {
    const gamer = await createGamer();
    const machine = await createMachine();
    const reservation = await createConfirmedReservation(gamer.profileId, machine.id);
    const agent = await connectAgent(machine);

    const res = await start(reservation.id);
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({ status: 'PENDING', rateCentsPerMinute: 100, appliedMembershipId: null });
    expect(body.pin).toMatch(/^\d{6}$/);

    const row = await prisma.session.findUniqueOrThrow({ where: { id: body.id } });
    expect(row.pinHash).toMatch(/^\$argon2id\$/);
    expect(row.pinHash).not.toContain(body.pin);
    expect(row.pinExpiresAt!.getTime()).toBeLessThanOrEqual(reservation.endTime.getTime());
    expect((await get(body.id)).json()).not.toHaveProperty('pin');

    await new Promise((r) => setTimeout(r, 300));
    expect(agent.commands).toHaveLength(0);
    expect(await prisma.command.count({ where: { machineId: machine.id } })).toBe(0);

    agent.socket.close();
  });

  it('unlocks only after an accepted login: login_result first, then UNLOCK with a lease and no PIN', async () => {
    const gamer = await createGamer();
    const machine = await createMachine();
    const reservation = await createConfirmedReservation(gamer.profileId, machine.id);
    const agent = await connectAgent(machine);
    const { id: sessionId, pin } = (await start(reservation.id)).json();

    expect(await typePin(agent, wrongPin(pin))).toEqual({ requestId: expect.any(String), accepted: false, reason: 'invalid_pin' });
    await new Promise((r) => setTimeout(r, 300));
    expect(agent.commands).toHaveLength(0);

    expect(await typePin(agent, pin)).toEqual({ requestId: expect.any(String), accepted: true });
    await vi.waitFor(() => expect(agent.commands).toHaveLength(1));
    const unlock = agent.commands[0];
    expect(unlock).toMatchObject({ type: 'UNLOCK', payload: { sessionId, leaseSeconds: expect.any(Number), serverTime: expect.any(String) } });
    expect(unlock.payload).not.toHaveProperty('pin');
    expect(unlock.payload!.leaseSeconds).toBeGreaterThan(0);

    // Single use: the same PIN never opens it again.
    expect(await typePin(agent, pin)).toMatchObject({ accepted: false, reason: 'pin_used' });
    // Active only once the station reports itself unlocked, never from the ack.
    expect((await get(sessionId)).json().status).toBe('PENDING');
    expect(await reservationStatus(reservation.id)).toBe('CONFIRMED');

    agent.socket.close();
  });

  it('burns the PIN after too many wrong attempts', async () => {
    const gamer = await createGamer();
    const machine = await createMachine();
    const reservation = await createConfirmedReservation(gamer.profileId, machine.id);
    const agent = await connectAgent(machine);
    const { pin } = (await start(reservation.id)).json();

    for (let i = 0; i < 5; i++) expect(await typePin(agent, wrongPin(pin))).toMatchObject({ accepted: false, reason: 'invalid_pin' });
    expect(await typePin(agent, pin)).toMatchObject({ accepted: false, reason: 'too_many_attempts' });
    expect(agent.commands).toHaveLength(0);

    agent.socket.close();
  });

  it('renews a non-null lease on every heartbeat_ack, zero when the station holds no session', async () => {
    const gamer = await createGamer();
    const machine = await createMachine();
    const reservation = await createConfirmedReservation(gamer.profileId, machine.id);
    const agent = await connectAgent(machine);

    agent.send('heartbeat', { locked: true, sessionId: null });
    await vi.waitFor(() => expect(agent.heartbeatAcks).toHaveLength(1));
    expect(agent.heartbeatAcks[0].payload).toEqual({ leaseSeconds: 0, serverTime: expect.any(String) });

    const sessionId = await startAndLogIn(agent, reservation.id);
    const acked = agent.heartbeatAcks.length;
    agent.send('heartbeat', { locked: false, sessionId });
    await vi.waitFor(() => expect(agent.heartbeatAcks.length).toBeGreaterThan(acked));
    const lease = agent.heartbeatAcks[agent.heartbeatAcks.length - 1].payload!;
    expect(lease.leaseSeconds).toBeGreaterThan(0);
    expect(lease.leaseSeconds).toBeLessThanOrEqual(180); // the cap; the window has ~60 minutes left

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

    const sessionId = await startAndLogIn(agent, reservation.id);
    expect(await reservationStatus(reservation.id)).toBe('ACTIVE');

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

    expect(await reservationStatus(reservation.id)).toBe('COMPLETED');

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

    const sessionId = await startAndLogIn(agent, reservation.id);
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

  it('409s starting a session on a station that is not online', async () => {
    const gamer = await createGamer();
    const machine = await createMachine(); // no agent connected
    const reservation = await createConfirmedReservation(gamer.profileId, machine.id);

    const res = await start(reservation.id);
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('STATION_OFFLINE');
    expect(await prisma.session.count({ where: { reservationId: reservation.id } })).toBe(0);
  });

  it('state_report on reconnect re-grants an open in-window session, and ends one that closed meanwhile', async () => {
    const gamer = await createGamer();
    const machine = await createMachine();
    const reservation = await createConfirmedReservation(gamer.profileId, machine.id);
    const first = await connectAgent(machine);
    const sessionId = await startAndLogIn(first, reservation.id);
    first.socket.close();

    const resumed = await connectAgent(machine);
    resumed.send('state_report', { locked: true, sessionId, runningGameId: null, leaseExpiresAt: null });
    await vi.waitFor(() => expect(resumed.commands.some((c) => c.type === 'UNLOCK')).toBe(true));
    expect(resumed.commands.find((c) => c.type === 'UNLOCK')).toMatchObject({
      payload: { sessionId, leaseSeconds: expect.any(Number), serverTime: expect.any(String) },
    });
    resumed.socket.close();

    await prisma.session.update({ where: { id: sessionId }, data: { status: 'COMPLETED' } });
    const ended = await connectAgent(machine);
    ended.send('state_report', { locked: false, sessionId, runningGameId: null, leaseExpiresAt: null });
    await vi.waitFor(() => expect(ended.commands.some((c) => c.type === 'END_SESSION')).toBe(true));
    expect(ended.commands.some((c) => c.type === 'UNLOCK')).toBe(false);
    ended.socket.close();
  });

  it('sweep marks a reservation whose window passed without a login NO_SHOW and cancels its PENDING session', async () => {
    const gamer = await createGamer();
    const machine = await createMachine();
    const endTime = new Date(Date.now() - 60_000);
    const reservation = await createConfirmedReservation(gamer.profileId, machine.id, {
      startTime: new Date(endTime.getTime() - 3_600_000),
      endTime,
    });
    const session = await prisma.session.create({
      data: { reservationId: reservation.id, startTime: reservation.startTime, endTime, rateCentsPerMinute: 100, pinHash: 'x', pinExpiresAt: endTime },
    });

    await app.get(SessionsService).sweep();

    expect(await reservationStatus(reservation.id)).toBe('NO_SHOW');
    expect(await prisma.session.findUniqueOrThrow({ where: { id: session.id } })).toMatchObject({ status: 'CANCELLED', pinHash: null });
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

    const sessionId = await startAndLogIn(agent, reservation.id);

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