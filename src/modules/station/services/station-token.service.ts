import { Injectable } from '@nestjs/common';
import { z } from 'zod';

import { TokenService } from '../../identity/services/token.service.js';

/** Who a verified station token speaks for. Taken from the token, never from the handshake. */
export interface StationPrincipal {
  machineId: string;
  serialNumber: string;
  branchId: string;
}

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
  exp: z.number(),
});

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
    return { machineId: claims.data.sub, serialNumber: claims.data.serialNumber, branchId: claims.data.branchId };
  }
}
