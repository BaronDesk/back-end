import { randomUUID } from 'node:crypto';

import { hash } from '@node-rs/argon2';
import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { io as ioClient } from 'socket.io-client';
import WebSocket from 'ws';

import { AppModule } from '../src/app.module.js';
import { PrismaService } from '../src/infra/prisma/prisma.service.js';
import { DashboardGateway } from '../src/modules/ops/dashboard.gateway.js';
import { makeFrame } from '../src/infra/realtime/frame.js';
import type { Envelope } from '../src/infra/realtime/envelope.js';

describe('realtime gateways (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let baseUrl: string;
  let branchId: string;
  let accessToken: string;

  const username = `dash-${randomUUID()}`;
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
    await prisma.user.deleteMany({ where: { username } });
    await prisma.branch.delete({ where: { id: branchId } }).catch(() => undefined);
    await app.close();
  });

  function envelope(type: string, seq: number, payload: unknown = {}): Envelope {
    return { type, id: randomUUID(), ts: Date.now(), seq, payload };
  }

  it('acks handshake and heartbeat, nacks a replayed seq', async () => {
    const wsUrl = `${baseUrl.replace('http', 'ws')}/agent-ws?machineId=m-1&token=stub`;
    const socket = new WebSocket(wsUrl);
    const messages: Envelope[] = [];

    await new Promise<void>((resolve, reject) => {
      socket.on('open', () => socket.send(makeFrame(envelope('handshake', 0))));
      socket.on('error', reject);
      socket.on('message', (data: Buffer) => {
        messages.push(JSON.parse(data.toString()) as Envelope);
        if (messages.length === 1) socket.send(makeFrame(envelope('heartbeat', 1)));
        else if (messages.length === 2) socket.send(makeFrame(envelope('heartbeat', 1))); // replay
        else resolve();
      });
    });
    socket.close();

    expect(messages[0].type).toBe('handshake_ack');
    expect(messages[1].type).toBe('heartbeat_ack');
    expect(messages[2].type).toBe('heartbeat_nack');
  });

  it('closes agent connections missing station credentials', async () => {
    const wsUrl = `${baseUrl.replace('http', 'ws')}/agent-ws`;
    const socket = new WebSocket(wsUrl);

    const code = await new Promise<number>((resolve) => {
      socket.on('close', (closeCode: number) => resolve(closeCode));
    });
    expect(code).toBe(4401);
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
});
