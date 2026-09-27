import { Controller, Get, Headers, Query } from '@nestjs/common';

import { Public } from '../../../common/decorators/public.decorator.js';
import {
  DEV_STATION_SERIAL_HEADER,
  StationAuthService,
} from '../../station/services/station-auth.service.js';
import { GamesService } from '../services/games.service.js';

/**
 * Station-facing (the desktop agent, not a user). No `api/v1` prefix: the
 * agent's default URL is `/stations/me/games` on its server host. Skips the
 * user JWT guard; the station is authenticated by StationAuthService instead.
 */
@Controller('stations/me')
export class StationCatalogController {
  constructor(
    private readonly games: GamesService,
    private readonly stationAuth: StationAuthService,
  ) {}

  /** The agent pulls this on every (re)connect and on CATALOG_UPDATE. */
  @Public()
  @Get('games')
  async catalog(
    @Headers('authorization') authorization: string | undefined,
    @Headers(DEV_STATION_SERIAL_HEADER) devSerialHeader: string | undefined,
    @Query('serialNumber') devSerialQuery: unknown,
  ) {
    const station = await this.stationAuth.authenticate({ authorization, devSerialHeader, devSerialQuery });
    return this.games.catalogFor(station);
  }
}
