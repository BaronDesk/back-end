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

const COMMAND_TYPES = new Set(['LOCK', 'UNLOCK', 'SHUTDOWN', 'LAUNCH_GAME']);

type AgentReply = 'ack' | 'silent' | { code: string; reason: string };
type AgentBehaviour = (frame: OutboundEnvelope, n: number) => AgentReply;

describe('station commands (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let redis: Redis;
  let baseUrl: string;
  let branchId: string;
  let staffToken: string;
  let managerToken: string;

  const usernames = [`cmd-staff-${randomUUID()}`, `cmd-mgr-${randomUUID()}`];
  const password = 'super-secret-1';

  async function login(username: string, role: 'EMPLOYEE' | 'MANAGER', branch = branchId): Promise<string> {
    await prisma.user.create({
      data: {
        username,
        passwordHash: await hash(password),
        role,
        employeeProfile: { create: { managedBranchId: branch, hireDate: new Date() } },
      },
    });
    const res = await app.inject({ method: 'POST', url: '/auth/login', payload: { username, password } });
    return res.json().accessToken;
  }

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;

    prisma = app.get(PrismaService);
    redis = app.get<Redis>(REDIS);
    branchId = (await prisma.branch.create({ data: { name: `cmd-${randomUUID()}`, location: 'test' } })).id;
    staffToken = await login(usernames[0], 'EMPLOYEE');
    managerToken = await login(usernames[1], 'MANAGER');
  }, 30_000);

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { username: { in: usernames } } });
    const machines = await prisma.machine.findMany({ where: { branchId } });
    if (machines.length) await redis.del(...machines.map((m) => `node:${m.serialNumber}`));
    await prisma.branch.deleteMany({ where: { id: branchId } });
    await app.close();
  });

  const auth = (token = staffToken) => ({ authorization: `Bearer ${token}` });

  /**
   * Fake agent. `behaviour` decides whether to ack each command frame. Like
   * the real agent's ReplayGuard, it nacks STALE on a non-increasing seq or a
   * ts more than 30s off.
   */
  async function connectAgent(behaviour: AgentBehaviour = () => 'ack') {
    const serialNumber = `CMD-${randomUUID()}`;
    const machine = await prisma.machine.create({ data: { serialNumber, branchId, agentPublicKey: '' } });
    const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/agent-ws`);
    const commands: OutboundEnvelope[] = [];
    let seq = 0;
    let lastCommandSeq = 0;
    let handshaken = false;
    const send = (type: string, payload: unknown) =>
      socket.send(makeFrame({ type, id: randomUUID(), ts: new Date().toISOString(), seq: ++seq, payload }));

    socket.on('message', (data: Buffer) => {
      const frame = JSON.parse(data.toString()) as OutboundEnvelope;
      if (frame.type === 'handshake_ack') handshaken = true;
      if (!COMMAND_TYPES.has(frame.type)) return;
      commands.push(frame);
      if (frame.seq <= lastCommandSeq || Math.abs(Date.now() - Date.parse(frame.ts)) > 30_000) {
        send('command_nack', { commandId: frame.id, code: 'STALE', reason: 'replay guard' });
        return;
      }
      lastCommandSeq = frame.seq;
      const reply = behaviour(frame, commands.length);
      if (reply === 'ack') send('command_ack', { commandId: frame.id });
      else if (reply !== 'silent') send('command_nack', { commandId: frame.id, ...reply });
    });
    await new Promise((resolve, reject) => {
      socket.on('open', resolve);
      socket.on('error', reject);
    });
    send('handshake', { serialNumber });
    await vi.waitFor(() => expect(handshaken).toBe(true));
    return { machine, socket, commands, send };
  }

  const issue = (machineId: string, body: Record<string, unknown>, token = staffToken) =>
    app.inject({ method: 'POST', url: `/api/v1/stations/${machineId}/commands`, headers: auth(token), payload: body });

  const status = async (commandId: string) =>
    (await app.inject({ method: 'GET', url: `/api/v1/commands/${commandId}`, headers: auth() })).json();

  it('delivers LOCK with the commandId as envelope id and records the ack', async () => {
    const client = ioClient(baseUrl, {
      path: '/dashboard-io',
      forceNew: true,
      reconnection: false,
      auth: { token: staffToken },
    });
    await new Promise((resolve) => client.on('connect', resolve));
    const updates: Record<string, unknown>[] = [];
    client.on('command_update', (e: Record<string, unknown>) => updates.push(e));

    const agent = await connectAgent();
    const res = await issue(agent.machine.id, { type: 'LOCK' });
    expect(res.statusCode).toBe(202);
    expect(res.json().status).toBe('PENDING');
    const { commandId } = res.json();

    await vi.waitFor(async () => expect((await status(commandId)).status).toBe('ACKED'));
    expect(agent.commands).toHaveLength(1);
    expect(agent.commands[0]).toMatchObject({ type: 'LOCK', id: commandId, payload: {} });
    // Stamped by the connection's sequencer: handshake_ack already took seq 1.
    expect(agent.commands[0].seq).toBeGreaterThan(1);

    await vi.waitFor(() =>
      expect(updates.filter((u) => u.commandId === commandId).map((u) => u.status)).toEqual([
        'PENDING',
        'SENT',
        'ACKED',
      ]),
    );

    const list = await app.inject({ method: 'GET', url: `/api/v1/stations/${agent.machine.id}/commands`, headers: auth() });
    expect(list.json()[0]).toMatchObject({ commandId, type: 'LOCK', status: 'ACKED', attempts: 1 });

    agent.socket.close();
    client.close();
  });

  it('rejects a command for an offline station with 409', async () => {
    const machine = await prisma.machine.create({
      data: { serialNumber: `CMD-${randomUUID()}`, branchId, agentPublicKey: '' },
    });
    const res = await issue(machine.id, { type: 'UNLOCK' });
    expect(res.statusCode).toBe(409);
    expect(res.json().code).toBe('STATION_OFFLINE');
    expect(await prisma.command.count({ where: { machineId: machine.id } })).toBe(0);
  });

  it('records a STALE nack as NACKED', async () => {
    const agent = await connectAgent();
    const { commandId } = (await issue(agent.machine.id, { type: 'LOCK', simulate: 'stale_ts' })).json();
    await vi.waitFor(async () => expect(await status(commandId)).toMatchObject({ status: 'NACKED', nackCode: 'STALE' }));
    agent.socket.close();
  });

  it('records EXEC_FAILED as FAILED with the reason, without retrying', async () => {
    const agent = await connectAgent(() => ({ code: 'EXEC_FAILED', reason: 'Game ID is required.' }));
    const { commandId } = (await issue(agent.machine.id, { type: 'LOCK', simulate: 'exec_failed' })).json();
    await vi.waitFor(async () =>
      expect(await status(commandId)).toMatchObject({
        status: 'FAILED',
        nackCode: 'EXEC_FAILED',
        nackReason: 'Game ID is required.',
      }),
    );
    expect(agent.commands[0]).toMatchObject({ type: 'LAUNCH_GAME', id: commandId, payload: {} });
    // Past the ack timeout + backoff: a retry would have shown up by now.
    await new Promise((r) => setTimeout(r, 1_200));
    expect(agent.commands).toHaveLength(1);
    expect((await status(commandId)).attempts).toBe(1);
    agent.socket.close();
  });

  it('acks a booking UNLOCK without reporting the station unlocked', async () => {
    const agent = await connectAgent();
    agent.send('heartbeat', { locked: true, sessionId: null });
    const payload = { sessionId: randomUUID(), pin: '4821' };
    const res = await issue(agent.machine.id, { type: 'UNLOCK', payload });
    expect(res.statusCode).toBe(202);
    expect(res.body).not.toContain('4821');
    const { commandId } = res.json();

    await vi.waitFor(async () => expect((await status(commandId)).status).toBe('ACKED'));
    expect(agent.commands[0]).toMatchObject({ type: 'UNLOCK', id: commandId, payload });

    // The agent stays locked until the PIN is typed; lock state follows its heartbeat.
    agent.send('heartbeat', { locked: true, sessionId: payload.sessionId });
    await new Promise((r) => setTimeout(r, 200));
    const station = await app.inject({ method: 'GET', url: `/api/v1/stations/${agent.machine.id}`, headers: auth() });
    expect(station.json().locked).toBe(true);

    // A payload is UNLOCK-only, and a booking payload must be complete.
    expect((await issue(agent.machine.id, { type: 'LOCK', payload })).statusCode).toBe(400);
    expect((await issue(agent.machine.id, { type: 'UNLOCK', payload: { pin: '1' } })).statusCode).toBe(400);
    agent.socket.close();
  });

  it('retries a timed-out command with the same commandId and a fresh seq', async () => {
    const agent = await connectAgent((_frame, n) => (n === 1 ? 'silent' : 'ack'));
    const { commandId } = (await issue(agent.machine.id, { type: 'UNLOCK' })).json();
    await vi.waitFor(async () => expect(await status(commandId)).toMatchObject({ status: 'ACKED', attempts: 2 }), {
      timeout: 5_000,
    });
    expect(agent.commands.map((c) => c.id)).toEqual([commandId, commandId]);
    expect(agent.commands[1].seq).toBeGreaterThan(agent.commands[0].seq);
    agent.socket.close();
  });

  it('ends as TIMEOUT when every attempt goes unanswered', async () => {
    const agent = await connectAgent(() => 'silent');
    const { commandId } = (await issue(agent.machine.id, { type: 'LOCK' })).json();
    await vi.waitFor(async () => expect(await status(commandId)).toMatchObject({ status: 'TIMEOUT', attempts: 2 }), {
      timeout: 5_000,
    });
    agent.socket.close();
  });

  it('gates SHUTDOWN at manager+, and a disconnect after its ack keeps it ACKED', async () => {
    const agent = await connectAgent();
    expect((await issue(agent.machine.id, { type: 'SHUTDOWN' })).statusCode).toBe(403);

    const res = await issue(agent.machine.id, { type: 'SHUTDOWN' }, managerToken);
    expect(res.statusCode).toBe(202);
    const { commandId } = res.json();
    await vi.waitFor(async () => expect((await status(commandId)).status).toBe('ACKED'));

    agent.socket.close();
    await vi.waitFor(async () =>
      expect((await prisma.machine.findUnique({ where: { id: agent.machine.id } }))?.status).toBe('OFFLINE'),
    );
    await new Promise((r) => setTimeout(r, 1_000));
    expect((await status(commandId)).status).toBe('ACKED');
  });

  it('keeps commands branch-scoped', async () => {
    const otherBranch = await prisma.branch.create({ data: { name: `cmd-o-${randomUUID()}`, location: 'test' } });
    const username = `cmd-other-${randomUUID()}`;
    const otherToken = await login(username, 'EMPLOYEE', otherBranch.id);

    const agent = await connectAgent();
    expect((await issue(agent.machine.id, { type: 'LOCK' }, otherToken)).statusCode).toBe(403);
    const { commandId } = (await issue(agent.machine.id, { type: 'LOCK' })).json();
    const cross = await app.inject({ method: 'GET', url: `/api/v1/commands/${commandId}`, headers: auth(otherToken) });
    expect(cross.statusCode).toBe(403);

    agent.socket.close();
    await prisma.user.deleteMany({ where: { username } });
    await prisma.branch.delete({ where: { id: otherBranch.id } });
  });
});
