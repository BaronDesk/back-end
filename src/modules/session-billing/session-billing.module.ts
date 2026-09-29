import { Module } from '@nestjs/common';

import { MembershipModule } from '../membership/membership.module.js';
import { OpsModule } from '../ops/ops.module.js';
import { PricingModule } from '../pricing/pricing.module.js';
import { StationModule } from '../station/station.module.js';
import { WalletModule } from '../wallet/wallet.module.js';
import { SessionsController } from './controllers/sessions.controller.js';
import { SessionsRepository } from './repository/sessions.repository.js';
import { SessionsService } from './services/sessions.service.js';

@Module({
  imports: [StationModule, PricingModule, MembershipModule, WalletModule, OpsModule],
  controllers: [SessionsController],
  providers: [SessionsRepository, SessionsService],
  exports: [SessionsService],
})
export class SessionBillingModule {}
