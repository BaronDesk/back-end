import { Module } from '@nestjs/common';

import { GamesController } from './controllers/games.controller.js';
import { GamesRepository } from './repository/games.repository.js';
import { GamesService } from './services/games.service.js';

@Module({
  controllers: [GamesController],
  providers: [GamesRepository, GamesService],
  exports: [GamesService],
})
export class GamesModule {}
