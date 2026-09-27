import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PresenceService, type StationRef } from './presence.service.js';
import { InvalidStationTokenError, StationTokenService, type StationPrincipal } from './station-token.service.js';

/** Dev bypass only: lets curl / the monitor name the station directly. */
export const DEV_STATION_SERIAL_HEADER = 'x-station-serial';

export interface StationRequestAuth {
  authorization?: string | string[];
  devSerialHeader?: string | string[];
  devSerialQuery?: unknown;
}

/**
 * Identifies the station behind an agent connection or a station-facing REST
 * call. The identity is the verified station JWT (`Authorization: Bearer`),
 * sent by the agent on both the WSS upgrade and REST.
 *
 * STATION_AUTH_DEV_BYPASS (dev only, default off) restores the pre-credential
 * behaviour for a request whose token does not verify: the WSS handshake
 * serial is trusted, and REST resolves by `x-station-serial`, `?serialNumber=`
 * or the token a handshake bound. Env validation refuses it in production.
 */
@Injectable()
export class StationAuthService {
  private readonly logger = new Logger(StationAuthService.name);
  readonly devBypass: boolean;
  /** token -> serial, from WSS handshakes (dev bypass only). */
  private readonly devTokens = new Map<string, string>();

  constructor(
    private readonly presence: PresenceService,
    private readonly stationTokens: StationTokenService,
    config: ConfigService,
  ) {
    this.devBypass = config.get('NODE_ENV') !== 'production' && config.get('STATION_AUTH_DEV_BYPASS') === true;
    if (this.devBypass) {
      this.logger.warn('STATION_AUTH_DEV_BYPASS is ON: stations without a valid token are identified by serial (dev only)');
    }
  }

  /**
   * WSS upgrade. Returns the token's principal; null only under the dev
   * bypass (the handshake serial then decides). Otherwise throws
   * InvalidStationTokenError.
   */
  async authenticateAgent(authorization: string | string[] | undefined): Promise<StationPrincipal | null> {
    try {
      return await this.stationTokens.verify(bearerToken(authorization));
    } catch (err) {
      if (!this.devBypass || !(err instanceof InvalidStationTokenError)) throw err;
      this.logger.warn(`agent without a valid station token accepted by dev bypass (${err.message})`);
      return null;
    }
  }

  /** Dev bypass: after a serial-identified handshake, that socket's bearer token speaks for the serial on REST. */
  bindDevToken(token: string | null, serialNumber: string): void {
    if (!this.devBypass || !token) return;
    this.devTokens.set(token, serialNumber);
  }

  /** Station-facing REST: 401 unless the bearer token is a valid station token for a known machine. */
  async authenticate(auth: StationRequestAuth): Promise<StationRef> {
    const token = bearerToken(auth.authorization);

    let principal: StationPrincipal;
    try {
      principal = await this.stationTokens.verify(token);
    } catch (err) {
      if (!(err instanceof InvalidStationTokenError)) throw err;
      if (this.devBypass) return this.authenticateDevSerial(auth, token);
      throw new UnauthorizedException({
        code: token ? 'INVALID_STATION_TOKEN' : 'MISSING_STATION_TOKEN',
        error: token ? 'invalid or expired station token' : 'missing station bearer token',
      });
    }

    const station = await this.presence.resolveById(principal.machineId);
    if (!station) {
      this.logger.warn(`station token for unknown machine ${principal.machineId}`);
      throw new UnauthorizedException({ code: 'STATION_UNKNOWN', error: 'unknown station' });
    }
    if (station.serialNumber !== principal.serialNumber || station.branchId !== principal.branchId) {
      this.logger.warn(`station token for ${principal.machineId} does not match its MACHINE row`);
      throw new UnauthorizedException({ code: 'STATION_TOKEN_MISMATCH', error: 'station token does not match the station' });
    }
    return station;
  }

  private async authenticateDevSerial(auth: StationRequestAuth, token: string | null): Promise<StationRef> {
    const serial =
      first(auth.devSerialHeader) ??
      (typeof auth.devSerialQuery === 'string' && auth.devSerialQuery ? auth.devSerialQuery : undefined) ??
      (token ? this.devTokens.get(token) : undefined);
    if (!serial) {
      throw new UnauthorizedException({
        code: 'STATION_UNKNOWN',
        error: `no valid station token (dev bypass: connect the agent over /agent-ws first, or send ${DEV_STATION_SERIAL_HEADER})`,
      });
    }

    const station = await this.presence.resolveBySerial(serial);
    if (!station) {
      this.logger.warn(`station REST call for unknown serial ${serial}`);
      throw new UnauthorizedException({ code: 'STATION_UNKNOWN', error: 'unknown station' });
    }
    return station;
  }
}

export function bearerToken(header: string | string[] | undefined): string | null {
  const value = first(header);
  const match = value?.match(/^Bearer\s+(.+)$/i);
  return match?.[1]?.trim() || null;
}

function first(value: string | string[] | undefined): string | undefined {
  return (Array.isArray(value) ? value[0] : value)?.trim() || undefined;
}
