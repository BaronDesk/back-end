import { ConflictException, NotFoundException } from '@nestjs/common';
import { generateKeyPairSync, sign } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { EnrollmentService } from './enrollment.service.js';

function caller(
  overrides: Partial<AccessTokenPayload> = {},
): AccessTokenPayload {
  return {
    sub: 'admin-1',
    role: 'MANAGER',
    scope: 'admin',
    branchId: 'branch-a',
    jti: 'jti-1',
    ...overrides,
  };
}

function machine(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    serialNumber: 'SN-1',
    branchId: 'branch-a',
    agentPublicKey: 'pk',
    enrollmentStatus: 'ENROLLED',
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
    bindMachine: ReturnType<typeof vi.fn>;
  };
  let machinesRepo: {
    findById: ReturnType<typeof vi.fn>;
    findBySerialNumber: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    rotateCredential: ReturnType<typeof vi.fn>;
    reEnroll: ReturnType<typeof vi.fn>;
  };
  let service: EnrollmentService;
  let stationTokens: { signStationToken: ReturnType<typeof vi.fn> };
  const keyPair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const derKey = keyPair.publicKey
    .export({ type: 'spki', format: 'der' })
    .toString('base64');
  const oneTimeToken = 'one-time-enrollment-token-123456';
  function enrollmentDto(
    overrides: Record<string, unknown> = {},
    kp: ReturnType<typeof generateKeyPairSync> = keyPair,
  ) {
    const fields = {
      oneTimeToken,
      serialNumber: 'SN-1',
      machineName: 'Station 1',
      agentVersion: '1.0.0',
      agentPublicKey: kp.publicKey
        .export({ type: 'spki', format: 'der' })
        .toString('base64'),
      mac: '00:11:22:33:44:55',
      ip: '192.0.2.1',
      signedAt: Date.now(),
      ...overrides,
    };
    const canonical = `BARONDESK-ENROLL-V1\n${fields.oneTimeToken}\n${fields.serialNumber}\n${fields.mac}\n${fields.ip}\n${fields.agentPublicKey}\n${fields.signedAt}`;
    return {
      ...fields,
      signature: sign(
        'sha256',
        Buffer.from(canonical),
        kp.privateKey,
      ).toString('base64'),
    };
  }

  beforeEach(() => {
    tokensRepo = {
      create: vi.fn().mockResolvedValue({}),
      findByHash: vi.fn(),
      consume: vi.fn().mockResolvedValue(true),
      bindMachine: vi.fn().mockResolvedValue({}),
    };
    machinesRepo = {
      findById: vi.fn(),
      findBySerialNumber: vi.fn(),
      create: vi.fn(),
      rotateCredential: vi.fn(),
      reEnroll: vi.fn(),
    };
    stationTokens = {
      signStationToken: vi.fn().mockReturnValue('signed-station-jwt'),
    };
    service = new EnrollmentService(
      tokensRepo as any,
      machinesRepo as any,
      stationTokens as any,
    );
  });

  describe('issueToken', () => {
    it('lets a MANAGER issue a token for their own branch', async () => {
      const result = await service.issueToken(caller(), {
        branchId: 'branch-a',
      });

      expect(tokensRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          branchId: 'branch-a',
          machineId: null,
          issuedById: 'admin-1',
        }),
      );
      expect(result.token).toBeTypeOf('string');
      expect(result.token.length).toBeGreaterThan(20);
    });

    it('blocks a MANAGER from issuing a token for another branch', async () => {
      await expect(
        service.issueToken(caller(), { branchId: 'branch-b' }),
      ).rejects.toThrow();
      expect(tokensRepo.create).not.toHaveBeenCalled();
    });

    it('lets an hq ADMIN issue a token for any branch', async () => {
      await service.issueToken(
        caller({ scope: 'hq', role: 'ADMIN', branchId: null }),
        { branchId: 'branch-z' },
      );
      expect(tokensRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ branchId: 'branch-z' }),
      );
    });

    it('caps a caller-supplied ttlMinutes at 24h', async () => {
      await service.issueToken(caller(), {
        branchId: 'branch-a',
        ttlMinutes: 999_999,
      });
      const { expiresAt } = tokensRepo.create.mock.calls[0][0];
      expect(expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(
        24 * 60 * 60_000 + 1000,
      );
    });
  });

  function tokenRecord(overrides: Record<string, unknown> = {}) {
    return {
      id: 't1',
      branchId: 'branch-a',
      machineId: null,
      consumedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date(Date.now() - 60_000),
      ...overrides,
    };
  }

  describe('redeem — signature', () => {
    it('accepts a Base64 DER SPKI key with a DER ECDSA signature', async () => {
      tokensRepo.findByHash.mockResolvedValue(null);
      await expect(service.redeem(enrollmentDto())).resolves.toEqual({
        status: 'REJECTED',
        reason: 'INVALID_ENROLLMENT_TOKEN',
      });
      expect(tokensRepo.findByHash).toHaveBeenCalled();
    });

    it('rejects a request whose signature does not match its fields', async () => {
      const dto = enrollmentDto();
      await expect(
        service.redeem({ ...dto, mac: '00:00:00:00:00:00' }),
      ).resolves.toEqual({ status: 'REJECTED', reason: 'INVALID_SIGNATURE' });
      expect(tokensRepo.findByHash).not.toHaveBeenCalled();
    });

    it('rejects a PEM key (the contract is Base64 DER)', async () => {
      const pem = keyPair.publicKey
        .export({ type: 'spki', format: 'pem' })
        .toString();
      await expect(
        service.redeem(enrollmentDto({ agentPublicKey: pem })),
      ).resolves.toEqual({ status: 'REJECTED', reason: 'INVALID_SIGNATURE' });
    });

    it('rejects a key that is not P-256', async () => {
      const other = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
      await expect(
        service.redeem(enrollmentDto({}, other)),
      ).resolves.toEqual({ status: 'REJECTED', reason: 'INVALID_SIGNATURE' });
    });
  });

  describe('redeem — fresh station', () => {
    it('rejects a token that does not exist', async () => {
      tokensRepo.findByHash.mockResolvedValue(null);
      await expect(service.redeem(enrollmentDto())).resolves.toEqual({
        status: 'REJECTED',
        reason: 'INVALID_ENROLLMENT_TOKEN',
      });
    });

    it('rejects an already-consumed token', async () => {
      tokensRepo.findByHash.mockResolvedValue(
        tokenRecord({ consumedAt: new Date() }),
      );
      await expect(service.redeem(enrollmentDto())).resolves.toEqual({
        status: 'REJECTED',
        reason: 'INVALID_ENROLLMENT_TOKEN',
      });
    });

    it('rejects an expired token', async () => {
      tokensRepo.findByHash.mockResolvedValue(
        tokenRecord({ expiresAt: new Date(Date.now() - 1000) }),
      );
      await expect(service.redeem(enrollmentDto())).resolves.toEqual({
        status: 'REJECTED',
        reason: 'INVALID_ENROLLMENT_TOKEN',
      });
    });

    it('creates a PENDING machine, pins its key and does not burn the token', async () => {
      tokensRepo.findByHash.mockResolvedValue(tokenRecord());
      machinesRepo.findBySerialNumber.mockResolvedValue(null);
      machinesRepo.create.mockResolvedValue(
        machine({ enrollmentStatus: 'PENDING', agentPublicKey: derKey }),
      );

      const result = await service.redeem(enrollmentDto());

      expect(machinesRepo.create).toHaveBeenCalledWith({
        serialNumber: 'SN-1',
        branchId: 'branch-a',
        agentPublicKey: derKey,
        name: 'Station 1',
      });
      expect(tokensRepo.bindMachine).toHaveBeenCalledWith('t1', 'm1');
      expect(tokensRepo.consume).not.toHaveBeenCalled();
      expect(stationTokens.signStationToken).not.toHaveBeenCalled();
      expect(result).toEqual({ status: 'PENDING', machineId: 'm1' });
    });

    it('keeps answering PENDING to re-polls until the machine is approved', async () => {
      tokensRepo.findByHash.mockResolvedValue(tokenRecord({ machineId: 'm1' }));
      machinesRepo.findById.mockResolvedValue(
        machine({ enrollmentStatus: 'PENDING', agentPublicKey: derKey }),
      );

      const now = Date.now();
      await expect(
        service.redeem(enrollmentDto({ signedAt: now })),
      ).resolves.toEqual({ status: 'PENDING', machineId: 'm1' });
      await expect(
        service.redeem(enrollmentDto({ signedAt: now + 5000 })),
      ).resolves.toEqual({ status: 'PENDING', machineId: 'm1' });
      expect(tokensRepo.consume).not.toHaveBeenCalled();
      expect(machinesRepo.create).not.toHaveBeenCalled();
    });

    it('returns ENROLLED with a station JWT and burns the token once approved', async () => {
      tokensRepo.findByHash.mockResolvedValue(tokenRecord({ machineId: 'm1' }));
      machinesRepo.findById.mockResolvedValue(
        machine({ enrollmentStatus: 'ENROLLED', agentPublicKey: derKey }),
      );

      const result = await service.redeem(enrollmentDto());

      expect(tokensRepo.consume).toHaveBeenCalledWith('t1');
      expect(stationTokens.signStationToken).toHaveBeenCalledWith({
        sub: 'm1',
        type: 'station',
        serialNumber: 'SN-1',
        branchId: 'branch-a',
      });
      expect(result).toEqual({
        status: 'ENROLLED',
        stationToken: 'signed-station-jwt',
        machineId: 'm1',
      });
    });

    it('rejects once an admin rejected the machine', async () => {
      tokensRepo.findByHash.mockResolvedValue(tokenRecord({ machineId: 'm1' }));
      machinesRepo.findById.mockResolvedValue(
        machine({ enrollmentStatus: 'DEACTIVATED', agentPublicKey: derKey }),
      );

      await expect(service.redeem(enrollmentDto())).resolves.toEqual({
        status: 'REJECTED',
        reason: 'ENROLLMENT_REJECTED',
      });
      expect(stationTokens.signStationToken).not.toHaveBeenCalled();
    });

    it('lets a rejected or revoked PC enroll again with a fresh token: back to PENDING for approval', async () => {
      tokensRepo.findByHash.mockResolvedValue(tokenRecord({ machineId: null }));
      machinesRepo.findBySerialNumber.mockResolvedValue(machine({ enrollmentStatus: 'DEACTIVATED', agentPublicKey: 'old-key' }));
      machinesRepo.reEnroll.mockResolvedValue(machine({ enrollmentStatus: 'PENDING', agentPublicKey: derKey }));

      await expect(service.redeem(enrollmentDto())).resolves.toEqual({ status: 'PENDING', machineId: 'm1' });
      expect(machinesRepo.reEnroll).toHaveBeenCalledWith('m1', expect.objectContaining({ agentPublicKey: derKey, branchId: 'branch-a' }));
      expect(tokensRepo.bindMachine).toHaveBeenCalled();
      expect(stationTokens.signStationToken).not.toHaveBeenCalled();
    });

    it('rejects a poll signed with a different key than the one pinned', async () => {
      tokensRepo.findByHash.mockResolvedValue(tokenRecord({ machineId: 'm1' }));
      machinesRepo.findById.mockResolvedValue(
        machine({ enrollmentStatus: 'ENROLLED', agentPublicKey: 'other-key' }),
      );

      await expect(service.redeem(enrollmentDto())).resolves.toEqual({
        status: 'REJECTED',
        reason: 'PUBLIC_KEY_MISMATCH',
      });
      expect(tokensRepo.consume).not.toHaveBeenCalled();
      expect(stationTokens.signStationToken).not.toHaveBeenCalled();
    });

    it('rejects a poll whose signedAt does not increase', async () => {
      tokensRepo.findByHash.mockResolvedValue(tokenRecord({ machineId: 'm1' }));
      machinesRepo.findById.mockResolvedValue(
        machine({ enrollmentStatus: 'PENDING', agentPublicKey: derKey }),
      );
      const dto = enrollmentDto();

      await expect(service.redeem(dto)).resolves.toMatchObject({
        status: 'PENDING',
      });
      await expect(service.redeem(dto)).resolves.toEqual({
        status: 'REJECTED',
        reason: 'STALE_SIGNED_AT',
      });
    });

    it('rejects a serial number already registered to another key', async () => {
      tokensRepo.findByHash.mockResolvedValue(tokenRecord());
      machinesRepo.findBySerialNumber.mockResolvedValue(machine());

      await expect(service.redeem(enrollmentDto())).resolves.toEqual({
        status: 'REJECTED',
        reason: 'SERIAL_NUMBER_TAKEN',
      });
      expect(machinesRepo.create).not.toHaveBeenCalled();
    });

    it('treats a lost create race by the same agent as a poll', async () => {
      tokensRepo.findByHash.mockResolvedValue(tokenRecord());
      machinesRepo.findBySerialNumber
        .mockResolvedValueOnce(null)
        .mockResolvedValue(
          machine({ enrollmentStatus: 'PENDING', agentPublicKey: derKey }),
        );
      machinesRepo.create.mockRejectedValue(
        Object.assign(new Error('unique'), { code: 'P2002' }),
      );

      await expect(service.redeem(enrollmentDto())).resolves.toEqual({
        status: 'PENDING',
        machineId: 'm1',
      });
    });
  });

  describe('redeem — rotation', () => {
    const rotationRecord = () =>
      tokenRecord({ id: 't2', machineId: 'm1', createdAt: new Date() });

    it('replaces the credential on the bound machine', async () => {
      tokensRepo.findByHash.mockResolvedValue(rotationRecord());
      machinesRepo.findById.mockResolvedValue(
        machine({ createdAt: new Date(Date.now() - 86_400_000) }),
      );
      machinesRepo.rotateCredential.mockResolvedValue(
        machine({ agentPublicKey: derKey, enrollmentStatus: 'ENROLLED' }),
      );

      const result = await service.redeem(enrollmentDto());

      expect(machinesRepo.rotateCredential).toHaveBeenCalledWith('m1', derKey);
      expect(tokensRepo.consume).toHaveBeenCalledWith('t2');
      expect(machinesRepo.create).not.toHaveBeenCalled();
      expect(result).toEqual({
        status: 'ENROLLED',
        stationToken: 'signed-station-jwt',
        machineId: 'm1',
      });
    });

    it('rejects a rotation whose bound machine no longer exists', async () => {
      tokensRepo.findByHash.mockResolvedValue(rotationRecord());
      machinesRepo.findById.mockResolvedValue(null);

      await expect(service.redeem(enrollmentDto())).resolves.toEqual({
        status: 'REJECTED',
        reason: 'MACHINE_NOT_FOUND',
      });
      expect(tokensRepo.consume).not.toHaveBeenCalled();
      expect(machinesRepo.rotateCredential).not.toHaveBeenCalled();
    });

    it('rejects a rotation whose serial number does not match the bound machine', async () => {
      tokensRepo.findByHash.mockResolvedValue(rotationRecord());
      machinesRepo.findById.mockResolvedValue(
        machine({ createdAt: new Date(Date.now() - 86_400_000) }),
      );

      await expect(
        service.redeem(enrollmentDto({ serialNumber: 'WRONG-SN' })),
      ).resolves.toEqual({
        status: 'REJECTED',
        reason: 'SERIAL_NUMBER_MISMATCH',
      });
      expect(machinesRepo.rotateCredential).not.toHaveBeenCalled();
    });
  });

  describe('rotateToken', () => {
    it('404s for a machine that does not exist', async () => {
      machinesRepo.findById.mockResolvedValue(null);
      await expect(service.rotateToken(caller(), 'missing')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('refuses to mint a rotation token for a machine that is not ENROLLED', async () => {
      machinesRepo.findById.mockResolvedValue(
        machine({ enrollmentStatus: 'PENDING' }),
      );
      await expect(service.rotateToken(caller(), 'm1')).rejects.toThrow(
        ConflictException,
      );
    });

    it('blocks a MANAGER from rotating another branch\u2019s machine', async () => {
      machinesRepo.findById.mockResolvedValue(
        machine({ branchId: 'branch-b', enrollmentStatus: 'ENROLLED' }),
      );
      await expect(
        service.rotateToken(caller({ branchId: 'branch-a' }), 'm1'),
      ).rejects.toThrow();
    });

    it('mints a token bound to an ENROLLED machine in the caller\u2019s own branch', async () => {
      machinesRepo.findById.mockResolvedValue(
        machine({ enrollmentStatus: 'ENROLLED' }),
      );
      const result = await service.rotateToken(caller(), 'm1');

      expect(tokensRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({ machineId: 'm1', branchId: 'branch-a' }),
      );
      expect(result.token).toBeTypeOf('string');
    });
  });
});
