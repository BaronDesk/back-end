import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { StationNotConnectedError } from '../agent.gateway.js';
import { CommandAckTracker } from './command-ack-tracker.js';
import { CommandProcessor } from './command.processor.js';
import { CommandsService, STATION_OFFLINE_MESSAGE, SYSTEM_ACTOR_ID } from './commands.service.js';
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
  let games: { findLaunchable: ReturnType<typeof vi.fn>; catalogChanges: Subject<unknown> };
  let tracker: CommandAckTracker;
  let sessions: Record<string, ReturnType<typeof vi.fn>>;
  let audit: { record: ReturnType<typeof vi.fn> };
  let attention: { flag: ReturnType<typeof vi.fn>; failedCommandsThreshold: number; changes: Subject<any> };
  let stationPolicy: { effectiveFor: ReturnType<typeof vi.fn>; branchPolicyChanges: Subject<{ branchId: string }> };
  let service: CommandsService;

  const EFFECTIVE = { cpuTempAlertThreshold: 80, heartbeatIntervalSeconds: 15, defaultLeaseDurationSeconds: 60, leaseGracePeriodSeconds: 10 };

  const GAME = { id: '9d3c1f4e-8a55-4d1b-9a36-2f0f5c1e7b20', gameId: 'cs2', enabled: true };
  const launch = { type: 'LAUNCH_GAME' as const, gameId: 'cs2', payload: undefined };
  const endSession = { type: 'END_SESSION' as const, payload: undefined };

  beforeEach(() => {
    repo = {
      create: vi.fn(async (data) => row(data)),
             findById: vi.fn(async () => row({ status: 'SENT' })),
             hasOpen: vi.fn(async () => false),
             transition: vi.fn(async (_id, _from, data) => row(data)),
             listForMachine: vi.fn(),
    };
    presence = {
      resolveById: vi.fn(async () => STATION),
             resolve: vi.fn(() => STATION),
             isOnline: vi.fn(() => true),
             sessionOf: vi.fn(() => 'sess-1'),
             agentStateOf: vi.fn(() => ({ locked: false, sessionId: 'sess-1', runningGameId: null })),
             expectSessionEnd: vi.fn(),
             onlineStations: vi.fn(() => [STATION]),
    };
    games = { findLaunchable: vi.fn(async () => GAME), catalogChanges: new Subject() };
    registry = { has: vi.fn(() => true) };
    dashboard = { publishToBranch: vi.fn() };
    queue = { add: vi.fn(async () => ({})) };
    tracker = new CommandAckTracker();
    sessions = {
      unlockFor: vi.fn(async () => ({ sessionId: 'sess-1', leaseSeconds: 180, serverTime: new Date().toISOString() })),
      closeForShutdown: vi.fn(async () => undefined),
      markStaffLock: vi.fn(async () => undefined),
      lockWhileOffline: vi.fn(async () => false),
      endWhileOffline: vi.fn(async () => false),
    };
    audit = { record: vi.fn(async () => undefined) };
    attention = { flag: vi.fn(async () => true), failedCommandsThreshold: 3, changes: new Subject() };
    repo.lastStaffOutcomes = vi.fn(async () => []);
    stationPolicy = { effectiveFor: vi.fn(async () => EFFECTIVE), branchPolicyChanges: new Subject() };
    const port = { current: sessions };
    service = new CommandsService(
      repo as any,
      presence as any,
      registry as any,
      dashboard as any,
      tracker,
      queue as any,
      config({ NODE_ENV: 'development', COMMAND_MAX_ATTEMPTS: 2 }),
      games as any,
      port as any,
      audit as any,
      attention as any,
      stationPolicy as any,
    );
  });

  it('queues LAUNCH_GAME with the catalog gameId only', async () => {
    const dto = await service.issue(caller(), 'm1', launch);
    expect(games.findLaunchable).toHaveBeenCalledWith(STATION, 'cs2');
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'LAUNCH_GAME', gameId: GAME.id }));
    expect(queue.add).toHaveBeenCalledWith(
      'dispatch',
      expect.objectContaining({ commandId: dto.commandId, payload: { gameId: 'cs2' } }),
                                           expect.anything(),
    );
  });

  it('rejects LAUNCH_GAME with 409 while the station is locked or has no session', async () => {
    presence.agentStateOf.mockReturnValueOnce({ locked: true, sessionId: 'sess-1', runningGameId: null });
    await expect(service.issue(caller(), 'm1', launch)).rejects.toBeInstanceOf(ConflictException);
    presence.agentStateOf.mockReturnValueOnce({ locked: false, sessionId: null, runningGameId: null });
    await expect(service.issue(caller(), 'm1', launch)).rejects.toBeInstanceOf(ConflictException);
    expect(games.findLaunchable).not.toHaveBeenCalled();
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('skips the LAUNCH_GAME pre-checks for the agent-rejection simulations', async () => {
    presence.agentStateOf.mockReturnValue({ locked: true, sessionId: null, runningGameId: null });
    await service.issue(caller(), 'm1', { ...launch, simulate: 'invalid_payload' });
    expect(games.findLaunchable).not.toHaveBeenCalled();
    expect(queue.add).toHaveBeenCalledWith('dispatch', expect.objectContaining({ simulate: 'invalid_payload' }), expect.anything());
  });

  it('sends CATALOG_UPDATE to online stations whose catalog changed, once', async () => {
    await service.requestCatalogSync({ branchIds: ['b1'], machineIds: [], issuedBy: 'u1' });
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'CATALOG_UPDATE', machineId: 'm1' }));
    expect(queue.add).toHaveBeenCalledWith('dispatch', expect.objectContaining({ payload: {} }), expect.anything());

    repo.hasOpen.mockResolvedValue(true);
    await service.requestCatalogSync({ branchIds: [], machineIds: ['m1'], issuedBy: 'u1' });
    await service.requestCatalogSync({ branchIds: ['other'], machineIds: [], issuedBy: 'u1' });
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it('rejects LAUNCH_GAME for a missing, unassigned or uninstalled game before creating anything', async () => {
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

  describe('stations needing attention', () => {
    it('flags the station when its last 3 staff commands all ended FAILED or TIMEOUT', async () => {
      repo.lastStaffOutcomes.mockResolvedValueOnce(['FAILED', 'TIMEOUT', 'FAILED']);
      await service.finish('c1', 'TIMEOUT', 'no ack');
      expect(repo.lastStaffOutcomes).toHaveBeenCalledWith('m1', SYSTEM_ACTOR_ID, 3);
      expect(attention.flag).toHaveBeenCalledWith('m1', 'commands_failed');
    });

    it('does not flag while an ack breaks the run, or fewer than 3 staff commands have an outcome', async () => {
      repo.lastStaffOutcomes.mockResolvedValueOnce(['FAILED', 'ACKED', 'FAILED']);
      await service.finish('c1', 'FAILED', 'x');
      repo.lastStaffOutcomes.mockResolvedValueOnce(['FAILED', 'FAILED']);
      await service.finish('c1', 'FAILED', 'x');
      expect(attention.flag).not.toHaveBeenCalled();
    });

    it('counts a nack that ends FAILED, never an ack', async () => {
      repo.lastStaffOutcomes.mockResolvedValue(['FAILED', 'FAILED', 'FAILED']);
      await service.onAgentReply('SN-1', 'c1', { kind: 'ack' });
      expect(repo.lastStaffOutcomes).not.toHaveBeenCalled();
      await service.onAgentReply('SN-1', 'c1', { kind: 'nack', code: 'EXEC_FAILED', reason: 'boom' });
      expect(attention.flag).toHaveBeenCalledWith('m1', 'commands_failed');
    });

    it('ignores system sends and CATALOG_UPDATE', async () => {
      repo.lastStaffOutcomes.mockResolvedValue(['FAILED', 'FAILED', 'FAILED']);
      repo.transition.mockResolvedValueOnce(row({ status: 'FAILED', issuedBy: SYSTEM_ACTOR_ID, type: 'POLICY_UPDATE' }));
      await service.finish('c1', 'FAILED', 'x');
      repo.transition.mockResolvedValueOnce(row({ status: 'FAILED', type: 'CATALOG_UPDATE' }));
      await service.finish('c1', 'FAILED', 'x');
      expect(repo.lastStaffOutcomes).not.toHaveBeenCalled();
      expect(attention.flag).not.toHaveBeenCalled();
    });

    it('relays a flag set or cleared to the branch room as station_attention', async () => {
      service.onModuleInit();
      attention.changes.next({ machineId: 'm1', branchId: 'b1', serialNumber: 'SN-1', needsAttention: true, reason: 'disconnects', since: 'T' });
      expect(dashboard.publishToBranch).toHaveBeenCalledWith('b1', 'station_attention', {
        machineId: 'm1', serialNumber: 'SN-1', needsAttention: true, reason: 'disconnects', since: 'T',
      });
    });
  });

  describe('station policy', () => {
    beforeEach(() => service.onModuleInit());

    it("stores a staff POLICY_UPDATE as the station's own policy and sends the station its effective policy", async () => {
      presence.setPolicy = vi.fn(async () => undefined);
      await service.issue(caller(), 'm1', { type: 'POLICY_UPDATE', policy: { cpuTempAlertThreshold: 80 } });
      expect(presence.setPolicy).toHaveBeenCalledWith('m1', { cpuTempAlertThreshold: 80 });
      expect(stationPolicy.effectiveFor).toHaveBeenCalledWith('m1');
      expect(queue.add).toHaveBeenCalledWith('dispatch', expect.objectContaining({ payload: EFFECTIVE }), expect.anything());
    });

    it('issuePolicyUpdate sends the effective policy, timing included, as a system command', async () => {
      expect(await service.issuePolicyUpdate('m1')).toBe(true);
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'POLICY_UPDATE', issuedBy: SYSTEM_ACTOR_ID }));
      expect(queue.add).toHaveBeenCalledWith('dispatch', expect.objectContaining({ payload: EFFECTIVE }), expect.anything());

      stationPolicy.effectiveFor.mockResolvedValueOnce(null);
      expect(await service.issuePolicyUpdate('gone')).toBe(false);
      expect(repo.create).toHaveBeenCalledTimes(1);
    });

    it("pushes a branch's new default to its online stations only", async () => {
      const other = { machineId: 'm2', branchId: 'b2', serialNumber: 'SN-2' };
      const third = { machineId: 'm3', branchId: 'b1', serialNumber: 'SN-3' };
      presence.onlineStations.mockReturnValue([STATION, other, third]);
      presence.resolveById.mockImplementation(async (id: string) => [STATION, other, third].find((s) => s.machineId === id));
      registry.has.mockImplementation((serial: string) => serial !== 'SN-3'); // SN-3: no live socket

      stationPolicy.branchPolicyChanges.next({ branchId: 'b1' });
      await vi.waitFor(() => expect(repo.create).toHaveBeenCalled());
      expect(stationPolicy.effectiveFor).toHaveBeenCalledWith('m1');
      expect(repo.create).toHaveBeenCalledTimes(1);
      expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'POLICY_UPDATE', machineId: 'm1' }));
    });
  });

  it('marks the session locked by staff when a LOCK goes out', async () => {
    await service.issue(caller(), 'm1', { type: 'LOCK' });
    expect(sessions.markStaffLock).toHaveBeenCalledWith(STATION);
    await service.issue(caller(), 'm1', { type: 'LOCK', simulate: 'stale_ts' });
    expect(sessions.markStaffLock).toHaveBeenCalledTimes(1);
  });

  describe('a station that is not connected', () => {
    beforeEach(() => presence.isOnline.mockReturnValue(false));

    it('applies a staff LOCK to its open session: APPLIED_ON_RECONNECT, audited, never queued', async () => {
      sessions.lockWhileOffline.mockResolvedValueOnce(true);
      const dto = await service.issue(caller(), 'm1', { type: 'LOCK' });
      expect(sessions.lockWhileOffline).toHaveBeenCalledWith(STATION);
      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'LOCK', issuedBy: 'u1', status: 'APPLIED_ON_RECONNECT', resolvedAt: expect.any(Date) }),
      );
      expect(dto.status).toBe('APPLIED_ON_RECONNECT');
      expect(queue.add).not.toHaveBeenCalled();
      expect(dashboard.publishToBranch).toHaveBeenCalledWith('b1', 'command_update', expect.objectContaining({ status: 'APPLIED_ON_RECONNECT' }));
      expect(audit.record).toHaveBeenCalledWith('u1', 'UPDATE', 'machine:m1', {
        branchId: 'b1',
        metadata: { event: 'STATION_LOCK_APPLIED_ON_RECONNECT', commandId: dto.commandId },
      });
    });

    it('applies a staff END_SESSION by closing its open session from server state', async () => {
      sessions.endWhileOffline.mockResolvedValueOnce(true);
      const dto = await service.issue(caller(), 'm1', { ...endSession, reason: 'closing' });
      expect(sessions.endWhileOffline).toHaveBeenCalledWith(STATION, 'closing');
      expect(dto).toMatchObject({ type: 'END_SESSION', status: 'APPLIED_ON_RECONNECT' });
      expect(presence.expectSessionEnd).not.toHaveBeenCalled();
      expect(audit.record).toHaveBeenCalledWith('u1', 'UPDATE', 'machine:m1', expect.objectContaining({
        metadata: expect.objectContaining({ event: 'STATION_END_SESSION_APPLIED_ON_RECONNECT' }),
      }));
    });

    it('refuses a LOCK or END_SESSION when no session is open there', async () => {
      await expect(service.issue(caller(), 'm1', { type: 'LOCK' })).rejects.toMatchObject({ response: { code: 'STATION_OFFLINE' } });
      await expect(service.issue(caller(), 'm1', endSession)).rejects.toMatchObject({ response: { code: 'STATION_OFFLINE' } });
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('refuses SHUTDOWN, LAUNCH_GAME and UNLOCK with a clear message, never applying or queueing them', async () => {
      for (const body of [{ type: 'SHUTDOWN' as const }, launch, { type: 'UNLOCK' as const }]) {
        await expect(service.issue(caller({ role: 'MANAGER', scope: 'admin' }), 'm1', body)).rejects.toMatchObject({
          response: { code: 'STATION_OFFLINE', error: STATION_OFFLINE_MESSAGE },
        });
      }
      expect(STATION_OFFLINE_MESSAGE).toBe('station offline, try again when it is back');
      expect(sessions.closeForShutdown).not.toHaveBeenCalled();
      expect(sessions.lockWhileOffline).not.toHaveBeenCalled();
      expect(repo.create).not.toHaveBeenCalled();
      expect(queue.add).not.toHaveBeenCalled();
    });
  });

  describe('resolveUndelivered (the worker could not reach the station)', () => {
    it('applies a staff LOCK it could not deliver and records APPLIED_ON_RECONNECT', async () => {
      sessions.lockWhileOffline.mockResolvedValueOnce(true);
      await service.resolveUndelivered('c1', 'FAILED', STATION_OFFLINE_MESSAGE);
      expect(sessions.lockWhileOffline).toHaveBeenCalledWith(STATION);
      expect(repo.transition).toHaveBeenCalledWith('c1', ['PENDING', 'SENT'], expect.objectContaining({ status: 'APPLIED_ON_RECONNECT' }));
      expect(audit.record).toHaveBeenCalledWith('u1', 'UPDATE', 'machine:m1', expect.objectContaining({
        metadata: expect.objectContaining({ event: 'STATION_LOCK_APPLIED_ON_RECONNECT' }),
      }));
    });

    it('applies an unacknowledged staff END_SESSION with its reason', async () => {
      repo.findById.mockResolvedValueOnce(row({ type: 'END_SESSION', status: 'SENT' }));
      sessions.endWhileOffline.mockResolvedValueOnce(true);
      await service.resolveUndelivered('c1', 'TIMEOUT', 'no ack', { reason: 'closing' });
      expect(sessions.endWhileOffline).toHaveBeenCalledWith(STATION, 'closing');
      expect(repo.transition).toHaveBeenCalledWith('c1', expect.any(Array), expect.objectContaining({ status: 'APPLIED_ON_RECONNECT' }));
    });

    it('fails a SHUTDOWN, a system LOCK, or a LOCK with no open session, and delivers nothing later', async () => {
      repo.findById.mockResolvedValueOnce(row({ type: 'SHUTDOWN' }));
      await service.resolveUndelivered('c1', 'FAILED', STATION_OFFLINE_MESSAGE);
      expect(repo.transition).toHaveBeenLastCalledWith('c1', ['PENDING', 'SENT'], expect.objectContaining({ status: 'FAILED', failureReason: STATION_OFFLINE_MESSAGE }));

      repo.findById.mockResolvedValueOnce(row({ issuedBy: SYSTEM_ACTOR_ID }));
      await service.resolveUndelivered('c1', 'FAILED', STATION_OFFLINE_MESSAGE);
      expect(repo.transition).toHaveBeenLastCalledWith('c1', expect.any(Array), expect.objectContaining({ status: 'FAILED' }));

      await service.resolveUndelivered('c1', 'TIMEOUT', 'no ack');
      expect(repo.transition).toHaveBeenLastCalledWith('c1', expect.any(Array), expect.objectContaining({ status: 'TIMEOUT' }));
      expect(sessions.lockWhileOffline).toHaveBeenCalledTimes(1);
      expect(audit.record).not.toHaveBeenCalled();
    });
  });

  it('gates SHUTDOWN at admin scope', async () => {
    await expect(service.issue(caller(), 'm1', { type: 'SHUTDOWN' })).rejects.toBeInstanceOf(ForbiddenException);
    const dto = await service.issue(caller({ role: 'MANAGER', scope: 'admin' }), 'm1', { type: 'SHUTDOWN' });
    expect(dto.type).toBe('SHUTDOWN');
    // The session is settled before the PC goes dark.
    expect(sessions.closeForShutdown).toHaveBeenCalledWith(STATION);
  });

  it("sends a staff UNLOCK into the station's own session, and refuses one without", async () => {
    await service.issue(caller(), 'm1', { type: 'UNLOCK' });
    expect(queue.add).toHaveBeenCalledWith('dispatch', expect.objectContaining({ payload: expect.objectContaining({ sessionId: 'sess-1' }) }), expect.anything());

    sessions.unlockFor.mockRejectedValueOnce(new ConflictException({ code: 'NO_SESSION_TO_UNLOCK' }));
    await expect(service.issue(caller(), 'm1', { type: 'UNLOCK' })).rejects.toMatchObject({ response: { code: 'NO_SESSION_TO_UNLOCK' } });
    expect(repo.create).toHaveBeenCalledTimes(1);
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
    await service.onAgentReply('SN-1', 'c1', { kind: 'nack', code: 'INVALID_PAYLOAD', reason: 'sessionId is required.' });
    expect(repo.transition).toHaveBeenLastCalledWith(
      'c1',
      expect.any(Array),
                                                     expect.objectContaining({ status: 'FAILED', nackCode: 'INVALID_PAYLOAD', nackReason: 'sessionId is required.' }),
    );
  });

  it('issueSessionUnlock queues a system UNLOCK carrying the session and its lease, never a PIN', async () => {
    const payload = { sessionId: '7b0e7a57-2c4e-4d4f-9d5f-0e7c6a1f1a11', leaseSeconds: 180, serverTime: new Date().toISOString() };
    expect(await service.issueSessionUnlock('m1', payload, 'login accepted')).toBe(true);
    expect(repo.create).toHaveBeenCalledWith(expect.objectContaining({ type: 'UNLOCK', issuedBy: SYSTEM_ACTOR_ID }));
    expect(queue.add).toHaveBeenCalledWith('dispatch', expect.objectContaining({ payload }), expect.anything());
    expect(queue.add.mock.calls[0][1].payload).not.toHaveProperty('pin');
  });

  it('issueSessionUnlock is refused for an offline station', async () => {
    presence.isOnline.mockReturnValueOnce(false);
    const payload = { sessionId: 's', leaseSeconds: 60, serverTime: new Date().toISOString() };
    expect(await service.issueSessionUnlock('m1', payload, 'resume')).toBe(false);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('issueSystemEndSession labels the session end, and sends one only while the station holds that very session', async () => {
    expect(await service.issueSystemEndSession('m1', 'reservation_ended', 'sess-1')).toBe(true);
    expect(presence.expectSessionEnd).toHaveBeenCalledWith('SN-1', 'reservation_ended');
    expect(queue.add).toHaveBeenCalledWith('dispatch', expect.objectContaining({ payload: { reason: 'reservation_ended' } }), expect.anything());

    repo.hasOpen.mockResolvedValueOnce(true);
    expect(await service.issueSystemEndSession('m1', 'reservation_ended', 'sess-1')).toBe(false);
    presence.sessionOf.mockReturnValueOnce(null);
    expect(await service.issueSystemEndSession('m1', 'reservation_ended', 'sess-1')).toBe(false);
    // The PC already runs the next gamer's session: never end theirs.
    expect(await service.issueSystemEndSession('m1', 'reservation_ended', 'old-session')).toBe(false);
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it("ignores a reply for another station's command", async () => {
    presence.resolve.mockReturnValue({ ...STATION, machineId: 'other' });
    await service.onAgentReply('SN-2', 'c1', { kind: 'ack' });
    expect(repo.transition).not.toHaveBeenCalled();
  });

  it('issueSystemLock dispatches a LOCK issued by SYSTEM_ACTOR_ID for an online station', async () => {
    await service.issueSystemLock('m1', 'runout');
    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'LOCK', machineId: 'm1', branchId: 'b1', issuedBy: SYSTEM_ACTOR_ID }),
    );
    expect(queue.add).toHaveBeenCalledWith('dispatch', expect.objectContaining({ payload: undefined }), expect.anything());
  });

  it('issueSystemLock is a no-op when the station no longer exists', async () => {
    presence.resolveById.mockResolvedValueOnce(null);
    await service.issueSystemLock('gone', 'runout');
    expect(repo.create).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('issueSystemLock is a no-op when the station is offline', async () => {
    presence.isOnline.mockReturnValueOnce(false);
    await service.issueSystemLock('m1', 'runout');
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('issueSystemLock is a no-op when the station has no live socket', async () => {
    registry.has.mockReturnValueOnce(false);
    await service.issueSystemLock('m1', 'runout');
    expect(repo.create).not.toHaveBeenCalled();
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
             resolveUndelivered: vi.fn(async () => row()),
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
    expect(commands.resolveUndelivered).toHaveBeenCalledWith('c1', 'TIMEOUT', expect.stringContaining('no ack'), undefined);
    // Both attempts carried the same commandId.
    expect(gateway.sendCommand.mock.calls.map((c) => c[2])).toEqual(['c1', 'c1']);
  });

  it('does not hold the job when the station is gone', async () => {
    gateway.isConnected.mockReturnValue(false);
    await processor.process(job());
    expect(commands.resolveUndelivered).toHaveBeenCalledWith('c1', 'FAILED', STATION_OFFLINE_MESSAGE, undefined);
    expect(commands.markSent).not.toHaveBeenCalled();

    gateway.isConnected.mockReturnValue(true);
    gateway.sendCommand.mockRejectedValue(new StationNotConnectedError('SN-1'));
    await processor.process(job());
    expect(commands.resolveUndelivered).toHaveBeenLastCalledWith('c1', 'FAILED', STATION_OFFLINE_MESSAGE, undefined);
    expect(commands.finish).not.toHaveBeenCalled();
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
  expect(issueCommandBodySchema.parse({ type: 'UNLOCK' })).not.toHaveProperty('payload');
  expect(issueCommandBodySchema.parse({ type: 'UNLOCK', payload: {} })).not.toHaveProperty('payload');
});

it('rejects any session or PIN payload: a session UNLOCK is backend-issued after login', () => {
  expect(issueCommandBodySchema.safeParse({ type: 'UNLOCK', payload: { sessionId, pin: '4821' } }).success).toBe(false);
  expect(issueCommandBodySchema.safeParse({ type: 'UNLOCK', payload: { sessionId, leaseSeconds: 60 } }).success).toBe(false);
  expect(issueCommandBodySchema.safeParse({ type: 'LOCK', payload: { sessionId } }).success).toBe(false);
});

it('requires a gameId for LAUNCH_GAME only, and takes reason on END_SESSION only', () => {
  expect(issueCommandBodySchema.safeParse({ type: 'LAUNCH_GAME' }).success).toBe(false);
  expect(issueCommandBodySchema.safeParse({ type: 'LAUNCH_GAME', gameId: ' ' }).success).toBe(false);
  expect(issueCommandBodySchema.safeParse({ type: 'LAUNCH_GAME', gameId: 'x'.repeat(129) }).success).toBe(false);
  expect(issueCommandBodySchema.safeParse({ type: 'LAUNCH_GAME', gameId: 'cs2' }).success).toBe(true);
  expect(issueCommandBodySchema.safeParse({ type: 'CATALOG_UPDATE' }).success).toBe(true);
  expect(issueCommandBodySchema.safeParse({ type: 'LOCK', gameId: sessionId }).success).toBe(false);
  expect(issueCommandBodySchema.safeParse({ type: 'END_SESSION' }).success).toBe(true);
  expect(issueCommandBodySchema.parse({ type: 'END_SESSION', reason: ' closing ' }).reason).toBe('closing');
  expect(issueCommandBodySchema.safeParse({ type: 'LOCK', reason: 'x' }).success).toBe(false);
});
});
