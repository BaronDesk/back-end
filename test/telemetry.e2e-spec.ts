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
import { makeFrame } from '../src/infra/realtime/frame.js';
import type { OutboundEnvelope } from '../src/infra/realtime/envelope.js';
import { TelemetryHistoryService } from '../src/modules/ops/services/telemetry-history.service.js';
import { mintStationToken } from './station-token.js';

describe('telemetry & alerts (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let baseUrl: string;
  let branchId: string;
  let otherBranchId: string;
  let accessToken: string;
  let otherToken: string;

  const usernames = [`tel-${randomUUID()}`, `tel-other-${randomUUID()}`];
  const password = 'super-secret-1';

  async function staffToken(username: string, branch: string): Promise<string> {
    await prisma.user.create({
      data: {
        username,
        passwordHash: await hash(password),
        role: 'EMPLOYEE',
        employeeProfile: { create: { managedBranchId: branch, hireDate: new Date() } },
      },
    });
    const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { username, password } });
    return login.json().accessToken;
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;

    prisma = app.get(PrismaService);
    redis = app.get<Redis>(REDIS);
    branchId = (await prisma.branch.create({ data: { name: `tel-${randomUUID()}`, location: 'test' } })).id;
    otherBranchId = (await prisma.branch.create({ data: { name: `tel-o-${randomUUID()}`, location: 'test' } })).id;
    accessToken = await staffToken(usernames[0], branchId);
    otherToken = await staffToken(usernames[1], otherBranchId);
  }, 30_000);

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { username: { in: usernames } } });
    const machines = await prisma.machine.findMany({ where: { branchId } });
    if (machines.length) {
      await redis.del(...machines.flatMap((m) => [`node:${m.serialNumber}`, `telemetry:${m.serialNumber}`]));
    }
    await prisma.branch.deleteMany({ where: { id: { in: [branchId, otherBranchId] } } });
    await app.close();
  });

  function envelope(type: string, seq: number, payload: unknown = {}) {
    return { type, id: randomUUID(), ts: new Date().toISOString(), seq, payload };
  }

  function telemetry(values: Record<string, number>) {
    const now = new Date().toISOString();
    return {
      timestamp: now,
      metrics: Object.entries(values).map(([metric, value]) => ({ metric, value, sampledAt: now })),
    };
  }

  /** Connected, handshaken agent for a fresh MACHINE row. */
  async function connectAgent() {
    const serialNumber = `TEL-${randomUUID()}`;
    const machine = await prisma.machine.create({ data: { serialNumber, branchId, agentPublicKey: '' } });
    const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/agent-ws`, {
      headers: { authorization: `Bearer ${mintStationToken(app, machine)}` },
    });
    const frames: OutboundEnvelope[] = [];
    socket.on('message', (data: Buffer) => frames.push(JSON.parse(data.toString()) as OutboundEnvelope));
    await new Promise((resolve, reject) => {
      socket.on('open', resolve);
      socket.on('error', reject);
    });

    // Like the real agent: telemetry and device_event come off their own
    // sequence counter, interleaved with the connection counter.
    let seq = 0;
    let telemetrySeq = 0;
    const send = (type: string, payload: unknown) =>
      socket.send(
        makeFrame(envelope(type, type === 'telemetry' || type === 'device_event' ? ++telemetrySeq : ++seq, payload)),
      );
    send('handshake', { serialNumber });
    await vi.waitFor(() => expect(frames.some((f) => f.type === 'handshake_ack')).toBe(true));
    return { serialNumber, machine, socket, frames, send };
  }

  function dashboard(token = accessToken) {
    const client = ioClient(baseUrl, { path: '/dashboard-io', reconnection: false, forceNew: true, auth: { token } });
    return new Promise<typeof client>((resolve, reject) => {
      client.on('connect', () => resolve(client));
      client.on('connect_error', reject);
    });
  }

  function collect(client: Awaited<ReturnType<typeof dashboard>>, event: string) {
    const events: Record<string, unknown>[] = [];
    client.on(event, (e: Record<string, unknown>) => events.push(e));
    return events;
  }

  const auth = (token = accessToken) => ({ authorization: `Bearer ${token}` });

  it('caches live telemetry with a TTL and fans it out, without touching Postgres', async () => {
    const client = await dashboard();
    const updates = collect(client, 'telemetry_update');
    const agent = await connectAgent();

    agent.send('telemetry', telemetry({ 'cpu.temperature_c': 55.5, 'gpu.0.temperature_c': 60, 'fan.0.speed_rpm': 1200 }));
    await vi.waitFor(() => expect(updates.some((u) => u.serialNumber === agent.serialNumber)).toBe(true));
    expect(updates.find((u) => u.serialNumber === agent.serialNumber)).toMatchObject({
      machineId: agent.machine.id,
      branchId,
      metrics: { 'cpu.temperature_c': 55.5, 'gpu.0.temperature_c': 60, 'fan.0.speed_rpm': 1200 },
    });

    const ttl = await redis.ttl(`telemetry:${agent.serialNumber}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(30);

    const res = await app.inject({ method: 'GET', url: `/api/v1/stations/${agent.machine.id}/telemetry`, headers: auth() });
    expect(res.statusCode).toBe(200);
    expect(res.json().metrics['fan.0.speed_rpm']).toBe(1200);
    expect(await prisma.nodeTelemetry.count({ where: { machineId: agent.machine.id } })).toBe(0);

    // No reply frames for telemetry, and the connection stream is unaffected.
    expect(agent.frames.map((f) => f.type)).toEqual(['handshake_ack']);
    agent.send('heartbeat', { locked: false, sessionId: null });
    await vi.waitFor(() => expect(agent.frames.map((f) => f.type)).toEqual(['handshake_ack', 'heartbeat_ack']));

    const other = await app.inject({
      method: 'GET',
      url: `/api/v1/stations/${agent.machine.id}/telemetry`,
      headers: auth(otherToken),
    });
    expect(other.statusCode).toBe(403);

    await redis.del(`telemetry:${agent.serialNumber}`);
    const expired = await app.inject({ method: 'GET', url: `/api/v1/stations/${agent.machine.id}/telemetry`, headers: auth() });
    expect(expired.statusCode).toBe(404);

    agent.socket.close();
    client.close();
  });

  it('thins cached telemetry into one history row per online station per tick', async () => {
    const agent = await connectAgent();
    agent.send('telemetry', telemetry({ 'cpu.load_percent': 12 }));
    await vi.waitFor(async () => expect(await redis.exists(`telemetry:${agent.serialNumber}`)).toBe(1));

    await app.get(TelemetryHistoryService).tick();
    const rows = await prisma.nodeTelemetry.findMany({ where: { machineId: agent.machine.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0].metrics).toEqual({ 'cpu.load_percent': 12 });
    agent.socket.close();
  });

  it('raises one debounced hardware alert per crossing', async () => {
    const client = await dashboard();
    const alerts = collect(client, 'alert');
    const agent = await connectAgent();
    const hardwareRows = () =>
      prisma.telemetryAlert.count({ where: { machineId: agent.machine.id, category: 'HARDWARE' } });

    agent.send('telemetry', telemetry({ 'gpu.0.temperature_c': 97 }));
    agent.send('telemetry', telemetry({ 'gpu.0.temperature_c': 98 }));
    await vi.waitFor(() => expect(alerts.filter((a) => a.serialNumber === agent.serialNumber)).toHaveLength(1));
    expect(alerts[0]).toMatchObject({ category: 'hardware', type: 'temperature_high' });
    expect(await hardwareRows()).toBe(1);

    agent.send('telemetry', telemetry({ 'gpu.0.temperature_c': 70 })); // clears
    agent.send('telemetry', telemetry({ 'gpu.0.temperature_c': 95 })); // fires again
    await vi.waitFor(async () => expect(await hardwareRows()).toBe(2));

    agent.socket.close();
    client.close();
  });

  it('turns a device Disconnected into one anti_theft alert that staff can resolve', async () => {
    const client = await dashboard();
    const alerts = collect(client, 'alert');
    const agent = await connectAgent();
    const disconnected = {
      timestamp: new Date().toISOString(),
      deviceType: 'Mouse',
      deviceName: 'USB Optical Mouse',
      productId: 'C077',
      eventType: 'Disconnected',
    };

    agent.send('device_event', disconnected);
    agent.send('device_event', disconnected); // agent retry: must not duplicate
    agent.send('device_event', { ...disconnected, eventType: 'Connected', timestamp: new Date().toISOString() });

    await vi.waitFor(() => expect(alerts.filter((a) => a.serialNumber === agent.serialNumber)).toHaveLength(1));
    await new Promise((r) => setTimeout(r, 300));
    const rows = await prisma.telemetryAlert.findMany({ where: { machineId: agent.machine.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ category: 'ANTI_THEFT', type: 'device_disconnected', branchId });
    expect(rows[0].value).toMatchObject({ deviceName: 'USB Optical Mouse', productId: 'C077' });

    const open = await app.inject({ method: 'GET', url: '/api/v1/alerts?status=open', headers: auth() });
    expect(open.json()).toContainEqual(expect.objectContaining({ id: rows[0].id, category: 'anti_theft' }));

    const forbidden = await app.inject({ method: 'POST', url: `/api/v1/alerts/${rows[0].id}/resolve`, headers: auth(otherToken) });
    expect(forbidden.statusCode).toBe(403);
    const crossList = await app.inject({ method: 'GET', url: `/api/v1/alerts?branchId=${branchId}`, headers: auth(otherToken) });
    expect(crossList.statusCode).toBe(403);

    const resolved = await app.inject({ method: 'POST', url: `/api/v1/alerts/${rows[0].id}/resolve`, headers: auth() });
    expect(resolved.statusCode).toBe(200);
    expect(resolved.json()).toMatchObject({ acknowledged: true });
    expect(resolved.json().acknowledgedByUserId).toBeTruthy();

    const closed = await app.inject({ method: 'GET', url: '/api/v1/alerts?status=resolved', headers: auth() });
    expect(closed.json()).toContainEqual(expect.objectContaining({ id: rows[0].id }));

    agent.socket.close();
    client.close();
  });
});
