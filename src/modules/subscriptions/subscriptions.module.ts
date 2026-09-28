import { Module } from '@nestjs/common';

import { WalletModule } from '../wallet/wallet.module.js';
import { SubscriptionsController } from './controllers/subscriptions.controller.js';
import { SubscriptionsRepository } from './repository/subscriptions.repository.js';
import { SubscriptionsService } from './services/subscriptions.service.js';

@Module({
  imports: [WalletModule],
  controllers: [SubscriptionsController],
  providers: [SubscriptionsService, SubscriptionsRepository],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
