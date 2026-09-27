import { ConflictException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';

import { assertScope } from '../../../common/utils/assert-scope.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { EnrollmentTokensRepository } from '../repository/enrollment-tokens.repository.js';
import { MachinesRepository } from '../repository/machines.repository.js';
import type { IssueEnrollmentTokenDto, RedeemEnrollmentTokenDto } from '../schemas/enrollment.schemas.js';
import { generateEnrollmentToken, hashEnrollmentToken } from '../util/crypto.js';
import { toPublicMachine } from '../util/public-machine.js';

const DEFAULT_TOKEN_TTL_MINUTES = 30;
const MAX_TOKEN_TTL_MINUTES = 24 * 60;

const INVALID_TOKEN = () =>
  new UnauthorizedException({ code: 'INVALID_ENROLLMENT_TOKEN', error: 'enrollment token is invalid, used, or expired' });


@Injectable()
export class EnrollmentService {
  constructor(
    private readonly tokens: EnrollmentTokensRepository,
    private readonly machines: MachinesRepository,
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
    const record = await this.tokens.findByHash(hashEnrollmentToken(dto.token));
    if (!record || record.consumedAt || record.expiresAt < new Date()) {
      throw INVALID_TOKEN();
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
    return toPublicMachine(updated);
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
      name: dto.name ?? null,
    });
    return toPublicMachine(machine);
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
