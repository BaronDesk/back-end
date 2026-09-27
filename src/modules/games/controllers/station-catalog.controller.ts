import { Controller, Get, UseGuards } from '@nestjs/common';

import { Public } from '../../../common/decorators/public.decorator.js';
import { CurrentStation, StationAuthGuard } from '../../station/guards/station-auth.guard.js';
import type { StationRef } from '../../station/services/presence.service.js';
import { GamesService } from '../services/games.service.js';

/**
 * Station-facing (the desktop agent, not a user). No `api/v1` prefix: the
 * agent's default URL is `/stations/me/games` on its server host. Skips the
 * user JWT guard; StationAuthGuard verifies the station JWT instead, and "me"
 * is the token's machineId.
 */
@Controller('stations/me')
@Public()
@UseGuards(StationAuthGuard)
export class StationCatalogController {
  constructor(private readonly games: GamesService) {}

  /** The agent pulls this on every (re)connect and on CATALOG_UPDATE. */
  @Get('games')
  catalog(@CurrentStation() station: StationRef) {
    return this.games.catalogFor(station);
  }
}
