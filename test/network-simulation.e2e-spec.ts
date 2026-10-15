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
import { PresenceService } from '../src/modules/station/services/presence.service.js';
import { mintStationToken } from './station-token.js';

describe('network simulation (e2e)', () => {
  let app: NestFastifyApplication;
  let prisma: PrismaService;
  let presence: PresenceService;
  let baseUrl: string;
  let branchId: string;
  let otherBranchId: string;
  let managerToken: string;
  let staffToken: string;

  const password = 'super-secret-1';
  const managerUsername = `net-manager-${randomUUID()}`;
  const staffUsername = `net-staff-${randomUUID()}`;
  const sockets: WebSocket[] = [];

  type Machine = { id: string; serialNumber: string; branchId: string };

  beforeAll(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleFixture.createNestApplication<NestFastifyApplication>(new FastifyAdapter());
    await app.init();
    await app.listen(0, '127.0.0.1');
    baseUrl = `http://127.0.0.1:${(app.getHttpServer().address() as { port: number }).port}`;
    prisma = app.get(PrismaService);
    presence = app.get(PresenceService);

    branchId = (await prisma.branch.create({ data: { name: `net-${randomUUID()}`, location: 'test' } })).id;
    otherBranchId = (await prisma.branch.create({ data: { name: `net-o-${randomUUID()}`, location: 'test' } })).id;
    const passwordHash = await hash(password);
    for (const [username, role] of [[managerUsername, 'MANAGER'], [staffUsername, 'EMPLOYEE']] as const) {
      await prisma.user.create({
        data: { username, passwordHash, role, employeeProfile: { create: { managedBranchId: branchId, hireDate: new Date() } } },
      });
    }
    const login = async (username: string) =>
      (await app.inject({ method: 'POST', url: '/auth/login', payload: { username, password } })).json().accessToken;
    managerToken = await login(managerUsername);
    staffToken = await login(staffUsername);
  }, 30_000);

  afterAll(async () => {
    for (const socket of sockets) socket.terminate();
    const machines = await prisma.machine.findMany({ where: { branchId: { in: [branchId, otherBranchId] } } });
    if (machines.length) await app.get<Redis>(REDIS).del(...machines.map((m) => `node:${m.serialNumber}`));
    await prisma.user.deleteMany({ where: { username: { in: [managerUsername, staffUsername] } } });
    await prisma.branch.deleteMany({ where: { id: { in: [branchId, otherBranchId] } } });
    await app.close();
  });

  const createMachine = (branch = branchId): Promise<Machine> =>
    prisma.machine.create({ data: { serialNumber: `NET-${randomUUID()}`, branchId: branch, agentPublicKey: '', enrollmentStatus: 'ENROLLED' } });

  /** Opens the agent socket: the handshaken socket, or the HTTP status that refused the upgrade. */
  function connect(machine: Machine): Promise<{ socket: WebSocket } | { refused: number }> {
    const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/agent-ws`, {
      headers: { authorization: `Bearer ${mintStationToken(app, machine)}` },
    });
    sockets.push(socket);
    return new Promise((resolve, reject) => {
      socket.on('unexpected-response', (_req, res) => resolve({ refused: res.statusCode ?? 0 }));
      socket.on('error', (err) => (err.message.includes('Unexpected server response') ? undefined : reject(err)));
      socket.on('open', () => {
        socket.send(makeFrame({ type: 'handshake', id: randomUUID(), ts: new Date().toISOString(), seq: 1, payload: { serialNumber: machine.serialNumber } }));
      });
      socket.on('message', (data: Buffer) => {
        if (JSON.parse(data.toString()).type === 'handshake_ack') resolve({ socket });
      });
    });
  }

  async function connected(machine: Machine): Promise<WebSocket> {
    const result = await connect(machine);
    if (!('socket' in result)) throw new Error(`connection refused: ${result.refused}`);
    return result.socket;
  }

  const closed = (socket: WebSocket) =>
    new Promise<void>((resolve) => (socket.readyState === WebSocket.CLOSED ? resolve() : socket.once('close', () => resolve())));

  const drop = (path: string, seconds: unknown, token = managerToken) =>
    app.inject({ method: 'POST', url: `/api/v1/${path}/simulate/network-drop`, headers: { authorization: `Bearer ${token}` }, payload: { seconds } });

  it('drops one station for N seconds: cut, reconnects refused, then accepted again; a single drop', async () => {
    const machine = await createMachine();
    const bystander = await createMachine();
    const socket = await connected(machine);
    const other = await connected(bystander);

    const res = await drop(`stations/${machine.id}`, 2);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ machineId: machine.id, serialNumber: machine.serialNumber, disconnected: true, droppedUntil: expect.any(String) });
    await closed(socket);
    await vi.waitFor(async () => expect((await prisma.machine.findUniqueOrThrow({ where: { id: machine.id } })).status).toBe('OFFLINE'));

    expect(await connect(machine)).toEqual({ refused: 503 });
    expect(other.readyState).toBe(WebSocket.OPEN); // the rest of the branch is untouched

    await new Promise((r) => setTimeout(r, 2_100));
    await connected(machine);
    expect(presence.outageOf(machine.serialNumber)).toBe('single');
  });

  it('drops every station of a branch for N seconds, as a venue outage, and leaves other branches alone', async () => {
    const [a, b] = [await createMachine(), await createMachine()];
    const elsewhere = await createMachine(otherBranchId);
    const sa = await connected(a);
    const sb = await connected(b);
    const se = await connected(elsewhere);

    const res = await drop(`branches/${branchId}`, 2);
    expect(res.statusCode).toBe(200);
    expect(res.json().disconnected).toEqual(expect.arrayContaining([a.serialNumber, b.serialNumber]));
    expect(res.json().disconnected).not.toContain(elsewhere.serialNumber);
    await Promise.all([closed(sa), closed(sb)]);
    expect(se.readyState).toBe(WebSocket.OPEN);

    // A station of the branch that was not connected is refused too.
    expect(await connect(await createMachine())).toEqual({ refused: 503 });
    expect(await connect(a)).toEqual({ refused: 503 });

    await new Promise((r) => setTimeout(r, 2_100));
    await connected(a);
    await connected(b);
    expect(presence.outageOf(a.serialNumber)).toBe('venue');
    expect(presence.outageOf(b.serialNumber)).toBe('venue');
  });

  it('is for managers and up, in their own branch, with 1 to 3600 seconds', async () => {
    const machine = await createMachine();
    expect((await drop(`stations/${machine.id}`, 2, staffToken)).statusCode).toBe(403);
    expect((await drop(`branches/${otherBranchId}`, 2)).statusCode).toBe(403);
    expect((await drop(`stations/${(await createMachine(otherBranchId)).id}`, 2)).statusCode).toBe(403);
    for (const seconds of [0, 3601, 1.5, '5']) expect((await drop(`stations/${machine.id}`, seconds)).statusCode).toBe(400);
    expect((await drop(`stations/${randomUUID()}`, 2)).statusCode).toBe(404);
  });
});
