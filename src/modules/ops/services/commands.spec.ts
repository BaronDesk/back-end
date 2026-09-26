import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { StationNotConnectedError } from '../agent.gateway.js';
import { CommandAckTracker } from './command-ack-tracker.js';
import { CommandProcessor } from './command.processor.js';
import { CommandsService } from './commands.service.js';
import { issueCommandBodySchema } from '../schemas/command.schemas.js';

const STATION = { machineId: 'm1', branchId: 'b1', serialNumber: 'SN-1' };

function caller(overrides: Partial<AccessTokenPayload> = {}): AccessTokenPayload {
  return { sub: 'u1', role: 'EMPLOYEE', scope: 'staff', branchId: 'b1', jti: 'j', ...overrides };
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: 'c1',
    machineId: 'm1',
    branchId: 'b1',
    type: 'LOCK',
    status: 'PENDING',
    issuedBy: 'u1',
    issuedAt: new Date(),
    sentAt: null,
    resolvedAt: null,
    nackCode: null,
    nackReason: null,
    failureReason: null,
    attempts: 0,
    gameId: null,
    ...overrides,
  };
}

function config(values: Record<string, unknown> = {}) {
  return { get: (key: string) => values[key] } as any;
}

describe('CommandsService', () => {
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let presence: Record<string, ReturnType<typeof vi.fn>>;
  let registry: { has: ReturnType<typeof vi.fn> };
  let dashboard: { publishToBranch: ReturnType<typeof vi.fn> };
  let queue: { add: ReturnType<typeof vi.fn> };
  let games: { findLaunchable: ReturnType<typeof vi.fn> };
  let tracker: CommandAckTracker;
  let service: CommandsService;

  const GAME = { id: '9d3c1f4e-8a55-4d1b-9a36-2f0f5c1e7b20', launchRef: 'steam:730', enabled: true };
  const launch = { type: 'LAUNCH_GAME' as const, gameId: GAME.id, payload: undefined };
  const endSession = { type: 'END_SESSION' as const, payload: undefined };

  beforeEach(() => {
    repo = {
      create: vi.fn(async (data) => row(data)),
      findById: vi.fn(async () => row({ status: 'SENT' })),
      transition: vi.fn(async (_id, _from, data) => row(data)),
      listForMachine: vi.fn(),
    };
    presence = {
      resolveById: vi.fn(async () => STATION),
      resolve: vi.fn(() => STATION),
      isOnline: vi.fn(() => true),
      sessionOf: vi.fn(() => 'sess-1'),
      expectSessionEnd: vi.fn(),
    };
    games = { findLaunchable: vi.fn(async () => GAME) };
    registry = { has: vi.fn(() => true) };
    dashboard = { publishToBranch: vi.fn() };
    queue = { add: vi.fn(async () => ({})) };
    tracker = new CommandAckTracker();
    service = new CommandsService(
      repo as any,
      presence as any,
      registry as any,
      dashboard as any,
      tracker,
      queue as any,
      config({ NODE_ENV: 'development', COMMAND_MAX_ATTEMPTS: 2 }),
      games as any,
    );
  });

  it("queues LAUNCH_GAME with the game's launchRef as the agent's gameId", async () => {
    const dto = await service.issue(caller(), 'm1', launch);
    expect(games.findLaunchable).toHaveBeenCalledWith(GAME.id);
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'LAUNCH_GAME', gameId: GAME.id }));
    expect(queue.add).toHaveBeenCalledWith(
      'dispatch',
      expect.objectContaining({ commandId: dto.commandId, payload: { gameId: 'steam:730' } }),
      expect.anything(),
    );
  });

  it('rejects LAUNCH_GAME for a missing or disabled game before creating anything', async () => {
    games.findLaunchable.mockRejectedValueOnce(new NotFoundException());
    await expect(service.issue(caller(), 'm1', launch)).rejects.toBeInstanceOf(NotFoundException);
    games.findLaunchable.mockRejectedValueOnce(new ConflictException());
    await expect(service.issue(caller(), 'm1', launch)).rejects.toBeInstanceOf(ConflictException);
    expect(repo.create).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('queues END_SESSION with its reason and labels the expected session end', async () => {
    await service.issue(caller(), 'm1', { ...endSession, reason: 'closing' });
    expect(queue.add).toHaveBeenCalledWith('dispatch', expect.objectContaining({ payload: { reason: 'closing' } }), expect.anything());
    expect(presence.expectSessionEnd).toHaveBeenCalledWith('SN-1', 'closing');

    await service.issue(caller(), 'm1', endSession);
    expect(queue.add).toHaveBeenLastCalledWith('dispatch', expect.objectContaining({ payload: {} }), expect.anything());
  });

  it('rejects END_SESSION with 409 when the station reports no session', async () => {
    presence.sessionOf.mockReturnValue(null);
    await expect(service.issue(caller(), 'm1', endSession)).rejects.toBeInstanceOf(ConflictException);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('creates a PENDING row and enqueues a job keyed by the commandId', async () => {
    const dto = await service.issue(caller(), 'm1', { type: 'LOCK' });
    expect(dto.status).toBe('PENDING');
    expect(queue.add).toHaveBeenCalledWith(
      'dispatch',
      { commandId: dto.commandId, simulate: undefined },
      expect.objectContaining({ jobId: dto.commandId, attempts: 2 }),
    );
    expect(dashboard.publishToBranch).toHaveBeenCalledWith('b1', 'command_update', expect.objectContaining({ commandId: dto.commandId }));
  });

  it('rejects an offline station with 409 before creating anything', async () => {
    presence.isOnline.mockReturnValue(false);
    await expect(service.issue(caller(), 'm1', { type: 'LOCK' })).rejects.toBeInstanceOf(ConflictException);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('gates SHUTDOWN at admin scope', async () => {
    await expect(service.issue(caller(), 'm1', { type: 'SHUTDOWN' })).rejects.toBeInstanceOf(ForbiddenException);
    const dto = await service.issue(caller({ role: 'MANAGER', scope: 'admin' }), 'm1', { type: 'SHUTDOWN' });
    expect(dto.type).toBe('SHUTDOWN');
  });

  it('marks the command FAILED when the queue is unreachable', async () => {
    queue.add.mockRejectedValue(new Error('ECONNREFUSED'));
    const dto = await service.issue(caller(), 'm1', { type: 'LOCK' });
    expect(dto.status).toBe('FAILED');
    expect(dto.failureReason).toContain('ECONNREFUSED');
  });

  it('records an ack as ACKED and wakes the waiting worker', async () => {
    const waiting = tracker.expect('c1', 5_000);
    await service.onAgentReply('SN-1', 'c1', { kind: 'ack' });
    expect(repo.transition).toHaveBeenCalledWith('c1', ['PENDING', 'SENT', 'TIMEOUT'], expect.objectContaining({ status: 'ACKED' }));
    await expect(waiting).resolves.toEqual({ kind: 'ack' });
  });

  it('records STALE as NACKED, and UNKNOWN_TYPE / EXEC_FAILED as FAILED with their reason', async () => {
    await service.onAgentReply('SN-1', 'c1', { kind: 'nack', code: 'STALE', reason: 'drift' });
    expect(repo.transition).toHaveBeenLastCalledWith(
      'c1',
      expect.any(Array),
      expect.objectContaining({ status: 'NACKED', nackCode: 'STALE', nackReason: 'drift' }),
    );
    await service.onAgentReply('SN-1', 'c1', { kind: 'nack', code: 'EXEC_FAILED', reason: 'Game ID is required.' });
    expect(repo.transition).toHaveBeenLastCalledWith(
      'c1',
      expect.any(Array),
      expect.objectContaining({ status: 'FAILED', nackCode: 'EXEC_FAILED', nackReason: 'Game ID is required.' }),
    );
    await service.onAgentReply('SN-1', 'c1', { kind: 'nack', code: 'UNKNOWN_TYPE', reason: null });
    expect(repo.transition).toHaveBeenLastCalledWith('c1', expect.any(Array), expect.objectContaining({ status: 'FAILED' }));
  });

  it('queues the booking-unlock payload with the job', async () => {
    const payload = { sessionId: '7b0e7a57-2c4e-4d4f-9d5f-0e7c6a1f1a11', pin: '4821' };
    const dto = await service.issue(caller(), 'm1', { type: 'UNLOCK', payload });
    expect(queue.add).toHaveBeenCalledWith('dispatch', expect.objectContaining({ commandId: dto.commandId, payload }), expect.anything());
    // The PIN never reaches the row or the dashboard push.
    expect(JSON.stringify(dto)).not.toContain('4821');
    expect(JSON.stringify(dashboard.publishToBranch.mock.calls)).not.toContain('4821');
  });

  it("ignores a reply for another station's command", async () => {
    presence.resolve.mockReturnValue({ ...STATION, machineId: 'other' });
    await service.onAgentReply('SN-2', 'c1', { kind: 'ack' });
    expect(repo.transition).not.toHaveBeenCalled();
  });
});

describe('CommandProcessor', () => {
  let commands: Record<string, ReturnType<typeof vi.fn>>;
  let gateway: { isConnected: ReturnType<typeof vi.fn>; sendCommand: ReturnType<typeof vi.fn> };
  let presence: { resolveById: ReturnType<typeof vi.fn> };
  let tracker: CommandAckTracker;
  let processor: CommandProcessor;

  const job = (attemptsMade = 0) => ({ data: { commandId: 'c1' }, attemptsMade, opts: { attempts: 2 } }) as any;

  beforeEach(() => {
    commands = {
      findById: vi.fn(async () => row()),
      markSent: vi.fn(async () => row({ status: 'SENT', attempts: 1 })),
      finish: vi.fn(async () => row()),
      fail: vi.fn(async () => row()),
    };
    gateway = { isConnected: vi.fn(() => true), sendCommand: vi.fn(async () => undefined) };
    presence = { resolveById: vi.fn(async () => STATION) };
    tracker = new CommandAckTracker();
    processor = new CommandProcessor(
      commands as any,
      gateway as any,
      presence as any,
      tracker,
      config({ COMMAND_ACK_TIMEOUT_MS: 30 }),
    );
  });

  it('sends with the commandId as envelope id and returns once acked', async () => {
    gateway.sendCommand.mockImplementation(async () => void tracker.settle('c1', { kind: 'ack' }));
    await processor.process(job());
    expect(gateway.sendCommand).toHaveBeenCalledWith('SN-1', 'LOCK', 'c1', {}, undefined);
    expect(commands.markSent).toHaveBeenCalledWith('c1');
    expect(commands.finish).not.toHaveBeenCalled();
  });

  it('exits without sending when the command is already resolved', async () => {
    commands.findById.mockResolvedValue(row({ status: 'ACKED' }));
    await processor.process(job());
    expect(gateway.sendCommand).not.toHaveBeenCalled();
  });

  it('retries a timeout by throwing, then settles TIMEOUT on the last attempt', async () => {
    await expect(processor.process(job(0))).rejects.toThrow('ack timeout');
    expect(commands.finish).not.toHaveBeenCalled();

    await processor.process(job(1));
    expect(commands.finish).toHaveBeenCalledWith('c1', 'TIMEOUT', expect.stringContaining('no ack'));
    // Both attempts carried the same commandId.
    expect(gateway.sendCommand.mock.calls.map((c) => c[2])).toEqual(['c1', 'c1']);
  });

  it('does not hold the job when the station is gone', async () => {
    gateway.isConnected.mockReturnValue(false);
    await processor.process(job());
    expect(commands.finish).toHaveBeenCalledWith('c1', 'FAILED', expect.any(String));
    expect(commands.markSent).not.toHaveBeenCalled();

    gateway.isConnected.mockReturnValue(true);
    gateway.sendCommand.mockRejectedValue(new StationNotConnectedError('SN-1'));
    await processor.process(job());
    expect(commands.finish).toHaveBeenLastCalledWith('c1', 'FAILED', expect.stringContaining('not connected'));
  });

  it('retries a failed socket write, and fails it on the last attempt', async () => {
    gateway.sendCommand.mockRejectedValue(new Error('EPIPE'));
    await expect(processor.process(job(0))).rejects.toThrow('EPIPE');
    await processor.process(job(1));
    expect(commands.fail).toHaveBeenCalledWith('c1', 'send failed: EPIPE');
  });
});

describe('issueCommandBodySchema', () => {
  const sessionId = '7b0e7a57-2c4e-4d4f-9d5f-0e7c6a1f1a11';

  it('treats no payload and {} as the direct (admin) unlock', () => {
    expect(issueCommandBodySchema.parse({ type: 'UNLOCK' }).payload).toBeUndefined();
    expect(issueCommandBodySchema.parse({ type: 'UNLOCK', payload: {} }).payload).toBeUndefined();
  });

  it('accepts a full booking payload for UNLOCK', () => {
    expect(issueCommandBodySchema.parse({ type: 'UNLOCK', payload: { sessionId, pin: '4821' } }).payload).toEqual({
      sessionId,
      pin: '4821',
    });
  });

  it('rejects a partial booking payload, a non-uuid session, and a payload on other types', () => {
    expect(issueCommandBodySchema.safeParse({ type: 'UNLOCK', payload: { pin: '4821' } }).success).toBe(false);
    expect(issueCommandBodySchema.safeParse({ type: 'UNLOCK', payload: { sessionId: 'x', pin: '1' } }).success).toBe(false);
    expect(issueCommandBodySchema.safeParse({ type: 'LOCK', payload: { sessionId, pin: '1' } }).success).toBe(false);
  });

  it('requires a uuid gameId for LAUNCH_GAME only, and takes reason on END_SESSION only', () => {
    expect(issueCommandBodySchema.safeParse({ type: 'LAUNCH_GAME' }).success).toBe(false);
    expect(issueCommandBodySchema.safeParse({ type: 'LAUNCH_GAME', gameId: '' }).success).toBe(false);
    expect(issueCommandBodySchema.safeParse({ type: 'LAUNCH_GAME', gameId: sessionId }).success).toBe(true);
    expect(issueCommandBodySchema.safeParse({ type: 'LOCK', gameId: sessionId }).success).toBe(false);
    expect(issueCommandBodySchema.safeParse({ type: 'END_SESSION' }).success).toBe(true);
    expect(issueCommandBodySchema.parse({ type: 'END_SESSION', reason: ' closing ' }).reason).toBe('closing');
    expect(issueCommandBodySchema.safeParse({ type: 'LOCK', reason: 'x' }).success).toBe(false);
  });
});
