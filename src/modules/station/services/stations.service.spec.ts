import { beforeEach, describe, expect, it, vi } from 'vitest';

import { StationsService } from './stations.service.js';

const STAFF = { sub: 'u1', role: 'EMPLOYEE', scope: 'staff', branchId: 'b1', jti: 'j' } as any;
const MACHINE = {
  id: 'm1', branchId: 'b1', serialNumber: 'SN-1', name: 'PC-1', status: 'ONLINE', lastSeen: null, ipAddress: null,
  enrollmentStatus: 'ENROLLED', peripherals: null, peripheralsReportedAt: null, policy: null,
  needsAttention: true, attentionReason: 'commands_failed', attentionSince: new Date('2026-10-13T10:00:00Z'),
};

describe('StationsService attention', () => {
  let machines: Record<string, ReturnType<typeof vi.fn>>;
  let attention: { clear: ReturnType<typeof vi.fn> };
  let audit: { record: ReturnType<typeof vi.fn> };
  let service: StationsService;

  beforeEach(() => {
    machines = { findById: vi.fn(async () => MACHINE), list: vi.fn(async () => [MACHINE]) };
    attention = { clear: vi.fn(async () => true) };
    audit = { record: vi.fn(async () => undefined) };
    const redis = { pipeline: () => ({ hgetall: vi.fn(), exec: vi.fn(async () => [[null, {}]]) }) };
    service = new StationsService(machines as any, {} as any, redis as any, attention as any, audit as any);
  });

  it('shows the flag, its reason and since when on every station', async () => {
    const [station] = await service.list(STAFF);
    expect(station).toMatchObject({ needsAttention: true, attentionReason: 'commands_failed', attentionSince: '2026-10-13T10:00:00.000Z' });
  });

  it('lets staff clear it, audit-logged with the reason it had', async () => {
    await service.clearAttention(STAFF, 'm1');
    expect(attention.clear).toHaveBeenCalledWith('m1');
    expect(audit.record).toHaveBeenCalledWith('u1', 'UPDATE', 'machine:m1', {
      branchId: 'b1',
      metadata: { event: 'STATION_ATTENTION_CLEARED', reason: 'commands_failed' },
    });
  });

  it("409s a station that is not flagged, and refuses another branch's", async () => {
    attention.clear.mockResolvedValueOnce(false);
    await expect(service.clearAttention(STAFF, 'm1')).rejects.toMatchObject({ response: { code: 'STATION_NOT_FLAGGED' } });
    await expect(service.clearAttention({ ...STAFF, branchId: 'b2' }, 'm1')).rejects.toMatchObject({ response: { code: 'FORBIDDEN_CROSS_BRANCH' } });
    expect(audit.record).not.toHaveBeenCalled();
  });
});
