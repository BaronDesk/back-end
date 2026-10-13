import { describe, expect, it, vi } from 'vitest';

import { CommandsRepository } from './commands.repository.js';

describe('CommandsRepository.lastStaffOutcomes', () => {
  it('reads the latest outcomes of staff commands: no system sends, no CATALOG_UPDATE, nothing open or applied on reconnect', async () => {
    const prisma = { command: { findMany: vi.fn(async () => [{ status: 'FAILED' }, { status: 'TIMEOUT' }]) } };
    const repo = new CommandsRepository(prisma as any);
    await expect(repo.lastStaffOutcomes('m1', 'system', 3)).resolves.toEqual(['FAILED', 'TIMEOUT']);
    expect(prisma.command.findMany).toHaveBeenCalledWith({
      where: {
        machineId: 'm1',
        issuedBy: { not: 'system' },
        type: { not: 'CATALOG_UPDATE' },
        status: { in: ['ACKED', 'NACKED', 'FAILED', 'TIMEOUT'] },
      },
      orderBy: [{ resolvedAt: 'desc' }, { issuedAt: 'desc' }],
      take: 3,
      select: { status: true },
    });
  });
});
