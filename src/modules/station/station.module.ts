import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module.js';
import { StationsController } from './controllers/stations.controller.js';
import { StationAuthGuard } from './guards/station-auth.guard.js';
import { MachinesRepository } from './repository/machines.repository.js';
import { StationPolicyRepository } from './repository/station-policy.repository.js';
import { PresenceService } from './services/presence.service.js';
import { StationAuthService } from './services/station-auth.service.js';
import { StationPolicyService } from './services/station-policy.service.js';
import { StationTokenService } from './services/station-token.service.js';
import { StationsService } from './services/stations.service.js';

@Module({
  imports: [IdentityModule],
  controllers: [StationsController],
  providers: [
    MachinesRepository,
    StationPolicyRepository,
    PresenceService,
    StationPolicyService,
    StationsService,
    StationTokenService,
    StationAuthService,
    StationAuthGuard,
  ],
  exports: [PresenceService, StationPolicyService, StationAuthService, StationAuthGuard],
})
export class StationModule {}
