import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

/**
 * A station JWT as enrollment mints it: signed with the user access-token key,
 * `type: "station"`, identity in the claims. `claims` overrides any of them.
 */
export function mintStationToken(
  app: INestApplication,
  machine: { id: string; serialNumber: string; branchId: string },
  claims: Record<string, unknown> = {},
  expiresIn = 3600,
): string {
  return app.get(JwtService, { strict: false }).sign(
    { sub: machine.id, type: 'station', serialNumber: machine.serialNumber, branchId: machine.branchId, ...claims },
    { secret: app.get(ConfigService).getOrThrow('JWT_ACCESS_SECRET'), expiresIn },
  );
}
