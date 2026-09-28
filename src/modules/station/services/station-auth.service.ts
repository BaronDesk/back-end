import { ForbiddenException, Injectable, Logger, UnauthorizedException } from '@nestjs/common';

import { MachinesRepository } from '../repository/machines.repository.js';
import {
  assertStationAdmitted,
  StationIdentityMismatchError,
  StationNotEnrolledError,
  UnknownStationError,
  type StationRef,
} from './presence.service.js';
import { InvalidStationTokenError, StationTokenService, type StationPrincipal } from './station-token.service.js';

/**
 * Identifies the station behind an agent connection or a station-facing REST
 * call. The only identity is a verified station JWT (`Authorization: Bearer`)
 * whose MACHINE row exists, is ENROLLED and still matches the token's serial
 * and branch. There is no serial-trust fallback, in any environment.
 */
@Injectable()
export class StationAuthService {
  private readonly logger = new Logger(StationAuthService.name);

  constructor(
    private readonly machines: MachinesRepository,
    private readonly stationTokens: StationTokenService,
  ) {}

  /**
   * Verifies the token and admits its machine. Throws InvalidStationTokenError
   * (bad / missing token), UnknownStationError, StationNotEnrolledError or
   * StationIdentityMismatchError.
   */
  async authenticateAgent(authorization: string | string[] | undefined): Promise<StationPrincipal> {
    const principal = await this.stationTokens.verify(bearerToken(authorization));
    await this.admit(principal);
    return principal;
  }

  /** Station-facing REST: 401 for a missing / invalid token, 403 for a valid token whose station is not enrolled. */
  async authenticate(authorization: string | string[] | undefined): Promise<StationRef> {
    const token = bearerToken(authorization);

    let principal: StationPrincipal;
    try {
      principal = await this.stationTokens.verify(token);
    } catch (err) {
      if (!(err instanceof InvalidStationTokenError)) throw err;
      throw new UnauthorizedException({
        code: token ? 'INVALID_STATION_TOKEN' : 'MISSING_STATION_TOKEN',
        error: token ? 'invalid or expired station token' : 'missing station bearer token',
      });
    }

    try {
      return await this.admit(principal);
    } catch (err) {
      if (err instanceof UnknownStationError || err instanceof StationNotEnrolledError) {
        this.logger.warn(`station REST call rejected: ${err.message}`);
        throw new ForbiddenException({ code: 'STATION_NOT_ENROLLED', error: 'station is not enrolled' });
      }
      if (err instanceof StationIdentityMismatchError) {
        this.logger.warn(`station REST call rejected: ${err.message}`);
        throw new UnauthorizedException({ code: 'STATION_TOKEN_MISMATCH', error: 'station token does not match the station' });
      }
      throw err;
    }
  }

  /** Reads the MACHINE row fresh (enrollment can change at any time) and applies the admission rules. */
  private async admit(principal: StationPrincipal): Promise<StationRef> {
    const machine = await this.machines.findById(principal.machineId);
    assertStationAdmitted(machine, principal);
    return { machineId: machine.id, branchId: machine.branchId, serialNumber: machine.serialNumber };
  }
}

export function bearerToken(header: string | string[] | undefined): string | null {
  const value = Array.isArray(header) ? header[0] : header;
  const match = value?.trim().match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}
