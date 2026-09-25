import { Module } from '@nestjs/common';

import { IdentityModule } from '../identity/identity.module.js';
import { StationModule } from '../station/station.module.js';
import { AgentRegistry } from '../../infra/realtime/registry.js';
import { AgentGateway } from './agent.gateway.js';
import { DashboardGateway } from './dashboard.gateway.js';

@Module({
  imports: [IdentityModule, StationModule],
  providers: [AgentGateway, DashboardGateway, AgentRegistry],
  exports: [DashboardGateway],
})
export class OpsModule {}
