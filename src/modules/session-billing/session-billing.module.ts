import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { MembershipModule } from '../membership/membership.module.js';
import { OpsModule } from '../ops/ops.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { StationModule } from '../station/station.module.js';
import { SubscriptionsModule } from '../subscriptions/subscriptions.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { SessionsController } from './controllers/sessions.controller.js';
import { SessionsRepository } from './repository/sessions.repository.js';
import { SessionsService } from './services/sessions.service.js';
import { RUNOUT_QUEUE } from './schemas/runout-timer.schemas.js';
import { RunoutTimerProcessor } from './services/runout-timer.processor.js';
import { RunoutTimerService } from './services/runout-timer.service.js';
import { SessionExtensionsService } from './services/session-extensions.service.js';
import { SessionLoginService } from './services/session-login.service.js';
import { SessionMeteringService } from './services/session-metering.service.js';
import { SessionNoticesService } from './services/session-notices.service.js';
import { SessionQueriesService } from './services/session-queries.service.js';
import { SessionRunoutService } from './services/session-runout.service.js';
import { SessionSweepService } from './services/session-sweep.service.js';
import { StationLinkService } from './services/station-link.service.js';

@Module({
  imports: [StationModule, PricingModule, MembershipModule, SubscriptionsModule, WalletModule, OpsModule, BullModule.registerQueue({ name: RUNOUT_QUEUE })],
  controllers: [SessionsController],
  providers: [
    SessionsRepository,
    SessionsService,
    SessionLoginService,
    SessionMeteringService,
    SessionRunoutService,
    StationLinkService,
    SessionExtensionsService,
    SessionSweepService,
    SessionQueriesService,
    SessionNoticesService,
    RunoutTimerService,
    RunoutTimerProcessor,
  ],
  exports: [SessionsService],
})
export class SessionBillingModule {}
