import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StationAttentionService, type StationAttentionChange } from './station-attention.service.js';

const SINCE = new Date('2026-10-13T10:00:00Z');
const machine = (overrides: Record<string, unknown> = {}) => ({
  id: 'm1', branchId: 'b1', serialNumber: 'SN-1', needsAttention: true, attentionReason: 'disconnects', attentionSince: SINCE, ...overrides,
});

describe('StationAttentionService', () => {
  let machines: Record<string, ReturnType<typeof vi.fn>>;
  let service: StationAttentionService;
  let changes: StationAttentionChange[];

  beforeEach(() => {
    machines = {
      flagAttention: vi.fn(async (_id: string, reason: string) => machine({ attentionReason: reason })),
      clearAttention: vi.fn(async () => ({ machine: machine({ needsAttention: false, attentionReason: null, attentionSince: null }), reason: 'disconnects' })),
    };
    service = new StationAttentionService(machines as any, { get: () => undefined } as any);
    changes = [];
    service.changes.subscribe((c) => changes.push(c));
  });

  const minutes = (m: number) => new Date(SINCE.getTime() + m * 60_000);

  it('flags a station after 3 drops within 10 minutes, and says so', async () => {
    await service.recordDisconnect('m1', minutes(0));
    await service.recordDisconnect('m1', minutes(4));
    expect(machines.flagAttention).not.toHaveBeenCalled();
    await service.recordDisconnect('m1', minutes(9));
    expect(machines.flagAttention).toHaveBeenCalledWith('m1', 'disconnects', expect.any(Date));
    expect(changes).toEqual([
      { machineId: 'm1', branchId: 'b1', serialNumber: 'SN-1', needsAttention: true, reason: 'disconnects', since: SINCE.toISOString() },
    ]);
  });

  it('forgets drops older than the window, and counts each station on its own', async () => {
    await service.recordDisconnect('m1', minutes(0));
    await service.recordDisconnect('m2', minutes(1));
    await service.recordDisconnect('m1', minutes(5));
    await service.recordDisconnect('m1', minutes(11)); // the first one is out of the window
    expect(machines.flagAttention).not.toHaveBeenCalled();
  });

  it('takes its thresholds from the environment', async () => {
    const config = { ATTENTION_DISCONNECTS: 2, ATTENTION_WINDOW_MIN: 1, ATTENTION_FAILED_COMMANDS: 5 } as Record<string, unknown>;
    const custom = new StationAttentionService(machines as any, { get: (k: string) => config[k] } as any);
    expect(custom.failedCommandsThreshold).toBe(5);
    await custom.recordDisconnect('m1', minutes(0));
    await custom.recordDisconnect('m1', minutes(2)); // past the 1-minute window
    expect(machines.flagAttention).not.toHaveBeenCalled();
    await custom.recordDisconnect('m1', minutes(2.5));
    expect(machines.flagAttention).toHaveBeenCalledTimes(1);
  });

  it('says nothing when the station was already flagged', async () => {
    machines.flagAttention.mockResolvedValueOnce(null);
    await expect(service.flag('m1', 'commands_failed')).resolves.toBe(false);
    expect(changes).toEqual([]);
  });

  it('clears the flag and the drop history, telling why it had been set', async () => {
    await service.recordDisconnect('m1', minutes(0));
    await service.recordDisconnect('m1', minutes(1));
    await expect(service.clear('m1')).resolves.toBe(true);
    expect(changes).toEqual([{ machineId: 'm1', branchId: 'b1', serialNumber: 'SN-1', needsAttention: false, reason: 'disconnects', since: null }]);
    await service.recordDisconnect('m1', minutes(2)); // a fresh count: one drop
    expect(machines.flagAttention).not.toHaveBeenCalled();

    machines.clearAttention.mockResolvedValueOnce(null);
    await expect(service.clear('m1')).resolves.toBe(false);
  });

  it('never throws from a drop report', async () => {
    machines.flagAttention.mockRejectedValue(new Error('db down'));
    for (const m of [0, 1, 2]) await expect(service.recordDisconnect('m1', minutes(m))).resolves.toBeUndefined();
  });
});
