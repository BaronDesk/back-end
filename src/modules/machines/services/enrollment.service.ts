import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { createPublicKey, verify as verifySignature } from 'node:crypto';

import { assertScope } from '../../../common/utils/assert-scope.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { EnrollmentTokensRepository } from '../repository/enrollment-tokens.repository.js';
import { MachinesRepository } from '../repository/machines.repository.js';
import type { IssueEnrollmentTokenDto, RedeemEnrollmentTokenDto } from '../schemas/enrollment.schemas.js';
import { generateEnrollmentToken, hashEnrollmentToken } from '../util/crypto.js';
import { TokenService } from '../../identity/services/token.service.js';

const DEFAULT_TOKEN_TTL_MINUTES = 30;
const MAX_TOKEN_TTL_MINUTES = 24 * 60;

type TokenRecord = { id: string; branchId: string; machineId: string | null; createdAt: Date };
type MachineRow = {
  id: string;
  serialNumber: string;
  branchId: string;
  agentPublicKey: string;
  enrollmentStatus: string;
  credentialVersion: number;
  createdAt: Date;
};

export type EnrollmentResult =
  | { status: 'PENDING'; machineId: string }
  | { status: 'ENROLLED'; stationToken: string; machineId: string }
  | { status: 'REJECTED'; reason: string };

@Injectable()
export class EnrollmentService {
  constructor(
    private readonly tokens: EnrollmentTokensRepository,
    private readonly machines: MachinesRepository,
    private readonly stationTokens: TokenService,
  ) {}

  private readonly lastSignedAt = new Map<string, { signedAt: number; expiresAt: number }>();


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

  /**
   * Agent-facing and polled: every outcome is a 200 with a status. PENDING is
   * answered until an admin approves the machine; REJECTED is terminal on the
   * agent, so it is only returned for refusals that retrying can't fix.
   */
  async redeem(dto: RedeemEnrollmentTokenDto): Promise<EnrollmentResult> {
    if (!isValidEnrollmentSignature(dto)) return rejected('INVALID_SIGNATURE');
    const signedAt = parseSignedAt(dto.signedAt);
    if (signedAt === null) return rejected('INVALID_SIGNED_AT');

    const tokenHash = hashEnrollmentToken(dto.oneTimeToken);
    const record = await this.tokens.findByHash(tokenHash);
    if (!record || record.consumedAt || record.expiresAt < new Date()) {
      this.lastSignedAt.delete(tokenHash);
      return rejected('INVALID_ENROLLMENT_TOKEN');
    }

    if (!this.acceptSignedAt(tokenHash, signedAt, record.expiresAt)) return rejected('STALE_SIGNED_AT');

    const result = record.machineId
      ? await this.redeemBoundToken(record, dto)
      : await this.redeemFreshToken(record, dto);
    if (result.status !== 'PENDING') this.lastSignedAt.delete(tokenHash);
    return result;
  }

  private async redeemBoundToken(record: TokenRecord, dto: RedeemEnrollmentTokenDto): Promise<EnrollmentResult> {
    const machine = await this.machines.findById(record.machineId!);
    if (!machine) return rejected('MACHINE_NOT_FOUND');
    if (machine.serialNumber !== dto.serialNumber) return rejected('SERIAL_NUMBER_MISMATCH');

    // A token minted before its machine existed is an enrollment token that got
    // bound on the first poll; one minted after is a rotate-token credential swap,
    // unless it re-enrolled a deactivated machine (then it waits for approval too).
    if (record.createdAt < machine.createdAt || machine.enrollmentStatus === 'PENDING') {
      return this.pollEnrollment(record, machine, dto);
    }
    return this.redeemRotation(record, machine, dto);
  }

  private async redeemFreshToken(record: TokenRecord, dto: RedeemEnrollmentTokenDto): Promise<EnrollmentResult> {
    const existing = await this.machines.findBySerialNumber(dto.serialNumber);
    if (existing?.enrollmentStatus === 'DEACTIVATED') {
      // A rejected or revoked PC enrolling again with a fresh token: back to
      // PENDING (new key, this token's branch); an admin approves it again.
      const machine = await this.machines.reEnroll(existing.id, {
        agentPublicKey: dto.agentPublicKey,
        name: dto.machineName,
        branchId: record.branchId,
      });
      await this.tokens.bindMachine(record.id, machine.id);
      return { status: 'PENDING', machineId: machine.id };
    }
    if (existing) {
      // Only the holder of the pinned key may keep polling an existing serial
      // (covers a concurrent first poll racing the token bind below).
      if (existing.branchId !== record.branchId || existing.agentPublicKey !== dto.agentPublicKey) {
        return rejected('SERIAL_NUMBER_TAKEN');
      }
      return this.pollEnrollment(record, existing, dto);
    }

    let machine: MachineRow;
    try {
      machine = await this.machines.create({
        serialNumber: dto.serialNumber,
        branchId: record.branchId,
        agentPublicKey: dto.agentPublicKey,
        name: dto.machineName,
      });
    } catch (err) {
      // A concurrent first poll created it; answer as a poll against that row.
      if (!isUniqueViolation(err) || !(await this.machines.findBySerialNumber(dto.serialNumber))) throw err;
      return this.redeemFreshToken(record, dto);
    }
    await this.tokens.bindMachine(record.id, machine.id);
    return { status: 'PENDING', machineId: machine.id };
  }

