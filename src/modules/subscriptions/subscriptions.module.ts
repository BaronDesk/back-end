import { Module } from '@nestjs/common';

import { SubscriptionsController } from './controllers/subscriptions.controller.js';
import { SubscriptionsRepository } from './repository/subscriptions.repository.js';
import { SubscriptionsService } from './services/subscriptions.service.js';

@Module({
  controllers: [SubscriptionsController],
  providers: [SubscriptionsService, SubscriptionsRepository],
  exports: [SubscriptionsService],
})
export class SubscriptionsModule {}
