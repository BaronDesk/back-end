import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module.js';
import { StationModule } from '../station/station.module.js';
import { AgentRegistry } from '../../infra/realtime/registry.js';
import { AgentGateway } from './agent.gateway.js';
import { AlertsController } from './controllers/alerts.controller.js';
import { TelemetryController } from './controllers/telemetry.controller.js';
import { DashboardGateway } from './dashboard.gateway.js';
import { OpsRepository } from './repository/ops.repository.js';
import { AlertsService } from './services/alerts.service.js';
import { TelemetryHistoryService } from './services/telemetry-history.service.js';
import { TelemetryService } from './services/telemetry.service.js';

@Module({
  imports: [IdentityModule, StationModule],
  controllers: [TelemetryController, AlertsController],
  providers: [
    AgentGateway,
    DashboardGateway,
    AgentRegistry,
    OpsRepository,
    AlertsService,
    TelemetryService,
    TelemetryHistoryService,
  ],
  exports: [DashboardGateway],
})
export class OpsModule {}
