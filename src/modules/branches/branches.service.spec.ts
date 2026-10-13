import { describe, expect, it, vi } from 'vitest';

import { BranchesService } from './branches.service.js';

const NOW = new Date('2026-09-30T18:00:00Z');
const at = (min: number) => new Date(NOW.getTime() + min * 60_000);

describe('BranchesService.stations', () => {
  it('tells for each station whether it is online, busy now and until when (back-to-back bookings chained)', async () => {
    const repo = {
      findById: vi.fn(async () => ({ id: 'b1', name: 'El Manar', location: 'Tunis' })),
      stationsWithBookings: vi.fn(async () => [
        {
          id: 'm1', name: 'PC-01', serialNumber: 'MNR-01', status: 'ONLINE',
          reservations: [
            { startTime: at(-30), endTime: at(30) },
            { startTime: at(30), endTime: at(90) },
            { startTime: at(180), endTime: at(240) },
          ],
        },
        { id: 'm2', name: null, serialNumber: 'MNR-02', status: 'OFFLINE', reservations: [] },
      ]),
    };
    const presence = { isOnline: vi.fn((serial: string) => serial === 'MNR-01') };
    const service = new BranchesService(repo as any, presence as any, { record: vi.fn() } as any, {} as any);

    const [busy, free] = await service.stations('b1', NOW);
    expect(busy).toMatchObject({ id: 'm1', name: 'PC-01', online: true, busyNow: true, busyUntil: at(90).toISOString() });
    expect(busy.bookings).toHaveLength(3);
    expect(free).toMatchObject({ id: 'm2', name: 'MNR-02', online: false, busyNow: false, busyUntil: null, bookings: [] });
  });

  it('404s an unknown branch', async () => {
    const service = new BranchesService({ findById: vi.fn(async () => null) } as any, {} as any, { record: vi.fn() } as any, {} as any);
    await expect(service.stations('nope')).rejects.toMatchObject({ response: { code: 'BRANCH_NOT_FOUND' } });
  });
});

describe('BranchesService station policy', () => {
  const admin = (branchId = 'b1') => ({ sub: 'u1', role: 'MANAGER', scope: 'admin', branchId, jti: 'j' }) as any;

  function setup() {
    const repo = { findById: vi.fn(async (id: string) => (id === 'b1' ? { id: 'b1', name: 'El Manar', location: 'Tunis' } : null)) };
    const audit = { record: vi.fn(async () => undefined) };
    const policies = {
      getBranchPolicy: vi.fn(async (id: string) => (id === 'b1' ? { gpuTempAlertThreshold: 88 } : null)),
      setBranchPolicy: vi.fn(async (_id: string, policy: unknown) => policy),
    };
    return { repo, audit, policies, service: new BranchesService(repo as any, {} as any, audit as any, policies as any) };
  }

  it("reads the branch's default policy", async () => {
    const { service } = setup();
    await expect(service.stationPolicy(admin(), 'b1')).resolves.toEqual({ branchId: 'b1', policy: { gpuTempAlertThreshold: 88 } });
  });

  it('replaces it, audit-logged; the station policy service pushes it to the stations', async () => {
    const { service, policies, audit } = setup();
    const result = await service.setStationPolicy(admin(), 'b1', { cpuTempAlertThreshold: 85 });
    expect(result).toEqual({ branchId: 'b1', policy: { cpuTempAlertThreshold: 85 } });
    expect(policies.setBranchPolicy).toHaveBeenCalledWith('b1', { cpuTempAlertThreshold: 85 });
    expect(audit.record).toHaveBeenCalledWith('u1', 'UPDATE', 'branch:b1', {
      branchId: 'b1',
      metadata: { event: 'BRANCH_STATION_POLICY_UPDATED', policy: { cpuTempAlertThreshold: 85 } },
    });
  });

  it("refuses another branch's admin, and 404s an unknown branch", async () => {
    const { service, policies, audit } = setup();
    await expect(service.setStationPolicy(admin('b2'), 'b1', {})).rejects.toMatchObject({ response: { code: 'FORBIDDEN_CROSS_BRANCH' } });
    await expect(service.stationPolicy(admin('b2'), 'b1')).rejects.toMatchObject({ response: { code: 'FORBIDDEN_CROSS_BRANCH' } });
    const hq = { ...admin(), scope: 'hq', branchId: null };
    await expect(service.setStationPolicy(hq, 'nope', {})).rejects.toMatchObject({ response: { code: 'BRANCH_NOT_FOUND' } });
    await expect(service.stationPolicy(hq, 'nope')).rejects.toMatchObject({ response: { code: 'BRANCH_NOT_FOUND' } });
    expect(policies.setBranchPolicy).not.toHaveBeenCalled();
    expect(audit.record).not.toHaveBeenCalled();
  });
});
