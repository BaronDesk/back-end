import { Injectable, Logger, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PresenceService, type StationRef } from './presence.service.js';

/** Dev-only: lets curl / the monitor name the station directly. */
export const DEV_STATION_SERIAL_HEADER = 'x-station-serial';

export interface StationRequestAuth {
  authorization?: string | string[];
  devSerialHeader?: string | string[];
  devSerialQuery?: unknown;
}

/**
 * Identifies the station behind a station-authenticated REST call
 * (GET /stations/me/games).
 *
 * STUB until station credentials exist (Member A / ADR-003 verifyStation):
 * the agent sends `Authorization: Bearer <stationToken>` on the WSS upgrade
 * and on REST, but nothing verifies it yet. In development the token is bound
 * to the serial that completed the handshake on that same token, so the real
 * agent can fetch its catalog with no extra config. `x-station-serial` /
 * `?serialNumber=` also work, for curl. Production refuses every call until
 * `authenticate` verifies a real station credential here.
 */
@Injectable()
export class StationAuthService {
  private readonly logger = new Logger(StationAuthService.name);
  private readonly devMode: boolean;
  /** token -> serial, from WSS handshakes (dev only). */
  private readonly devTokens = new Map<string, string>();

  constructor(
    private readonly presence: PresenceService,
    config: ConfigService,
  ) {
    this.devMode = config.get('NODE_ENV') !== 'production';
  }

  /** Agent gateway, after a handshake: the socket's bearer token now speaks for that serial. */
  bindDevToken(token: string | null, serialNumber: string): void {
    if (!this.devMode || !token) return;
    this.devTokens.set(token, serialNumber);
  }

  async authenticate(auth: StationRequestAuth): Promise<StationRef> {
    const token = bearerToken(auth.authorization);

    // TODO(station-credentials): verify the station JWT and take the station
    // from its claims. Until then there is nothing to verify against.
    if (!this.devMode) {
      throw new UnauthorizedException({ code: 'STATION_AUTH_UNAVAILABLE', error: 'station credentials are not implemented yet' });
    }

    const serial =
      first(auth.devSerialHeader) ??
      (typeof auth.devSerialQuery === 'string' && auth.devSerialQuery ? auth.devSerialQuery : undefined) ??
      (token ? this.devTokens.get(token) : undefined);
    if (!serial) {
      throw new UnauthorizedException({
        code: 'STATION_UNKNOWN',
        error: `unknown station token (dev: connect the agent over /agent-ws first, or send ${DEV_STATION_SERIAL_HEADER})`,
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
