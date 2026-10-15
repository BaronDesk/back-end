import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { NetworkSimulationService } from './network-simulation.service.js';

const caller = (overrides: Record<string, unknown> = {}) =>
  ({ sub: 'u1', role: 'MANAGER', scope: 'admin', branchId: 'b1', jti: 'j1', ...overrides }) as any;

const STATIONS = [
  { machineId: 'm1', branchId: 'b1', serialNumber: 'SN-1' },
  { machineId: 'm2', branchId: 'b1', serialNumber: 'SN-2' },
  { machineId: 'm3', branchId: 'b2', serialNumber: 'SN-3' },
];

describe('NetworkSimulationService', () => {
  let sockets: Map<string, { terminate: ReturnType<typeof vi.fn> }>;
  let presence: Record<string, ReturnType<typeof vi.fn>>;
  let service: NetworkSimulationService;

  const create = (nodeEnv = 'development') =>
    new NetworkSimulationService(presence as any, { get: (serial: string) => sockets.get(serial) } as any, { get: () => nodeEnv } as any);

  beforeEach(() => {
    vi.useFakeTimers();
    sockets = new Map(STATIONS.map((s) => [s.serialNumber, { terminate: vi.fn() }]));
    presence = {
      resolveById: vi.fn(async (id: string) => STATIONS.find((s) => s.machineId === id) ?? null),
      onlineStations: vi.fn(() => STATIONS),
    };
    service = create();
  });

  afterEach(() => {
    service.onModuleDestroy();
    vi.useRealTimers();
  });

  it('logs when an outage starts and when it ends', async () => {
    const warn = vi.spyOn((service as any).logger, 'warn').mockImplementation(() => undefined);
    await service.dropStation(caller(), 'm1', 5);
    expect(warn).toHaveBeenLastCalledWith('simulated network drop of station SN-1 for 5s started by u1 (socket cut)');
    service.dropBranch(caller(), 'b1', 7);
    expect(warn).toHaveBeenLastCalledWith('simulated venue outage of branch b1 for 7s started by u1: 2 station(s) cut');
    vi.advanceTimersByTime(5_000);
    expect(warn).toHaveBeenLastCalledWith('simulated outage of station SN-1 ended: reconnects accepted again');
    vi.advanceTimersByTime(2_000);
    expect(warn).toHaveBeenLastCalledWith('simulated outage of branch b1 ended: reconnects accepted again');
  });

  it('cuts one station and refuses its reconnects until the outage ends', async () => {
    const result = await service.dropStation(caller(), 'm1', 5);
    expect(result).toMatchObject({ serialNumber: 'SN-1', disconnected: true, droppedUntil: new Date(Date.now() + 5_000).toISOString() });
    expect(sockets.get('SN-1')!.terminate).toHaveBeenCalledTimes(1);
    expect(service.takeVenueCut('SN-1')).toBe(false); // a single drop

    expect(service.refusal(STATIONS[0])).toBe('simulated network drop, 5s left');
    expect(service.refusal(STATIONS[1])).toBeNull();
    vi.advanceTimersByTime(4_999);
    expect(service.refusal(STATIONS[0])).toBe('simulated network drop, 1s left');
    vi.advanceTimersByTime(1);
    expect(service.refusal(STATIONS[0])).toBeNull();
  });

  it('a second drop of the same station replaces the first one', async () => {
    await service.dropStation(caller(), 'm1', 5);
    vi.advanceTimersByTime(3_000);
    await service.dropStation(caller(), 'm1', 10);
    vi.advanceTimersByTime(5_000);
    expect(service.refusal(STATIONS[0])).toBe('simulated network drop, 5s left');
  });

  it('still blocks a station that was not connected', async () => {
    sockets.delete('SN-1');
    await expect(service.dropStation(caller(), 'm1', 5)).resolves.toMatchObject({ disconnected: false });
    expect(service.refusal(STATIONS[0])).not.toBeNull();
  });

  it('cuts every online station of a branch, as a venue outage, and refuses the branch until it ends', () => {
    const result = service.dropBranch(caller(), 'b1', 30);
    expect(result).toMatchObject({ branchId: 'b1', disconnected: ['SN-1', 'SN-2'] });
    expect(sockets.get('SN-3')!.terminate).not.toHaveBeenCalled();
    expect(service.takeVenueCut('SN-1')).toBe(true);
    expect(service.takeVenueCut('SN-1')).toBe(false); // once
    expect(service.takeVenueCut('SN-3')).toBe(false);

    // Any station of the branch, connected before or not.
    expect(service.refusal({ serialNumber: 'SN-9', branchId: 'b1' })).toBe('simulated venue outage, 30s left');
    expect(service.refusal(STATIONS[2])).toBeNull();
    vi.advanceTimersByTime(30_000);
    expect(service.refusal(STATIONS[0])).toBeNull();
  });

  it('keeps a manager to their own branch, and 404s an unknown station', async () => {
    await expect(service.dropStation(caller(), 'm3', 5)).rejects.toMatchObject({ response: { code: 'FORBIDDEN_CROSS_BRANCH' } });
    expect(() => service.dropBranch(caller(), 'b2', 5)).toThrow(expect.objectContaining({ response: expect.objectContaining({ code: 'FORBIDDEN_CROSS_BRANCH' }) }));
    await expect(service.dropStation(caller(), 'nope', 5)).rejects.toMatchObject({ response: { code: 'STATION_NOT_FOUND' } });
    expect(sockets.get('SN-3')!.terminate).not.toHaveBeenCalled();
  });

  it('is disabled in production', async () => {
    service = create('production');
    await expect(service.dropStation(caller(), 'm1', 5)).rejects.toMatchObject({ response: { code: 'SIMULATION_DISABLED' } });
    expect(() => service.dropBranch(caller(), 'b1', 5)).toThrow(expect.objectContaining({ response: expect.objectContaining({ code: 'SIMULATION_DISABLED' }) }));
    expect(sockets.get('SN-1')!.terminate).not.toHaveBeenCalled();
    expect(service.refusal(STATIONS[0])).toBeNull();
  });
});
