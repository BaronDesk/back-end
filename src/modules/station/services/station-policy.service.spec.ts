import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StationPolicyService } from './station-policy.service.js';

const TIMING = { heartbeatIntervalSeconds: 15, defaultLeaseDurationSeconds: 60, leaseGracePeriodSeconds: 10 };

describe('StationPolicyService', () => {
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let service: StationPolicyService;
  let changes: { branchId: string }[];

  beforeEach(() => {
    repo = {
      findForMachine: vi.fn(async () => ({ policy: null, branch: { stationPolicy: null } })),
      findBranchPolicy: vi.fn(async () => null),
      setBranchPolicy: vi.fn(async () => undefined),
    };
    service = new StationPolicyService(repo as any, { get: () => undefined } as any);
    changes = [];
    service.branchPolicyChanges.subscribe((c) => changes.push(c));
  });

  it("is the branch default overridden field by field by the station's own policy, plus the backend's timing", async () => {
    repo.findForMachine.mockResolvedValueOnce({
      policy: { cpuTempAlertThreshold: 80, telemetryCadenceSeconds: 5 },
      branch: { stationPolicy: { cpuTempAlertThreshold: 90, gpuTempAlertThreshold: 95, telemetryCadenceSeconds: 10 } },
    });
    await expect(service.effectiveFor('m1')).resolves.toEqual({
      cpuTempAlertThreshold: 80,
      gpuTempAlertThreshold: 95,
      telemetryCadenceSeconds: 5,
      ...TIMING,
    });
    expect(repo.findForMachine).toHaveBeenCalledWith('m1');
  });

  it('always carries the timing, even with no policy at all, and never lets a stored policy change it', async () => {
    await expect(service.effectiveFor('m1')).resolves.toEqual(TIMING);
    repo.findForMachine.mockResolvedValueOnce({
      policy: { heartbeatIntervalSeconds: 1, defaultLeaseDurationSeconds: 9999, junk: true, usbDebounceWindowSeconds: 'x' },
      branch: { stationPolicy: [1, 2] },
    });
    await expect(service.effectiveFor('m1')).resolves.toEqual(TIMING);
  });

  it('sends the configured timing, the lease being min(SESSION_LEASE_CAP_S, STATION_LEASE_S)', async () => {
    const config = { STATION_HEARTBEAT_INTERVAL_S: 5, SESSION_LEASE_CAP_S: 30, STATION_LEASE_S: 60, STATION_LEASE_GRACE_S: 3 } as Record<string, unknown>;
    const custom = new StationPolicyService(repo as any, { get: (key: string) => config[key] } as any);
    await expect(custom.effectiveFor('m1')).resolves.toEqual({
      heartbeatIntervalSeconds: 5,
      defaultLeaseDurationSeconds: 30,
      leaseGracePeriodSeconds: 3,
    });
  });

  it('knows no policy for an unknown machine', async () => {
    repo.findForMachine.mockResolvedValueOnce(null);
    await expect(service.effectiveFor('gone')).resolves.toBeNull();
  });

  it("reads a branch's default: {} when none, null for an unknown branch", async () => {
    await expect(service.getBranchPolicy('b1')).resolves.toEqual({});
    repo.findBranchPolicy.mockResolvedValueOnce({ gpuTempAlertThreshold: 88 });
    await expect(service.getBranchPolicy('b1')).resolves.toEqual({ gpuTempAlertThreshold: 88 });
    repo.findBranchPolicy.mockResolvedValueOnce(undefined);
    await expect(service.getBranchPolicy('nope')).resolves.toBeNull();
  });

  it('replaces a branch default ({} clears it) and announces the change', async () => {
    await expect(service.setBranchPolicy('b1', { gpuTempAlertThreshold: 88 })).resolves.toEqual({ gpuTempAlertThreshold: 88 });
    expect(repo.setBranchPolicy).toHaveBeenLastCalledWith('b1', { gpuTempAlertThreshold: 88 });
    await service.setBranchPolicy('b1', {});
    expect(repo.setBranchPolicy).toHaveBeenLastCalledWith('b1', null);
    expect(changes).toEqual([{ branchId: 'b1' }, { branchId: 'b1' }]);
  });
});
