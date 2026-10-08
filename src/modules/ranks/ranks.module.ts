import { Module } from '@nestjs/common';

import { RanksController } from './controllers/ranks.controller.js';
import { RanksRepository } from './repository/ranks.repository.js';
import { RanksService } from './services/ranks.service.js';

@Module({
  controllers: [RanksController],
  providers: [RanksService, RanksRepository],
})
export class RanksModule {}
