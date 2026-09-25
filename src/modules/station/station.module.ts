import { Module } from '@nestjs/common';

import { StationsController } from './controllers/stations.controller.js';
import { MachinesRepository } from './repository/machines.repository.js';
import { PresenceService } from './services/presence.service.js';
import { StationsService } from './services/stations.service.js';

@Module({
  controllers: [StationsController],
  providers: [MachinesRepository, PresenceService, StationsService],
  exports: [PresenceService],
})
export class StationModule {}
