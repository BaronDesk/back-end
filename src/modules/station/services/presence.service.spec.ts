import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PresenceService, type SessionEndedEvent, type StationStatusEvent } from './presence.service.js';

const MACHINE = {
  id: 'm1',
  branchId: 'b1',
  serialNumber: 'SN-1',
  name: 'PC-1',
  status: 'ONLINE',
  lastSeen: new Date(),
  ipAddress: null,
};

describe('PresenceService agent-reported state', () => {
  let service: PresenceService;
  let statuses: StationStatusEvent[];
  let ended: SessionEndedEvent[];

  beforeEach(async () => {
    const machines = {
      findBySerial: vi.fn(async () => MACHINE),
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
    await service.connect({ serialNumber: 'SN-1' }, null);
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
