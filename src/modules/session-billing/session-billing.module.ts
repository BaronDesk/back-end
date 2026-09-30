import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { MembershipModule } from '../membership/membership.module.js';
import { OpsModule } from '../ops/ops.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { StationModule } from '../station/station.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { SessionsController } from './controllers/sessions.controller.js';
import { SessionsRepository } from './repository/sessions.repository.js';
import { SessionsService } from './services/sessions.service.js';
import { RUNOUT_QUEUE } from './schemas/runout-timer.schemas.js';
import { RunoutTimerProcessor } from './services/runout-timer.processor.js';
import { RunoutTimerService } from './services/runout-timer.service.js';

@Module({
  imports: [StationModule, PricingModule, MembershipModule, WalletModule, OpsModule, BullModule.registerQueue({ name: RUNOUT_QUEUE })],
  controllers: [SessionsController],
  providers: [SessionsRepository, SessionsService, RunoutTimerService, RunoutTimerProcessor],
  exports: [SessionsService],
})
export class SessionBillingModule {}
