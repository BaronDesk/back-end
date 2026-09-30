import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import type { StationTokenPayload } from '../../../common/types/jwt-payload.js';
import { TokenService } from '../../identity/services/token.service.js';

/** Who a verified station token speaks for. Taken from the token, never from the handshake. */
export interface StationPrincipal {
  machineId: string;
  serialNumber: string;
  branchId: string;
  /** The credential version the token was issued for (Machine.credentialVersion must match). */
  version: number;
  /** Epoch ms the token expires. */
  expiresAt: number;
}

/** A station token is renewed on connect once it has less than this left. */
const RENEW_WITHIN_MS = 30 * 24 * 60 * 60_000;

/**
 * The station JWT's claims. Minted elsewhere (enrollment) with the same key as
 * user access tokens; `type: "station"` is what tells the two apart. `exp` is
 * required: a station credential that never expires is rejected.
 */
const stationClaimsSchema = z.object({
  sub: z.string().uuid(),
  type: z.literal('station'),
  serialNumber: z.string().trim().min(1),
  branchId: z.string().uuid(),
  ver: z.number().int().positive().optional(),
  exp: z.number(),
}) satisfies z.ZodType<StationTokenPayload & { exp: number }>;

export class InvalidStationTokenError extends Error {}

/**
 * Verifies station credentials. The signature / expiry check is identity's
 * TokenService (same JwtModule, same JWT_ACCESS_SECRET); this only adds the
 * station claim shape on top.
 */
@Injectable()
export class StationTokenService {
  constructor(private readonly tokens: TokenService) {}

  /** Throws InvalidStationTokenError on a missing, malformed, expired, badly signed or non-station token. */
  async verify(token: string | null | undefined): Promise<StationPrincipal> {
    if (!token) throw new InvalidStationTokenError('missing station token');

    let payload: Record<string, unknown>;
    try {
      payload = await this.tokens.verifyAccessKeySignature(token);
    } catch (err) {
      throw new InvalidStationTokenError(`invalid station token: ${(err as Error).message}`);
    }

    const claims = stationClaimsSchema.safeParse(payload);
    if (!claims.success) {
      throw new InvalidStationTokenError(
        payload.type === 'station' ? 'malformed station token claims' : 'not a station token',
      );
    }
    return {
      machineId: claims.data.sub,
      serialNumber: claims.data.serialNumber,
      branchId: claims.data.branchId,
      version: claims.data.ver ?? 1,
      expiresAt: claims.data.exp * 1000,
    };
  }

  /**
   * A fresh token with the same claims when this one expires within 30 days,
   * else null. Sent to a connected (so still admitted) station, which stores
   * it and uses it from its next connect: stations never age out.
   */
  renewIfExpiring(principal: StationPrincipal, now = Date.now()): string | null {
    if (principal.expiresAt - now > RENEW_WITHIN_MS) return null;
    return this.tokens.signStationToken({
      sub: principal.machineId,
      type: 'station',
      serialNumber: principal.serialNumber,
      branchId: principal.branchId,
      ver: principal.version,
    });
  }
}
