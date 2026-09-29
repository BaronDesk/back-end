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
import { PresenceService, type SessionEndedEvent } from '../src/modules/station/services/presence.service.js';
import { mintStationToken } from './station-token.js';

const COMMAND_TYPES = new Set(['LOCK', 'UNLOCK', 'SHUTDOWN', 'LAUNCH_GAME', 'END_SESSION', 'CATALOG_UPDATE']);

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

  const usernames = [`cmd-staff-${randomUUID()}`, `cmd-mgr-${randomUUID()}`, `cmd-gamer-${randomUUID()}`];
  const gameIds: string[] = [];
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
    await prisma.game.deleteMany({ where: { id: { in: gameIds } } });
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
    const machine = await prisma.machine.create({ data: { serialNumber, branchId, agentPublicKey: '', enrollmentStatus: 'ENROLLED' } });
    // Like the real agent: the station token rides on the upgrade request.
    const stationToken = mintStationToken(app, machine);
    const socket = new WebSocket(`${baseUrl.replace('http', 'ws')}/agent-ws`, {
      headers: { authorization: `Bearer ${stationToken}` },
    });
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
    return { machine, socket, commands, send, stationToken };
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
      data: { serialNumber: `CMD-${randomUUID()}`, branchId, agentPublicKey: '', enrollmentStatus: 'ENROLLED' },
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

  it('records INVALID_PAYLOAD as FAILED with the reason, without retrying', async () => {
    // Like the current agent: UNLOCK without a sessionId is rejected.
    const agent = await connectAgent((frame) =>
      (frame.payload as { sessionId?: string } | undefined)?.sessionId
        ? 'ack'
        : { code: 'INVALID_PAYLOAD', reason: 'sessionId is required.' },
    );
    const { commandId } = (await issue(agent.machine.id, { type: 'UNLOCK' })).json();
    await vi.waitFor(async () =>
      expect(await status(commandId)).toMatchObject({
        status: 'FAILED',
        nackCode: 'INVALID_PAYLOAD',
        nackReason: 'sessionId is required.',
      }),
    );
    // Past the ack timeout + backoff: a retry would have shown up by now.
    await new Promise((r) => setTimeout(r, 1_200));
    expect(agent.commands).toHaveLength(1);
    expect((await status(commandId)).attempts).toBe(1);
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
    expect(agent.commands[0]).toMatchObject({ type: 'LAUNCH_GAME', id: commandId, payload: { gameId: 'simulated-not-in-catalog' } });
    // Past the ack timeout + backoff: a retry would have shown up by now.
    await new Promise((r) => setTimeout(r, 1_200));
    expect(agent.commands).toHaveLength(1);
    expect((await status(commandId)).attempts).toBe(1);
    agent.socket.close();
  });

  it('refuses a session or PIN UNLOCK payload over REST: session unlocks follow an accepted login only', async () => {
    const agent = await connectAgent();
    const sessionId = randomUUID();
    expect((await issue(agent.machine.id, { type: 'UNLOCK', payload: { sessionId, pin: '4821' } })).statusCode).toBe(400);
    expect((await issue(agent.machine.id, { type: 'UNLOCK', payload: { sessionId, leaseSeconds: 60 } })).statusCode).toBe(400);
    expect((await issue(agent.machine.id, { type: 'LOCK', payload: { sessionId } })).statusCode).toBe(400);
    await new Promise((r) => setTimeout(r, 200));
    expect(agent.commands).toHaveLength(0);
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

  describe('station game catalog, LAUNCH_GAME and END_SESSION', () => {
    const station = async (machineId: string) =>
      (await app.inject({ method: 'GET', url: `/api/v1/stations/${machineId}`, headers: auth() })).json();

    const stationGames = async (machineId: string) =>
      (await app.inject({ method: 'GET', url: `/api/v1/stations/${machineId}/games`, headers: auth() })).json();

    const fetchCatalog = (headers: Record<string, string>) =>
      app.inject({ method: 'GET', url: '/stations/me/games', headers });

    const createGame = async (overrides: Record<string, unknown> = {}) => {
      const gameId = `g-${randomUUID().slice(0, 8)}`;
      const res = await app.inject({
        method: 'POST',
        url: '/api/v1/games',
        headers: auth(managerToken),
        payload: { gameId, name: `Game ${gameId}`, launchType: 'exe', target: 'C:\\Games\\test\\game.exe', ...overrides },
      });
      expect(res.statusCode).toBe(201);
      gameIds.push(res.json().id);
      return res.json() as { id: string; gameId: string; target: string; enabled: boolean };
    };

    const assignToBranch = (id: string) =>
      app.inject({ method: 'PUT', url: `/api/v1/games/${id}/branches/${branchId}`, headers: auth(managerToken) });

    /** Like LaunchGameCommandHandler: an empty gameId is INVALID_PAYLOAD, anything else is launched. */
    const launchingAgent = () =>
      connectAgent((frame) => {
        if (frame.type !== 'LAUNCH_GAME') return 'ack';
        const gameId = (frame.payload as { gameId?: unknown } | null)?.gameId;
        if (typeof gameId !== 'string' || gameId.trim() === '') {
          return { code: 'INVALID_PAYLOAD', reason: 'gameId is required (1-128 characters).' };
        }
        return gameId === 'simulated-not-in-catalog'
          ? { code: 'EXEC_FAILED', reason: `Game '${gameId}' is not in this station's catalog.` }
          : 'ack';
      });

    /** Assigned + reported installed + unlocked with a session: ready to launch. */
    const readyToLaunch = async () => {
      const game = await createGame();
      await assignToBranch(game.id);
      const agent = await launchingAgent();
      agent.send('catalog_status', { games: [{ gameId: game.gameId, installed: true, reason: null }] });
      agent.send('heartbeat', { locked: false, sessionId: randomUUID() });
      await vi.waitFor(async () =>
        expect((await stationGames(agent.machine.id)).find((g: { id: string }) => g.id === game.id)?.installed).toBe(true),
      );
      await vi.waitFor(async () => expect((await station(agent.machine.id)).locked).toBe(false));
      return { game, agent };
    };

    it('lets admin+ manage the catalog, validates launch specs, and hides disabled games from gamers', async () => {
      const denied = await app.inject({
        method: 'POST',
        url: '/api/v1/games',
        headers: auth(),
        payload: { gameId: 'x', name: 'x', target: 'C:\\x.exe' },
      });
      expect(denied.statusCode).toBe(403);

      const badPath = await app.inject({
        method: 'POST',
        url: '/api/v1/games',
        headers: auth(managerToken),
        payload: { gameId: `bad-${randomUUID()}`, name: 'x', launchType: 'exe', target: 'games/cs2.exe' },
      });
      expect(badPath.json().code).toBe('INVALID_LAUNCH_SPEC');
      const badSteam = await app.inject({
        method: 'POST',
        url: '/api/v1/games',
        headers: auth(managerToken),
        payload: { gameId: `bad-${randomUUID()}`, name: 'x', launchType: 'steam', target: 'cs2' },
      });
      expect(badSteam.json().code).toBe('INVALID_LAUNCH_SPEC');

      const enabled = await createGame({ launchType: 'steam', target: '730', processName: 'cs2.exe' });
      const disabled = await createGame({ enabled: false });
      const dup = await app.inject({
        method: 'POST',
        url: '/api/v1/games',
        headers: auth(managerToken),
        payload: { gameId: enabled.gameId, name: 'dup', target: 'C:\\x.exe' },
      });
      expect(dup.statusCode).toBe(409);

      await app.inject({ method: 'POST', url: '/users', payload: { username: usernames[2], password } });
      const login = await app.inject({ method: 'POST', url: '/auth/login', payload: { username: usernames[2], password } });
      const gamerIds = (await app.inject({ method: 'GET', url: '/api/v1/games', headers: auth(login.json().accessToken) }))
        .json()
        .map((g: { id: string }) => g.id);
      expect(gamerIds).toContain(enabled.id);
      expect(gamerIds).not.toContain(disabled.id);
    });

    it('serves GET /stations/me/games to the agent by its bearer token, resolved for that machine', async () => {
      const agent = await connectAgent();
      expect((await fetchCatalog({})).statusCode).toBe(401);
      expect((await fetchCatalog({ authorization: 'Bearer nobody' })).statusCode).toBe(401);
      expect((await fetchCatalog({ authorization: `Bearer ${staffToken}` })).statusCode).toBe(401);
      const expired = mintStationToken(app, agent.machine, {}, -10);
      expect((await fetchCatalog({ authorization: `Bearer ${expired}` })).statusCode).toBe(401);
      expect((await fetchCatalog({ authorization: `Bearer ${agent.stationToken}` })).json()).toEqual({ games: [] });

      const branchGame = await createGame({ arguments: '-novid', workingDirectory: 'C:\\Games\\test' });
      const machineGame = await createGame({ launchType: 'epic', target: 'Fortnite', arguments: '-ignored' });
      const unassigned = await createGame();

      // Assigning changes this station's catalog: it gets CATALOG_UPDATE {} to re-sync.
      expect((await assignToBranch(branchGame.id)).statusCode).toBe(200);
      await vi.waitFor(() => expect(agent.commands.filter((c) => c.type === 'CATALOG_UPDATE')).toHaveLength(1));
      expect(agent.commands[0].payload).toEqual({});

      const override = await app.inject({
        method: 'PUT',
        url: `/api/v1/games/${branchGame.id}/stations/${agent.machine.id}`,
        headers: auth(managerToken),
        payload: { target: 'D:\\Other\\game.exe' },
      });
      expect(override.statusCode).toBe(200);
      await app.inject({
        method: 'PUT',
        url: `/api/v1/games/${machineGame.id}/stations/${agent.machine.id}`,
        headers: auth(managerToken),
      });

      const res = await fetchCatalog({ authorization: `Bearer ${agent.stationToken}` });
      expect(res.statusCode).toBe(200);
      const games = res.json().games as Record<string, unknown>[];
      expect(games.find((g) => g.gameId === branchGame.gameId)).toEqual({
        gameId: branchGame.gameId,
        name: `Game ${branchGame.gameId}`,
        launchType: 'exe',
        target: 'D:\\Other\\game.exe',
        arguments: '-novid',
        workingDirectory: 'C:\\Games\\test',
        processName: null,
      });
      expect(games.find((g) => g.gameId === machineGame.gameId)).toMatchObject({ launchType: 'epic', arguments: null });
      expect(games.some((g) => g.gameId === unassigned.gameId)).toBe(false);

      // A serial alone authenticates nothing.
      const bySerial = await fetchCatalog({ 'x-station-serial': agent.machine.serialNumber });
      expect(bySerial.statusCode).toBe(401);

      // Valid token, station no longer ENROLLED (or never had a row): 403.
      const stationAuth = { authorization: `Bearer ${agent.stationToken}` };
      await prisma.machine.update({ where: { id: agent.machine.id }, data: { enrollmentStatus: 'PENDING' } });
      expect((await fetchCatalog(stationAuth)).statusCode).toBe(403);
      await prisma.machine.update({ where: { id: agent.machine.id }, data: { enrollmentStatus: 'ENROLLED' } });
      expect((await fetchCatalog(stationAuth)).statusCode).toBe(200);
      const ghost = mintStationToken(app, { ...agent.machine, id: randomUUID() });
      expect((await fetchCatalog({ authorization: `Bearer ${ghost}` })).statusCode).toBe(403);
      agent.socket.close();
    });

    it('stores catalog_status as the station install truth and pushes it to dashboards', async () => {
      const client = ioClient(baseUrl, {
        path: '/dashboard-io',
        forceNew: true,
        reconnection: false,
        auth: { token: staffToken },
      });
      await new Promise((resolve) => client.on('connect', resolve));
      const pushed: Record<string, unknown>[] = [];
      client.on('catalog_status', (e: Record<string, unknown>) => pushed.push(e));

      const game = await createGame();
      await assignToBranch(game.id);
      const agent = await connectAgent();
      agent.send('catalog_status', { games: [{ gameId: game.gameId, installed: false, reason: 'Executable not found.' }] });
      await vi.waitFor(async () =>
        expect((await stationGames(agent.machine.id)).find((g: { id: string }) => g.id === game.id)).toMatchObject({
          installed: false,
          reason: 'Executable not found.',
        }),
      );
      await vi.waitFor(() => expect(pushed.some((p) => p.machineId === agent.machine.id)).toBe(true));

      // Malformed: logged and dropped, the socket keeps working.
      agent.send('catalog_status', { games: 'nope' });
      agent.send('catalog_status', { games: [{ gameId: game.gameId, installed: true }] });
      await vi.waitFor(async () =>
        expect((await stationGames(agent.machine.id)).find((g: { id: string }) => g.id === game.id)?.installed).toBe(true),
      );
      client.close();
      agent.socket.close();
    });

    it('launches only an installed game on an unlocked station in session, sending just the gameId', async () => {
      const { game, agent } = await readyToLaunch();
      const res = await issue(agent.machine.id, { type: 'LAUNCH_GAME', gameId: game.gameId });
      expect(res.statusCode).toBe(202);
      const { commandId } = res.json();

      await vi.waitFor(async () => expect(await status(commandId)).toMatchObject({ status: 'ACKED', gameId: game.id }));
      const frame = agent.commands.find((c) => c.id === commandId);
      expect(frame).toMatchObject({ type: 'LAUNCH_GAME', payload: { gameId: game.gameId } });
      expect(JSON.stringify(frame)).not.toContain(game.target);

      // runningGameId comes only from state_report, never from the ack.
      expect((await station(agent.machine.id)).runningGameId).toBeNull();
      agent.send('state_report', { locked: false, runningGameId: game.gameId });
      await vi.waitFor(async () => expect((await station(agent.machine.id)).runningGameId).toBe(game.gameId));
      agent.socket.close();
    });

    it('rejects LAUNCH_GAME up front: no session, unknown, disabled, unassigned, unreported or not installed', async () => {
      const { game, agent } = await readyToLaunch();
      const code = async (gameId: string) => (await issue(agent.machine.id, { type: 'LAUNCH_GAME', gameId })).json().code;

      expect(await code(`nope-${randomUUID()}`)).toBe('GAME_NOT_FOUND');
      const disabled = await createGame({ enabled: false });
      expect(await code(disabled.gameId)).toBe('GAME_DISABLED');
      const unassigned = await createGame();
      expect(await code(unassigned.gameId)).toBe('GAME_NOT_ASSIGNED');
      const unreported = await createGame();
      await assignToBranch(unreported.id);
      expect(await code(unreported.gameId)).toBe('GAME_STATUS_UNKNOWN');

      agent.send('catalog_status', { games: [{ gameId: game.gameId, installed: false, reason: 'Not installed.' }] });
      await vi.waitFor(async () =>
        expect((await stationGames(agent.machine.id)).find((g: { id: string }) => g.id === game.id)?.installed).toBe(false),
      );
      expect(await code(game.gameId)).toBe('GAME_NOT_INSTALLED');

      agent.send('heartbeat', { locked: true, sessionId: null });
      await vi.waitFor(async () => expect((await station(agent.machine.id)).locked).toBe(true));
      expect(await code(game.gameId)).toBe('STATION_NOT_IN_SESSION');

      expect(agent.commands.filter((c) => c.type === 'LAUNCH_GAME')).toHaveLength(0);
      agent.socket.close();
    });

    it('records INVALID_PAYLOAD and EXEC_FAILED from the agent as FAILED, never retried', async () => {
      const agent = await launchingAgent();
      const invalid = (await issue(agent.machine.id, { type: 'LAUNCH_GAME', gameId: 'x', simulate: 'invalid_payload' })).json();
      const failed = (await issue(agent.machine.id, { type: 'LAUNCH_GAME', gameId: 'x', simulate: 'exec_failed' })).json();

      await vi.waitFor(async () =>
        expect(await status(invalid.commandId)).toMatchObject({
          status: 'FAILED',
          nackCode: 'INVALID_PAYLOAD',
          nackReason: 'gameId is required (1-128 characters).',
        }),
      );
      await vi.waitFor(async () =>
        expect(await status(failed.commandId)).toMatchObject({ status: 'FAILED', nackCode: 'EXEC_FAILED' }),
      );
      expect(agent.commands.find((c) => c.id === invalid.commandId)?.payload).toEqual({ gameId: '' });
      await new Promise((r) => setTimeout(r, 1_200));
      expect(agent.commands).toHaveLength(2);
      agent.socket.close();
    });

    it('ends a session: 409 without one; with one, ACKED, then locked with no session and no game', async () => {
      const agent = await connectAgent();
      const presence = app.get(PresenceService);
      const ended: SessionEndedEvent[] = [];
      const sub = presence.sessionEnded.subscribe((e) => ended.push(e));

      agent.send('heartbeat', { locked: false, sessionId: null });
      await new Promise((r) => setTimeout(r, 100));
      const none = await issue(agent.machine.id, { type: 'END_SESSION' });
      expect(none.statusCode).toBe(409);
      expect(none.json().code).toBe('NO_ACTIVE_SESSION');

      const sessionId = randomUUID();
      agent.send('heartbeat', { locked: false, sessionId });
      agent.send('state_report', { locked: false, sessionId, runningGameId: 'cs2' });
      await vi.waitFor(() => expect(presence.sessionOf(agent.machine.serialNumber)).toBe(sessionId));

      const { commandId } = (await issue(agent.machine.id, { type: 'END_SESSION', reason: 'staff_end' })).json();
      await vi.waitFor(async () => expect((await status(commandId)).status).toBe('ACKED'));
      expect(agent.commands[0]).toMatchObject({ type: 'END_SESSION', id: commandId, payload: { reason: 'staff_end' } });

      // The ack alone changes nothing: the station still shows the session.
      expect(await station(agent.machine.id)).toMatchObject({ sessionId, locked: false });
      expect(ended).toHaveLength(0);

      // What the agent does on END_SESSION: stops the game, ends the session, locks.
      agent.send('heartbeat', { locked: true, sessionId: null });
      await vi.waitFor(async () =>
        expect(await station(agent.machine.id)).toMatchObject({ sessionId: null, locked: true, runningGameId: null }),
      );
      expect(ended).toEqual([expect.objectContaining({ machineId: agent.machine.id, sessionId, reason: 'staff_end' })]);
      // The agent stops the game itself: only the END_SESSION frame went out.
      expect(agent.commands.map((c) => c.type)).toEqual(['END_SESSION']);
      sub.unsubscribe();
      agent.socket.close();
    });
  });
});
