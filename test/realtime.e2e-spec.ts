import { randomUUID } from 'node:crypto';

import { hash } from '@node-rs/argon2';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { io as ioClient } from 'socket.io-client';
import type { Redis } from 'ioredis';
import WebSocket from 'ws';

import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';
import { REDIS } from '../src/infra/redis/redis.module.js';
import { DashboardGateway } from '../src/modules/ops/dashboard.gateway.js';
import { makeFrame } from '../src/infra/realtime/frame.js';
import type { OutboundEnvelope } from '../src/infra/realtime/envelope.js';
import { mintStationToken } from './station-token.js';

describe('realtime gateways (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  let branchId: string;
  let accessToken: string;

  const username = `dash-${randomUUID()}`;
  const gamerUsername = `dash-gamer-${randomUUID()}`;
  const password = 'super-secret-1';

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.listen(0, '127.0.0.1');

    const address = app.getHttpServer().address() as { port: number };
    baseUrl = `http://127.0.0.1:${address.port}`;

    prisma = app.get(PrismaService);
    const branch = await prisma.branch.create({ data: { name: `rt-branch-${randomUUID()}`, location: 'test' } });
    branchId = branch.id;

    const passwordHash = await hash(password);
    await prisma.user.create({
      data: {
        username,
        passwordHash,
        role: 'EMPLOYEE',
        employeeProfile: { create: { managedBranchId: branchId, hireDate: new Date() } },
      },
    });

    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { username, password } });
    accessToken = login.json().accessToken;
  }, 30_000);

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { username: { in: [username, gamerUsername] } } });
    const machines = await prisma.machine.findMany({ where: { branchId } });
    if (machines.length) await app.get<Redis>(REDIS).del(...machines.map((m) => `node:${m.serialNumber}`));
    await prisma.branch.delete({ where: { id: branchId } }).catch(() => undefined);
    await app.close();
  });

  // Agent frames carry an ISO-8601 ts, exactly like the .NET desktop agent.
  function envelope(type: string, seq: number, payload: unknown = {}) {
    return { type, id: randomUUID(), ts: new Date().toISOString(), seq, payload };
  }

  async function createMachine(serialNumber: string) {
    return prisma.machine.create({ data: { serialNumber, branchId, agentPublicKey: '', enrollmentStatus: 'ENROLLED' } });
  }

  /** `token` rides on the upgrade request, like the real agent's station JWT. */
  function openAgent(
    token: string | null,
  ): Promise<{ socket: WebSocket; frames: OutboundEnvelope[]; next: () => Promise<OutboundEnvelope> }> {
    const socket = new WebSocket(
      `${baseUrl.replace('http', 'ws')}/agent-ws`,
      token ? { headers: { authorization: `Bearer ${token}` } } : {},
    );
    const frames: OutboundEnvelope[] = [];
    const waiters: ((frame: OutboundEnvelope) => void)[] = [];
    let read = 0;

    socket.on('message', (data: Buffer) => {
      frames.push(JSON.parse(data.toString()) as OutboundEnvelope);
      const waiter = waiters.shift();
      if (waiter) waiter(frames[read++]);
    });
    const next = () =>
      new Promise<OutboundEnvelope>((resolve) => {
        if (read < frames.length) resolve(frames[read++]);
        else waiters.push(resolve);
      });

    return new Promise((resolve, reject) => {
      socket.on('open', () => resolve({ socket, frames, next }));
      socket.on('error', reject);
    });
  }

  function dashboard() {
    const client = ioClient(baseUrl, {
      path: '/dashboard-io',
      reconnection: false,
      forceNew: true,
      auth: { token: accessToken },
    });
    return new Promise<typeof client>((resolve, reject) => {
      client.on('connect', () => resolve(client));
      client.on('connect_error', reject);
    });
  }

  function nextStatus(client: Awaited<ReturnType<typeof dashboard>>, serialNumber: string, status: string) {
    return new Promise<Record<string, unknown>>((resolve) => {
      const handler = (event: Record<string, unknown>) => {
        if (event.serialNumber === serialNumber && event.status === status) {
          client.off('station_status', handler);
          resolve(event);
        }
      };
      client.on('station_status', handler);
    });
  }

  it('tracks a station through handshake, heartbeat, state_report and close', async () => {
    const serialNumber = `STATION-${randomUUID()}`;
    const machine = await createMachine(serialNumber);
    const client = await dashboard();
    const online = nextStatus(client, serialNumber, 'ONLINE');

    const agent = await openAgent(mintStationToken(app, machine));
    agent.socket.send(
      makeFrame(envelope('handshake', 1, { serialNumber, agentVersion: '1.0.0', osVersion: 'test', machineName: 'PC-1' })),
    );

    const handshakeAck = await agent.next();
    expect(handshakeAck.type).toBe('handshake_ack');
    expect(handshakeAck.seq).toBe(1);
    expect(Number.isNaN(Date.parse(handshakeAck.ts))).toBe(false);

    const onlineEvent = await online;
    expect(onlineEvent).toMatchObject({ serialNumber, name: 'PC-1', status: 'ONLINE', branchId, ip: '127.0.0.1' });

    agent.socket.send(
      makeFrame(envelope('state_report', 2, { locked: true, sessionId: null, runningGameId: null, leaseExpiresAt: null })),
    );
    agent.socket.send(makeFrame(envelope('heartbeat', 3, { locked: true, sessionId: null })));
    agent.socket.send(makeFrame(envelope('telemetry', 4, { anything: 1 }))); // unhandled: ignored, no reply
    agent.socket.send(makeFrame(envelope('heartbeat', 5, { locked: false, sessionId: null })));

    // Always a lease, never null; zero while the station holds no session.
    expect(await agent.next()).toMatchObject({ type: 'heartbeat_ack', seq: 2, payload: { leaseSeconds: 0, serverTime: expect.any(String) } });
    expect(await agent.next()).toMatchObject({ type: 'heartbeat_ack', seq: 3, payload: { leaseSeconds: 0, serverTime: expect.any(String) } });

    const auth = { authorization: `Bearer ${accessToken}` };
    const list = await app.inject({ method: 'GET', url: '/api/v1/stations', headers: auth });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toContainEqual(
      expect.objectContaining({ id: machine.id, serialNumber, status: 'ONLINE', locked: false, ip: '127.0.0.1' }),
    );

    const one = await app.inject({ method: 'GET', url: `/api/v1/stations/${machine.id}`, headers: auth });
    expect(one.json()).toMatchObject({ id: machine.id, status: 'ONLINE', branchId });

    const offline = nextStatus(client, serialNumber, 'OFFLINE');
    agent.socket.close();
    await expect(offline).resolves.toMatchObject({ serialNumber, status: 'OFFLINE' });
    expect((await prisma.machine.findUniqueOrThrow({ where: { id: machine.id } })).status).toBe('OFFLINE');

    client.close();
  });

  it('drops a replayed seq without replying', async () => {
    const serialNumber = `STATION-${randomUUID()}`;
    const machine = await createMachine(serialNumber);
    const agent = await openAgent(mintStationToken(app, machine));

    agent.socket.send(makeFrame(envelope('handshake', 1, { serialNumber })));
    expect((await agent.next()).type).toBe('handshake_ack');

    agent.socket.send(makeFrame(envelope('heartbeat', 2, { locked: true, sessionId: null })));
    agent.socket.send(makeFrame(envelope('heartbeat', 2, { locked: true, sessionId: null }))); // replay
    agent.socket.send(makeFrame(envelope('heartbeat', 3, { locked: true, sessionId: null })));

    expect(await agent.next()).toMatchObject({ type: 'heartbeat_ack', seq: 2 });
    expect(await agent.next()).toMatchObject({ type: 'heartbeat_ack', seq: 3 });
    expect(agent.frames.every((f) => !f.type.endsWith('_nack'))).toBe(true);
    agent.socket.close();
  });

  it('watchdog marks a silent station OFFLINE while the socket stays open', async () => {
    const serialNumber = `STATION-${randomUUID()}`;
    const machine = await createMachine(serialNumber);
    const client = await dashboard();
    const offline = nextStatus(client, serialNumber, 'OFFLINE');

    const agent = await openAgent(mintStationToken(app, machine));
    agent.socket.send(makeFrame(envelope('handshake', 1, { serialNumber })));
    expect((await agent.next()).type).toBe('handshake_ack');

    await expect(offline).resolves.toMatchObject({ serialNumber, status: 'OFFLINE' });
    expect(agent.socket.readyState).toBe(WebSocket.OPEN);

    // Heartbeats resuming on the same socket bring it back.
    const online = nextStatus(client, serialNumber, 'ONLINE');
    agent.socket.send(makeFrame(envelope('heartbeat', 2, { locked: true, sessionId: null })));
    await expect(online).resolves.toMatchObject({ serialNumber, status: 'ONLINE' });

    agent.socket.close();
    client.close();
  }, 10_000);

  it('closes an agent that never sends a valid handshake', async () => {
    const agent = await openAgent(mintStationToken(app, await createMachine(`STATION-${randomUUID()}`)));
    agent.socket.send(makeFrame(envelope('handshake', 1, { serialNumber: '' })));

    const code = await new Promise<number>((resolve) => agent.socket.on('close', (closeCode: number) => resolve(closeCode)));
    expect(code).toBe(4400);
  });

  /** Resolves with the upgrade's HTTP status when the server refuses it, or 101 if it connects. */
  function upgradeStatus(token: string | null): Promise<number> {
    const socket = new WebSocket(
      `${baseUrl.replace('http', 'ws')}/agent-ws`,
      token ? { headers: { authorization: `Bearer ${token}` } } : {},
    );
    return new Promise((resolve) => {
      socket.on('unexpected-response', (_req, res) => {
        resolve(res.statusCode ?? 0);
        socket.terminate();
      });
      socket.on('open', () => {
        resolve(101);
        socket.close();
      });
      socket.on('error', () => undefined);
    });
  }

  it('refuses the agent-ws upgrade without a valid station token', async () => {
    const machine = await createMachine(`STATION-${randomUUID()}`);

    expect(await upgradeStatus(null)).toBe(401);
    expect(await upgradeStatus('garbage')).toBe(401);
    expect(await upgradeStatus(mintStationToken(app, machine, {}, -10))).toBe(401);
    // A user access token is signed with the same key but is not a station credential.
    expect(await upgradeStatus(accessToken)).toBe(401);
    expect(await upgradeStatus(mintStationToken(app, machine))).toBe(101);
  });

  it('closes 1008 when the handshake serial differs from the token serial', async () => {
    const machine = await createMachine(`STATION-${randomUUID()}`);
    const agent = await openAgent(mintStationToken(app, machine));
    agent.socket.send(makeFrame(envelope('handshake', 1, { serialNumber: `OTHER-${randomUUID()}` })));

    const code = await new Promise<number>((resolve) => agent.socket.on('close', (closeCode: number) => resolve(closeCode)));
    expect(code).toBe(1008);
    expect((await prisma.machine.findUniqueOrThrow({ where: { id: machine.id } })).status).toBe('OFFLINE');
  });

  it('closes 1008 when the token no longer matches its MACHINE row', async () => {
    const machine = await createMachine(`STATION-${randomUUID()}`);
    const token = mintStationToken(app, machine, { branchId: randomUUID() });
    const agent = await openAgent(token);
    agent.socket.send(makeFrame(envelope('handshake', 1, { serialNumber: machine.serialNumber })));

    const code = await new Promise<number>((resolve) => agent.socket.on('close', (closeCode: number) => resolve(closeCode)));
    expect(code).toBe(1008);
  });

  /** Resolves with the close code of an agent socket whose upgrade was accepted. */
  function closeCode(socket: WebSocket): Promise<number> {
    return new Promise((resolve) => socket.on('close', (code: number) => resolve(code)));
  }

  it('closes 1008 for a valid token whose station is not ENROLLED', async () => {
    const machine = await createMachine(`STATION-${randomUUID()}`);
    const token = mintStationToken(app, machine);

    for (const enrollmentStatus of ['PENDING', 'DEACTIVATED'] as const) {
      await prisma.machine.update({ where: { id: machine.id }, data: { enrollmentStatus } });
      const agent = await openAgent(token);
      const closed = closeCode(agent.socket);
      agent.socket.send(makeFrame(envelope('handshake', 1, { serialNumber: machine.serialNumber })));
      expect(await closed).toBe(1008);
      expect(agent.frames).toEqual([]);
    }
    expect((await prisma.machine.findUniqueOrThrow({ where: { id: machine.id } })).status).toBe('OFFLINE');
  });

  it('closes 1008 for a valid token with no MACHINE row, and creates no row', async () => {
    const serialNumber = `GHOST-${randomUUID()}`;
    const token = mintStationToken(app, { id: randomUUID(), serialNumber, branchId });
    const agent = await openAgent(token);
    const closed = closeCode(agent.socket);
    agent.socket.send(makeFrame(envelope('handshake', 1, { serialNumber })));

    expect(await closed).toBe(1008);
    expect(await prisma.machine.count({ where: { serialNumber } })).toBe(0);
  });

  it('never auto-creates a station for an unknown serial without a token', async () => {
    const serialNumber = `GHOST-${randomUUID()}`;
    expect(await upgradeStatus(null)).toBe(401);
    expect(await prisma.machine.count({ where: { serialNumber } })).toBe(0);
  });

  it('rejects a dashboard connection with no token', async () => {
    const client = ioClient(baseUrl, { path: '/dashboard-io', reconnection: false, forceNew: true });

    const rejected = await new Promise<boolean>((resolve) => {
      client.on('connect_error', () => resolve(true));
      client.on('connect', () => resolve(false));
    });
    client.close();

    expect(rejected).toBe(true);
  });

  it('authenticates, joins its branch room, and receives a publishToBranch event', async () => {
    const client = ioClient(baseUrl, {
      path: '/dashboard-io',
      reconnection: false,
      forceNew: true,
      auth: { token: accessToken },
    });

    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => resolve());
      client.on('connect_error', reject);
    });

    const received = new Promise((resolve) => client.on('station_status', resolve));

    const gateway = app.get(DashboardGateway);
    gateway.publishToBranch(branchId, 'station_status', { ok: true });

    await expect(received).resolves.toEqual({ ok: true });
    client.close();
  });

  it("a gamer's socket gets only that gamer's events, never a branch's or another gamer's", async () => {
    await app.inject({ method: 'POST', url: '/users', payload: { username: gamerUsername, password, branchId } });
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { username: gamerUsername, password } });
    const gamer = await prisma.user.findUniqueOrThrow({ where: { username: gamerUsername } });
    const client = ioClient(baseUrl, {
      path: '/dashboard-io',
      reconnection: false,
      forceNew: true,
      auth: { token: login.json().accessToken },
    });
    await new Promise<void>((resolve, reject) => {
      client.on('connect', () => resolve());
      client.on('connect_error', reject);
    });
    const received: { event: string; payload: unknown }[] = [];
    client.onAny((event: string, payload: unknown) => received.push({ event, payload }));

    const gateway = app.get(DashboardGateway);
    gateway.publishToBranch(branchId, 'station_status', { branch: true });
    gateway.publishToBranch(null, 'alert', { hq: true });
    gateway.publishToUser(randomUUID(), 'session_notice', { someoneElse: true });
    gateway.publishToUser(gamer.id, 'session_notice', { mine: true });

    await vi.waitFor(() => expect(received).toContainEqual({ event: 'session_notice', payload: { mine: true } }));
    await new Promise((r) => setTimeout(r, 200));
    expect(received).toEqual([{ event: 'session_notice', payload: { mine: true } }]);
    client.close();
  });
});
