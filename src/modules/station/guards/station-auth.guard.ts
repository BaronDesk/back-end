import {
  createParamDecorator,
  Injectable,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';

import type { StationRef } from '../services/presence.service.js';
import { DEV_STATION_SERIAL_HEADER, StationAuthService } from '../services/station-auth.service.js';

/**
 * Station-facing REST (the desktop agent, not a user). Pair with @Public() so
 * the global user JwtAuthGuard steps aside; this guard then requires a valid
 * station JWT and puts the station on `request.station`.
 */
@Injectable()
export class StationAuthGuard implements CanActivate {
  constructor(private readonly stationAuth: StationAuthService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    request.station = await this.stationAuth.authenticate({
      authorization: request.headers?.authorization,
      devSerialHeader: request.headers?.[DEV_STATION_SERIAL_HEADER],
      devSerialQuery: request.query?.serialNumber,
    });
    return true;
  }
}

/** The station StationAuthGuard authenticated ("me"). */
export const CurrentStation = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): StationRef => ctx.switchToHttp().getRequest().station,
);
