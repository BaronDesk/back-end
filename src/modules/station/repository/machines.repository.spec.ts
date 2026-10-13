import { describe, expect, it, vi } from 'vitest';

import { MachinesRepository } from './machines.repository.js';

const SINCE = new Date('2026-10-13T10:00:00Z');

describe('MachinesRepository attention flag', () => {
  it('sets the flag only on a station not flagged yet, keeping the first reason', async () => {
    const prisma = { machine: { updateMany: vi.fn(async () => ({ count: 1 })), findUnique: vi.fn(async () => ({ id: 'm1' })) } };
    const repo = new MachinesRepository(prisma as any);
    await expect(repo.flagAttention('m1', 'disconnects', SINCE)).resolves.toEqual({ id: 'm1' });
    expect(prisma.machine.updateMany).toHaveBeenCalledWith({
      where: { id: 'm1', needsAttention: false },
      data: { needsAttention: true, attentionReason: 'disconnects', attentionSince: SINCE },
    });

    prisma.machine.updateMany.mockResolvedValueOnce({ count: 0 });
    await expect(repo.flagAttention('m1', 'commands_failed', SINCE)).resolves.toBeNull();
  });

  it('clears a set flag and returns the reason it had; null when it was not set', async () => {
    const prisma = {
      machine: {
        findFirst: vi.fn(async () => ({ attentionReason: 'commands_failed' })),
        updateMany: vi.fn(async () => ({ count: 1 })),
        findUnique: vi.fn(async () => ({ id: 'm1', needsAttention: false })),
      },
    };
    const repo = new MachinesRepository(prisma as any);
    await expect(repo.clearAttention('m1')).resolves.toEqual({ machine: { id: 'm1', needsAttention: false }, reason: 'commands_failed' });
    expect(prisma.machine.updateMany).toHaveBeenCalledWith({
      where: { id: 'm1', needsAttention: true },
      data: { needsAttention: false, attentionReason: null, attentionSince: null },
    });

    prisma.machine.findFirst.mockResolvedValueOnce(null);
    await expect(repo.clearAttention('m1')).resolves.toBeNull();
  });
});
