import { ConflictException, ForbiddenException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { StationNotConnectedError } from '../agent.gateway.js';
import { CommandAckTracker } from './command-ack-tracker.js';
import { CommandProcessor } from './command.processor.js';
import { CommandsService } from './commands.service.js';

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
  let tracker: CommandAckTracker;
  let service: CommandsService;

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
    };
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
    );
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

  it('records STALE as NACKED but deterministic nacks as FAILED', async () => {
    await service.onAgentReply('SN-1', 'c1', { kind: 'nack', code: 'STALE', reason: 'drift' });
    expect(repo.transition).toHaveBeenLastCalledWith(
      'c1',
      expect.any(Array),
      expect.objectContaining({ status: 'NACKED', nackCode: 'STALE', nackReason: 'drift' }),
    );
    await service.onAgentReply('SN-1', 'c1', { kind: 'nack', code: 'INVALID_PAYLOAD', reason: null });
    expect(repo.transition).toHaveBeenLastCalledWith('c1', expect.any(Array), expect.objectContaining({ status: 'FAILED' }));
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
