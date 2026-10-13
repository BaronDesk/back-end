import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { stateReportPayloadSchema } from '../schemas/presence.schemas.js';

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
  credentialVersion: 1,
};
const PRINCIPAL = { machineId: 'm1', serialNumber: 'SN-1', branchId: 'b1', version: 1, expiresAt: Date.now() + 86_400_000 };

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
    // A rotated credential: the token of the previous version is refused.
    expect(() => assertStationAdmitted({ ...MACHINE, credentialVersion: 2 } as any, PRINCIPAL)).toThrow(
      StationIdentityMismatchError,
    );
  });
});

describe('PresenceService agent-reported state', () => {
  let service: PresenceService;
  let attention: { recordDisconnect: ReturnType<typeof vi.fn> };
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
    attention = { recordDisconnect: vi.fn(async () => undefined) };
    service = new PresenceService(machines as any, redis as any, config as any, attention as any);
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

  it('reports every ONLINE -> OFFLINE drop for the attention count, once per drop', async () => {
    await service.disconnect('SN-1');
    await service.disconnect('SN-1'); // already OFFLINE: not another drop
    expect(attention.recordDisconnect).toHaveBeenCalledTimes(1);
    expect(attention.recordDisconnect).toHaveBeenCalledWith('m1');
  });

  it('takes runningGameId from state_report only', async () => {
    await service.reportState('SN-1', { runningGameId: 'steam:730' });
    expect(statuses.at(-1)).toEqual(expect.objectContaining({ runningGameId: 'steam:730' }));
    await service.touch('SN-1', { locked: false, sessionId: null });
    expect(statuses.at(-1)?.runningGameId).toBe('steam:730');
  });
});

describe('PresenceService outage classification', () => {
  const T0 = new Date('2026-10-13T10:00:00Z').getTime();
  const machine = (n: number, branchId = 'b1') => ({ ...MACHINE, id: `m${n}`, serialNumber: `SN-${n}`, branchId });
  const rows = new Map([1, 2, 3, 4].map((n) => [`m${n}`, machine(n)]));
  rows.set('m5', machine(5, 'b2'));
  let machines: Record<string, ReturnType<typeof vi.fn>>;
  let service: PresenceService;

  const connect = (n: number) => {
    const row = rows.get(`m${n}`)!;
    return service.connect({ serialNumber: row.serialNumber }, null, { ...PRINCIPAL, machineId: row.id, serialNumber: row.serialNumber, branchId: row.branchId });
  };
  /** The station's last heartbeat at T0 + `seconds`, then its socket closes. */
  const dropAt = async (n: number, seconds: number) => {
    vi.setSystemTime(T0 + seconds * 1000);
    await service.touch(`SN-${n}`, { locked: false, sessionId: null });
    await service.disconnect(`SN-${n}`);
  };

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
    machines = {
      findById: vi.fn(async (id: string) => rows.get(id) ?? null),
      markOnline: vi.fn(async (id: string) => rows.get(id)),
      setStatus: vi.fn(async () => undefined),
      touchLastSeen: vi.fn(async () => undefined),
      findStaleOnline: vi.fn(async () => []),
    };
    service = new PresenceService(machines as any, { hset: vi.fn(async () => 1) } as any, { get: () => undefined } as any, { recordDisconnect: vi.fn() } as any);
    for (const n of [1, 2, 3, 4, 5]) await connect(n);
  });

  afterEach(() => vi.useRealTimers());

  it('calls a station that dropped on its own a single drop', async () => {
    await dropAt(1, 10);
    vi.setSystemTime(T0 + 10 * 60_000);
    await connect(1);
    expect(service.outageOf('SN-1')).toBe('single');
    expect(service.lastContactOf('SN-1')).toEqual(new Date(T0 + 10 * 60_000));
  });

  it('calls it a venue outage when at least 2 other stations of its branch dropped within 60 s of it', async () => {
    await dropAt(1, 10);
    await dropAt(2, 40);
    await dropAt(3, 65);
    vi.setSystemTime(T0 + 10 * 60_000);
    await connect(1);
    expect(service.outageOf('SN-1')).toBe('venue');
  });

  it('counts neither drops outside the window nor stations of another branch', async () => {
    await dropAt(1, 10);
    await dropAt(2, 200); // too late
    await dropAt(5, 20); // other branch
    await dropAt(3, 30);
    vi.setSystemTime(T0 + 10 * 60_000);
    await connect(1);
    expect(service.outageOf('SN-1')).toBe('single');
  });

  it('calls a station recovered OFFLINE after a backend restart a venue outage', async () => {
    const fresh = new PresenceService(machines as any, { hset: vi.fn(async () => 1) } as any, { get: () => undefined } as any, { recordDisconnect: vi.fn() } as any);
    machines.findStaleOnline.mockResolvedValueOnce([{ ...rows.get('m1')!, lastSeen: new Date(T0 - 5 * 60_000) }]);
    await (fresh as any).sweep();
    await fresh.connect({ serialNumber: 'SN-1' }, null, PRINCIPAL);
    expect(fresh.outageOf('SN-1')).toBe('venue');
  });

  it('knows no outage for a station that never went OFFLINE, or that this process never saw go', async () => {
    expect(service.outageOf('SN-1')).toBeNull();
    await connect(1); // reconnected before presence marked it OFFLINE
    expect(service.outageOf('SN-1')).toBeNull();
    expect(service.outageOf('SN-9')).toBeNull();
  });
});

describe('stateReportPayloadSchema', () => {
  it('takes the optional reconnect fields, and drops a malformed one instead of the report', () => {
    const lockedAt = '2026-10-13T10:03:10.000Z';
    expect(
      stateReportPayloadSchema.parse({ locked: true, sessionId: 's1', restarted: false, offlineSince: '2026-10-13T10:00:00Z', lockedAt, lockReason: 'lease_expired' }),
    ).toMatchObject({ restarted: false, offlineSince: '2026-10-13T10:00:00Z', lockedAt, lockReason: 'lease_expired' });

    const parsed = stateReportPayloadSchema.parse({ locked: true, sessionId: 's1', lockedAt: 'yesterday', lockReason: 'power_cut', restarted: 'yes' });
    expect(parsed).toEqual({ locked: true, sessionId: 's1', lockedAt: undefined, lockReason: undefined, restarted: undefined });
    expect(stateReportPayloadSchema.parse({ locked: false })).toEqual({ locked: false });
  });
});
