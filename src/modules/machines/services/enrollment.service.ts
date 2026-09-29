import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { verify as verifySignature } from 'node:crypto';

import { assertScope } from '../../../common/utils/assert-scope.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { EnrollmentTokensRepository } from '../repository/enrollment-tokens.repository.js';
import { MachinesRepository } from '../repository/machines.repository.js';
import type { IssueEnrollmentTokenDto, RedeemEnrollmentTokenDto } from '../schemas/enrollment.schemas.js';
import { generateEnrollmentToken, hashEnrollmentToken } from '../util/crypto.js';
import { TokenService } from '../../identity/services/token.service.js';

const DEFAULT_TOKEN_TTL_MINUTES = 30;
const MAX_TOKEN_TTL_MINUTES = 24 * 60;

@Injectable()
export class EnrollmentService {
  constructor(
    private readonly tokens: EnrollmentTokensRepository,
    private readonly machines: MachinesRepository,
    private readonly stationTokens: TokenService,
  ) {}

  
  async issueToken(caller: AccessTokenPayload, dto: IssueEnrollmentTokenDto) {
    assertScope(caller, { branchId: dto.branchId });
    return this.mintToken({ branchId: dto.branchId, machineId: null, issuedById: caller.sub, ttlMinutes: dto.ttlMinutes });
  }

  
  async rotateToken(caller: AccessTokenPayload, machineId: string) {
    const machine = await this.machines.findById(machineId);
    if (!machine) throw new NotFoundException({ code: 'MACHINE_NOT_FOUND', error: 'machine not found' });
    assertScope(caller, { branchId: machine.branchId });

    if (machine.enrollmentStatus !== 'ENROLLED') {
      throw new ConflictException({
        code: 'MACHINE_NOT_ENROLLED',
        error: 'only an enrolled machine can rotate its credential',
      });
    }

    return this.mintToken({ branchId: machine.branchId, machineId: machine.id, issuedById: caller.sub });
  }

  
  async redeem(dto: RedeemEnrollmentTokenDto) {
    if (!isValidEnrollmentSignature(dto)) return { status: 'REJECTED', reason: 'INVALID_SIGNATURE' } as const;
    const record = await this.tokens.findByHash(hashEnrollmentToken(dto.oneTimeToken));
    if (!record || record.consumedAt || record.expiresAt < new Date()) {
      return { status: 'REJECTED', reason: 'INVALID_ENROLLMENT_TOKEN' } as const;
    }

    await this.tokens.consume(record.id);

    if (record.machineId) {
      return this.redeemRotation(record.machineId, dto);
    }
    return this.redeemFreshStation(record.branchId, dto);
  }

  private async redeemRotation(machineId: string, dto: RedeemEnrollmentTokenDto) {
    const machine = await this.machines.findById(machineId);
    if (!machine) throw new NotFoundException({ code: 'MACHINE_NOT_FOUND', error: 'machine not found' });

    
    if (machine.serialNumber !== dto.serialNumber) {
      throw new ConflictException({
        code: 'SERIAL_NUMBER_MISMATCH',
        error: 'this rotation token was not issued for this station',
      });
    }

    const updated = await this.machines.rotateCredential(machineId, dto.agentPublicKey);
    return this.enrolledResponse(updated);
  }

  private async redeemFreshStation(branchId: string, dto: RedeemEnrollmentTokenDto) {
    const existing = await this.machines.findBySerialNumber(dto.serialNumber);
    if (existing) {
      throw new ConflictException({
        code: 'SERIAL_NUMBER_TAKEN',
        error: 'a machine with this serial number is already registered',
      });
    }

    const machine = await this.machines.create({
      serialNumber: dto.serialNumber,
      branchId,
      agentPublicKey: dto.agentPublicKey,
      name: dto.machineName,
    });
    return this.enrolledResponse(machine);
  }

  private enrolledResponse(machine: { id: string; serialNumber: string; branchId: string; enrollmentStatus: string }) {
    if (machine.enrollmentStatus !== 'ENROLLED') {
      return { status: 'REJECTED', reason: 'STATION_NOT_ENROLLED' } as const;
    }
    return {
      status: 'ENROLLED' as const,
      stationToken: this.stationTokens.signStationToken({
        sub: machine.id,
        type: 'station',
        serialNumber: machine.serialNumber,
        branchId: machine.branchId,
      }),
      machineId: machine.id,
    };
  }

  private async mintToken(opts: {
    branchId: string;
    machineId: string | null;
    issuedById: string;
    ttlMinutes?: number;
  }): Promise<{ token: string; expiresAt: Date }> {
    const ttlMinutes = Math.min(opts.ttlMinutes ?? DEFAULT_TOKEN_TTL_MINUTES, MAX_TOKEN_TTL_MINUTES);
    const token = generateEnrollmentToken();
    const expiresAt = new Date(Date.now() + ttlMinutes * 60_000);

    await this.tokens.create({
      tokenHash: hashEnrollmentToken(token),
      branchId: opts.branchId,
      machineId: opts.machineId,
      issuedById: opts.issuedById,
      expiresAt,
    });

    
    return { token, expiresAt };
  }
}

function isValidEnrollmentSignature(dto: RedeemEnrollmentTokenDto): boolean {
  const canonical = `BARONDESK-ENROLL-V1\n${dto.oneTimeToken}\n${dto.serialNumber}\n${dto.mac}\n${dto.ip}\n${dto.agentPublicKey}\n${dto.signedAt}`;
  try {
    return verifySignature('sha256', Buffer.from(canonical, 'utf8'), dto.agentPublicKey, Buffer.from(dto.signature, 'base64'));
  } catch {
    return false;
  }
}