  private async pollEnrollment(
    record: TokenRecord,
    machine: MachineRow,
    dto: RedeemEnrollmentTokenDto,
  ): Promise<EnrollmentResult> {
    if (machine.agentPublicKey !== dto.agentPublicKey) return rejected('PUBLIC_KEY_MISMATCH');

    switch (machine.enrollmentStatus) {
      case 'PENDING':
        return { status: 'PENDING', machineId: machine.id };
      case 'ENROLLED':
        if (!(await this.tokens.consume(record.id))) return rejected('INVALID_ENROLLMENT_TOKEN');
        return this.enrolledResponse(machine);
      default:
        await this.tokens.consume(record.id);
        return rejected('ENROLLMENT_REJECTED');
    }
  }

  private async redeemRotation(
    record: TokenRecord,
    machine: MachineRow,
    dto: RedeemEnrollmentTokenDto,
  ): Promise<EnrollmentResult> {
    if (machine.enrollmentStatus !== 'ENROLLED') return rejected('STATION_NOT_ENROLLED');
    if (!(await this.tokens.consume(record.id))) return rejected('INVALID_ENROLLMENT_TOKEN');

    const updated = await this.machines.rotateCredential(machine.id, dto.agentPublicKey);
    return this.enrolledResponse(updated);
  }

  private enrolledResponse(machine: Pick<MachineRow, 'id' | 'serialNumber' | 'branchId' | 'credentialVersion'>): EnrollmentResult {
    return {
      status: 'ENROLLED',
      stationToken: this.stationTokens.signStationToken({
        sub: machine.id,
        type: 'station',
        serialNumber: machine.serialNumber,
        branchId: machine.branchId,
        ver: machine.credentialVersion,
      }),
      machineId: machine.id,
    };
  }

  /**
   * Replay guard for polls: each request on a token must be signed later than
   * the previous one. Kept in memory (the schema has no column for it), so a
   * restart resets it; the token's TTL and single use still bound replays.
   */
  private acceptSignedAt(tokenHash: string, signedAt: number, expiresAt: Date): boolean {
    const now = Date.now();
    for (const [hash, entry] of this.lastSignedAt) {
      if (entry.expiresAt < now) this.lastSignedAt.delete(hash);
    }
    const previous = this.lastSignedAt.get(tokenHash);
    if (previous && signedAt <= previous.signedAt) return false;
    this.lastSignedAt.set(tokenHash, { signedAt, expiresAt: expiresAt.getTime() });
    return true;
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

function rejected(reason: string): EnrollmentResult {
  return { status: 'REJECTED', reason };
}

// agentPublicKey is Base64 DER SubjectPublicKeyInfo (ECDSA P-256); signature is Base64 DER ECDSA-SHA256.
function isValidEnrollmentSignature(dto: RedeemEnrollmentTokenDto): boolean {
  const canonical = `BARONDESK-ENROLL-V1\n${dto.oneTimeToken}\n${dto.serialNumber}\n${dto.mac}\n${dto.ip}\n${dto.agentPublicKey}\n${dto.signedAt}`;
  try {
    const key = createPublicKey({ key: Buffer.from(dto.agentPublicKey, 'base64'), format: 'der', type: 'spki' });
    if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') return false;
    return verifySignature(
      'sha256',
      Buffer.from(canonical, 'utf8'),
      { key, dsaEncoding: 'der' },
      Buffer.from(dto.signature, 'base64'),
    );
  } catch {
    return false;
  }
}

function parseSignedAt(signedAt: number | string): number | null {
  if (typeof signedAt === 'number') return signedAt;
  const trimmed = signedAt.trim();
  const value = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed);
  return Number.isFinite(value) ? value : null;
}

function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'P2002';
}
