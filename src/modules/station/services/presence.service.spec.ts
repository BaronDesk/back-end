import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  assertStationAdmitted,
  PresenceService,
  StationIdentityMismatchError,
  StationNotEnrolledError,
  UnknownStationError,
  type SessionEndedEvent,
  type StationStatusEvent,
} from './presence.service.js';

const MACHINE = {
  id: 'm1',
  branchId: 'b1',
  serialNumber: 'SN-1',
  enrollmentStatus: 'ENROLLED',
  name: 'PC-1',
  status: 'ONLINE',
  lastSeen: new Date(),
  ipAddress: null,
};
const PRINCIPAL = { machineId: 'm1', serialNumber: 'SN-1', branchId: 'b1' };

describe('assertStationAdmitted', () => {
  it('admits an ENROLLED row matching the token', () => {
    expect(() => assertStationAdmitted(MACHINE as any, PRINCIPAL)).not.toThrow();
  });

  it('rejects a missing row, a non-ENROLLED row and a mismatched row', () => {
    expect(() => assertStationAdmitted(null, PRINCIPAL)).toThrow(UnknownStationError);
    for (const enrollmentStatus of ['PENDING', 'INACTIVE', 'DEACTIVATED']) {
      expect(() => assertStationAdmitted({ ...MACHINE, enrollmentStatus } as any, PRINCIPAL)).toThrow(
        StationNotEnrolledError,
      );
    }
    expect(() => assertStationAdmitted({ ...MACHINE, serialNumber: 'SN-2' } as any, PRINCIPAL)).toThrow(
      StationIdentityMismatchError,
    );
  });
});

describe('PresenceService agent-reported state', () => {
  let service: PresenceService;
  let statuses: StationStatusEvent[];
  let ended: SessionEndedEvent[];

  beforeEach(async () => {
    const machines = {
      findById: vi.fn(async () => MACHINE),
      markOnline: vi.fn(async () => MACHINE),
      setStatus: vi.fn(async () => MACHINE),
      touchLastSeen: vi.fn(async () => MACHINE),
    };
    const redis = { hset: vi.fn(async () => 1) };
    const config = { get: () => undefined };
    service = new PresenceService(machines as any, redis as any, config as any);
    statuses = [];
    ended = [];
    service.statusChanges.subscribe((e) => statuses.push(e));
    service.sessionEnded.subscribe((e) => ended.push(e));
    await service.connect({ serialNumber: 'SN-1' }, null, PRINCIPAL);
    statuses.length = 0;
  });

  it('pushes station_status only when locked / sessionId change', async () => {
    await service.touch('SN-1', { locked: false, sessionId: 'sess-1' });
    await service.touch('SN-1', { locked: false, sessionId: 'sess-1' });
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toEqual(
      expect.objectContaining({
        locked: false,
        sessionId: 'sess-1',
        runningGameId: null,
      }),
    );
    expect(service.sessionOf('SN-1')).toBe('sess-1');
  });

  it('emits session.ended with the END_SESSION reason when the agent reports the session gone', async () => {
    await service.touch('SN-1', { locked: false, sessionId: 'sess-1' });
    service.expectSessionEnd('SN-1', 'closing');
    // What the agent does on END_SESSION: session cleared, station locked.
    await service.touch('SN-1', { locked: true, sessionId: null });

    expect(ended).toEqual([
      expect.objectContaining({
        machineId: 'm1',
        sessionId: 'sess-1',
        reason: 'closing',
      }),
    ]);
    expect(statuses.at(-1)).toEqual(expect.objectContaining({ locked: true, sessionId: null }));
    expect(service.sessionOf('SN-1')).toBeNull();
  });

  it('labels an unrequested session end as agent_reported', async () => {
    await service.touch('SN-1', { locked: false, sessionId: 'sess-1' });
    await service.touch('SN-1', { locked: true, sessionId: null });
    expect(ended[0]?.reason).toBe('agent_reported');
  });

  it('takes runningGameId from state_report only', async () => {
    await service.reportState('SN-1', { runningGameId: 'steam:730' });
    expect(statuses.at(-1)).toEqual(expect.objectContaining({ runningGameId: 'steam:730' }));
    await service.touch('SN-1', { locked: false, sessionId: null });
    expect(statuses.at(-1)?.runningGameId).toBe('steam:730');
  });
});
