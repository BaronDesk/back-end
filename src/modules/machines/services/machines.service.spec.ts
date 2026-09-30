import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { MachinesService } from './machines.service.js';

function caller(overrides: Partial<AccessTokenPayload> = {}): AccessTokenPayload {
  return { sub: 'u1', role: 'MANAGER', scope: 'admin', branchId: 'branch-a', jti: 'j1', ...overrides };
}

function machine(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    serialNumber: 'SN-1',
    branchId: 'branch-a',
    agentPublicKey: 'pk',
    enrollmentStatus: 'PENDING',
    name: null,
    status: 'OFFLINE',
    lastSeen: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

describe('MachinesService', () => {
  let repo: {
    findById: ReturnType<typeof vi.fn>;
    list: ReturnType<typeof vi.fn>;
    updateStatus: ReturnType<typeof vi.fn>;
  };
  let agents: { disconnectStation: ReturnType<typeof vi.fn> };
  let sessions: { retireMachine: ReturnType<typeof vi.fn> };
  let service: MachinesService;

  beforeEach(() => {
    repo = { findById: vi.fn(), list: vi.fn(), updateStatus: vi.fn() };
    agents = { disconnectStation: vi.fn() };
    sessions = { retireMachine: vi.fn(async () => undefined) };
    service = new MachinesService(repo as any, agents as any, sessions as any);
  });

  describe('list', () => {
    it("scopes to the caller's own branch for staff/admin, ignoring no filter given", async () => {
      repo.list.mockResolvedValue([machine()]);
      await service.list(caller(), {});
      expect(repo.list).toHaveBeenCalledWith({ branchId: 'branch-a', enrollmentStatus: undefined });
    });

    it('lets hq filter by any branch, or see everything with none given', async () => {
      repo.list.mockResolvedValue([]);
      await service.list(caller({ scope: 'hq', role: 'ADMIN', branchId: null }), { branchId: 'branch-z' });
      expect(repo.list).toHaveBeenCalledWith({ branchId: 'branch-z', enrollmentStatus: undefined });

      await service.list(caller({ scope: 'hq', role: 'ADMIN', branchId: null }), {});
      expect(repo.list).toHaveBeenLastCalledWith({ branchId: undefined, enrollmentStatus: undefined });
    });

    it('blocks staff/admin from explicitly requesting another branch', async () => {
      await expect(service.list(caller(), { branchId: 'branch-b' })).rejects.toThrow(ForbiddenException);
      expect(repo.list).not.toHaveBeenCalled();
    });

    it('passes the status filter through', async () => {
      repo.list.mockResolvedValue([]);
      await service.list(caller(), { status: 'ENROLLED' });
      expect(repo.list).toHaveBeenCalledWith({ branchId: 'branch-a', enrollmentStatus: 'ENROLLED' });
    });
  });

  describe('get', () => {
    it('404s for a missing machine', async () => {
      repo.findById.mockResolvedValue(null);
      await expect(service.get(caller(), 'missing')).rejects.toThrow(NotFoundException);
    });

    it('blocks reading a machine in another branch', async () => {
      repo.findById.mockResolvedValue(machine({ branchId: 'branch-b' }));
      await expect(service.get(caller(), 'm1')).rejects.toThrow(ForbiddenException);
    });

    it('returns a machine in the caller\u2019s own branch', async () => {
      repo.findById.mockResolvedValue(machine());
      const result = await service.get(caller(), 'm1');
      expect(result).toMatchObject({ id: 'm1', enrollmentStatus: 'PENDING' });
    });
  });

  describe('approve / reject / revoke', () => {
    it('approves a PENDING machine in the caller\u2019s branch', async () => {
      repo.findById.mockResolvedValue(machine({ enrollmentStatus: 'PENDING' }));
      repo.updateStatus.mockResolvedValue(machine({ enrollmentStatus: 'ENROLLED' }));

      const result = await service.approve(caller(), 'm1');
      expect(repo.updateStatus).toHaveBeenCalledWith('m1', 'ENROLLED');
      expect(result.enrollmentStatus).toBe('ENROLLED');
    });

    it('refuses to approve a machine that is not PENDING', async () => {
      repo.findById.mockResolvedValue(machine({ enrollmentStatus: 'ENROLLED' }));
      await expect(service.approve(caller(), 'm1')).rejects.toThrow(ConflictException);
      expect(repo.updateStatus).not.toHaveBeenCalled();
    });

    it('blocks approving a machine in another branch', async () => {
      repo.findById.mockResolvedValue(machine({ branchId: 'branch-b', enrollmentStatus: 'PENDING' }));
      await expect(service.approve(caller(), 'm1')).rejects.toThrow(ForbiddenException);
    });

    it('rejects a PENDING machine (-> DEACTIVATED)', async () => {
      repo.findById.mockResolvedValue(machine({ enrollmentStatus: 'PENDING' }));
      repo.updateStatus.mockResolvedValue(machine({ enrollmentStatus: 'DEACTIVATED' }));

      const result = await service.reject(caller(), 'm1');
      expect(repo.updateStatus).toHaveBeenCalledWith('m1', 'DEACTIVATED');
      expect(result.enrollmentStatus).toBe('DEACTIVATED');
      expect(agents.disconnectStation).toHaveBeenCalledWith('SN-1', 'station rejected');
    });

    it('refuses to reject a machine that is not PENDING', async () => {
      repo.findById.mockResolvedValue(machine({ enrollmentStatus: 'ENROLLED' }));
      await expect(service.reject(caller(), 'm1')).rejects.toThrow(ConflictException);
    });

    it('revokes an ENROLLED machine regardless of status', async () => {
      repo.findById.mockResolvedValue(machine({ enrollmentStatus: 'ENROLLED' }));
      repo.updateStatus.mockResolvedValue(machine({ enrollmentStatus: 'DEACTIVATED' }));

      const result = await service.revoke(caller(), 'm1');
      expect(repo.updateStatus).toHaveBeenCalledWith('m1', 'DEACTIVATED');
      expect(result.enrollmentStatus).toBe('DEACTIVATED');
      // Out of service at once: disconnected, its session settled, its bookings ahead cancelled.
      expect(agents.disconnectStation).toHaveBeenCalledWith('SN-1', 'station revoked');
      expect(sessions.retireMachine).toHaveBeenCalledWith('m1');
    });

    it('blocks revoking a machine in another branch', async () => {
      repo.findById.mockResolvedValue(machine({ branchId: 'branch-b' }));
      await expect(service.revoke(caller(), 'm1')).rejects.toThrow(ForbiddenException);
    });
  });
});
