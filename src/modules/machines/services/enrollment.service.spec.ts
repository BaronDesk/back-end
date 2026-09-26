import { ConflictException, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { EnrollmentService } from './enrollment.service.js';

function caller(overrides: Partial<AccessTokenPayload> = {}): AccessTokenPayload {
  return { sub: 'admin-1', role: 'MANAGER', scope: 'admin', branchId: 'branch-a', jti: 'jti-1', ...overrides };
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

describe('EnrollmentService', () => {
  let tokensRepo: {
    create: ReturnType<typeof vi.fn>;
    findByHash: ReturnType<typeof vi.fn>;
    consume: ReturnType<typeof vi.fn>;
  };
  let machinesRepo: {
    findById: ReturnType<typeof vi.fn>;
    findBySerialNumber: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    rotateCredential: ReturnType<typeof vi.fn>;
  };
  let service: EnrollmentService;

  beforeEach(() => {
    tokensRepo = {
      create: vi.fn().mockResolvedValue({}),
      findByHash: vi.fn(),
      consume: vi.fn().mockResolvedValue({}),
    };
    machinesRepo = {
      findById: vi.fn(),
      findBySerialNumber: vi.fn(),
      create: vi.fn(),
      rotateCredential: vi.fn(),
    };
    service = new EnrollmentService(tokensRepo as any, machinesRepo as any);
  });

  describe('issueToken', () => {
    it('lets a MANAGER issue a token for their own branch', async () => {
      const result = await service.issueToken(caller(), { branchId: 'branch-a' });

      expect(tokensRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ branchId: 'branch-a', machineId: null, issuedById: 'admin-1' }),
      );
      expect(result.token).toBeTypeOf('string');
      expect(result.token.length).toBeGreaterThan(20);
    });

    it('blocks a MANAGER from issuing a token for another branch', async () => {
      await expect(service.issueToken(caller(), { branchId: 'branch-b' })).rejects.toThrow();
      expect(tokensRepo.create).not.toHaveBeenCalled();
    });

    it('lets an hq ADMIN issue a token for any branch', async () => {
      await service.issueToken(caller({ scope: 'hq', role: 'ADMIN', branchId: null }), { branchId: 'branch-z' });
      expect(tokensRepo.create).toHaveBeenCalledWith(expect.objectContaining({ branchId: 'branch-z' }));
    });

    it('caps a caller-supplied ttlMinutes at 24h', async () => {
      await service.issueToken(caller(), { branchId: 'branch-a', ttlMinutes: 999_999 });
      const { expiresAt } = tokensRepo.create.mock.calls[0][0];
      expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(24 * 60 * 60_000 + 1000);
    });
  });

  describe('redeem — fresh station', () => {
    it('rejects a token that does not exist', async () => {
      tokensRepo.findByHash.mockResolvedValue(null);
      await expect(
        service.redeem({ token: 'x'.repeat(30), serialNumber: 'SN-1', agentPublicKey: 'pk' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects an already-consumed token', async () => {
      tokensRepo.findByHash.mockResolvedValue({
        id: 't1',
        branchId: 'branch-a',
        machineId: null,
        consumedAt: new Date(),
        expiresAt: new Date(Date.now() + 60_000),
      });
      await expect(
        service.redeem({ token: 'x'.repeat(30), serialNumber: 'SN-1', agentPublicKey: 'pk' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('rejects an expired token', async () => {
      tokensRepo.findByHash.mockResolvedValue({
        id: 't1',
        branchId: 'branch-a',
        machineId: null,
        consumedAt: null,
        expiresAt: new Date(Date.now() - 1000),
      });
      await expect(
        service.redeem({ token: 'x'.repeat(30), serialNumber: 'SN-1', agentPublicKey: 'pk' }),
      ).rejects.toThrow(UnauthorizedException);
    });

    it('creates a new PENDING machine and consumes the token', async () => {
      tokensRepo.findByHash.mockResolvedValue({
        id: 't1',
        branchId: 'branch-a',
        machineId: null,
        consumedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
      machinesRepo.findBySerialNumber.mockResolvedValue(null);
      machinesRepo.create.mockResolvedValue(machine());

      const result = await service.redeem({ token: 'x'.repeat(30), serialNumber: 'SN-1', agentPublicKey: 'pk' });

      expect(tokensRepo.consume).toHaveBeenCalledWith('t1');
      expect(machinesRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ serialNumber: 'SN-1', branchId: 'branch-a', agentPublicKey: 'pk' }),
      );
      expect(result).toMatchObject({ id: 'm1', enrollmentStatus: 'PENDING' });
    });

    it('rejects a duplicate serial number', async () => {
      tokensRepo.findByHash.mockResolvedValue({
        id: 't1',
        branchId: 'branch-a',
        machineId: null,
        consumedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
      machinesRepo.findBySerialNumber.mockResolvedValue(machine());

      await expect(
        service.redeem({ token: 'x'.repeat(30), serialNumber: 'SN-1', agentPublicKey: 'pk' }),
      ).rejects.toThrow(ConflictException);
      expect(machinesRepo.create).not.toHaveBeenCalled();
    });
  });

  describe('redeem — rotation', () => {
    it('replaces the credential on the bound machine', async () => {
      tokensRepo.findByHash.mockResolvedValue({
        id: 't2',
        branchId: 'branch-a',
        machineId: 'm1',
        consumedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
      machinesRepo.findById.mockResolvedValue(machine({ serialNumber: 'SN-1' }));
      machinesRepo.rotateCredential.mockResolvedValue(machine({ agentPublicKey: 'new-pk', enrollmentStatus: 'ENROLLED' }));

      const result = await service.redeem({ token: 'x'.repeat(30), serialNumber: 'SN-1', agentPublicKey: 'new-pk' });

      expect(machinesRepo.rotateCredential).toHaveBeenCalledWith('m1', 'new-pk');
      expect(machinesRepo.create).not.toHaveBeenCalled();
      expect(result.agentPublicKey).toBe('new-pk');
    });

    it('rejects a rotation whose serial number does not match the bound machine', async () => {
      tokensRepo.findByHash.mockResolvedValue({
        id: 't2',
        branchId: 'branch-a',
        machineId: 'm1',
        consumedAt: null,
        expiresAt: new Date(Date.now() + 60_000),
      });
      machinesRepo.findById.mockResolvedValue(machine({ serialNumber: 'SN-1' }));

      await expect(
        service.redeem({ token: 'x'.repeat(30), serialNumber: 'WRONG-SN', agentPublicKey: 'new-pk' }),
      ).rejects.toThrow(ConflictException);
      expect(machinesRepo.rotateCredential).not.toHaveBeenCalled();
    });
  });

  describe('rotateToken', () => {
    it('404s for a machine that does not exist', async () => {
      machinesRepo.findById.mockResolvedValue(null);
      await expect(service.rotateToken(caller(), 'missing')).rejects.toThrow(NotFoundException);
    });

    it('refuses to mint a rotation token for a machine that is not ENROLLED', async () => {
      machinesRepo.findById.mockResolvedValue(machine({ enrollmentStatus: 'PENDING' }));
      await expect(service.rotateToken(caller(), 'm1')).rejects.toThrow(ConflictException);
    });

    it('blocks a MANAGER from rotating another branch\u2019s machine', async () => {
      machinesRepo.findById.mockResolvedValue(machine({ branchId: 'branch-b', enrollmentStatus: 'ENROLLED' }));
      await expect(service.rotateToken(caller({ branchId: 'branch-a' }), 'm1')).rejects.toThrow();
    });

    it('mints a token bound to an ENROLLED machine in the caller\u2019s own branch', async () => {
      machinesRepo.findById.mockResolvedValue(machine({ enrollmentStatus: 'ENROLLED' }));
      const result = await service.rotateToken(caller(), 'm1');

      expect(tokensRepo.create).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'm1', branchId: 'branch-a' }));
      expect(result.token).toBeTypeOf('string');
    });
  });
});
