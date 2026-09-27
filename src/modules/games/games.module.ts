import { Module } from '@nestjs/common';

import { StationModule } from '../station/station.module.js';
import { GamesController } from './controllers/games.controller.js';
import { StationCatalogController } from './controllers/station-catalog.controller.js';
import { GamesRepository } from './repository/games.repository.js';
import { GamesService } from './services/games.service.js';

@Module({
  imports: [StationModule],
  controllers: [GamesController, StationCatalogController],
  providers: [GamesRepository, GamesService],
  exports: [GamesService],
})
export class GamesModule {}
