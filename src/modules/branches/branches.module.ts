import { Module } from '@nestjs/common';

import { StationModule } from '../station/station.module.js';
import { BranchesController } from './branches.controller.js';
import { BranchesRepository } from './branches.repository.js';
import { BranchesService } from './branches.service.js';

@Module({
  imports: [StationModule],
  controllers: [BranchesController],
  providers: [BranchesService, BranchesRepository],
})
export class BranchesModule {}
