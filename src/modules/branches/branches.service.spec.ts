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
    const service = new BranchesService(repo as any, presence as any, { record: vi.fn() } as any);

    const [busy, free] = await service.stations('b1', NOW);
    expect(busy).toMatchObject({ id: 'm1', name: 'PC-01', online: true, busyNow: true, busyUntil: at(90).toISOString() });
    expect(busy.bookings).toHaveLength(3);
    expect(free).toMatchObject({ id: 'm2', name: 'MNR-02', online: false, busyNow: false, busyUntil: null, bookings: [] });
  });

  it('404s an unknown branch', async () => {
    const service = new BranchesService({ findById: vi.fn(async () => null) } as any, {} as any, { record: vi.fn() } as any);
    await expect(service.stations('nope')).rejects.toMatchObject({ response: { code: 'BRANCH_NOT_FOUND' } });
  });
});
