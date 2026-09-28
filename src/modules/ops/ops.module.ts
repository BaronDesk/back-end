import { BullModule } from '@nestjs/bullmq';
import { Module } from '@nestjs/common';

import { GamesModule } from '../games/games.module.js';
import { IdentityModule } from '../identity/identity.module.js';
import { StationModule } from '../station/station.module.js';
import { AgentRegistry } from '../../infra/realtime/registry.js';
import { AgentGateway } from './agent.gateway.js';
import { AlertsController } from './controllers/alerts.controller.js';
import { CommandsController } from './controllers/commands.controller.js';
import { TelemetryController } from './controllers/telemetry.controller.js';
import { DashboardGateway } from './dashboard.gateway.js';
import { CommandsRepository } from './repository/commands.repository.js';
import { OpsRepository } from './repository/ops.repository.js';
import { AlertsService } from './services/alerts.service.js';
import { CommandAckTracker } from './services/command-ack-tracker.js';
import { CommandProcessor } from './services/command.processor.js';
import { COMMAND_QUEUE, CommandsService } from './services/commands.service.js';
import { TelemetryHistoryService } from './services/telemetry-history.service.js';
import { TelemetryService } from './services/telemetry.service.js';

@Module({
  imports: [IdentityModule, StationModule, GamesModule, BullModule.registerQueue({ name: COMMAND_QUEUE })],
  controllers: [TelemetryController, AlertsController, CommandsController],
  providers: [
    AgentGateway,
    DashboardGateway,
    AgentRegistry,
    OpsRepository,
    AlertsService,
    TelemetryService,
    TelemetryHistoryService,
    CommandsRepository,
    CommandsService,
    CommandAckTracker,
    CommandProcessor,
  ],
  exports: [DashboardGateway],
})
export class OpsModule {}
