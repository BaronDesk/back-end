import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';

/** Longer than the backend's 30-day renewal window: a test token gets no `station_credential` unless it asks. */
const NINETY_DAYS_S = 90 * 24 * 60 * 60;

/**
 * A station JWT as enrollment mints it: signed with the user access-token key,
 * `type: "station"`, identity in the claims. `claims` overrides any of them.
 */
export function mintStationToken(
  app: INestApplication,
  machine: { id: string; serialNumber: string; branchId: string },
  claims: Record<string, unknown> = {},
  expiresIn = NINETY_DAYS_S,
): string {
  return app.get(JwtService, { strict: false }).sign(
    { sub: machine.id, type: 'station', serialNumber: machine.serialNumber, branchId: machine.branchId, ...claims },
    { secret: app.get(ConfigService).getOrThrow('JWT_ACCESS_SECRET'), expiresIn },
  );
}
