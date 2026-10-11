import { Module } from '@nestjs/common';

import { RanksController } from './controllers/ranks.controller.js';
import { RanksRepository } from './repository/ranks.repository.js';
import { RanksService } from './services/ranks.service.js';

@Module({
  controllers: [RanksController],
  providers: [RanksService, RanksRepository],
  // Identity places a gamer's XP on the ranks (GET /auth/me, user lists).
  exports: [RanksService],
})
export class RanksModule {}
