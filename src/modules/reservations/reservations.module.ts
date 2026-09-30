import { Module } from '@nestjs/common';

import { SessionBillingModule } from '../session-billing/session-billing.module.js';
import { ReservationsController } from './reservations.controller.js';
import { ReservationsRepository } from './reservations.repository.js';
import { ReservationsService } from './reservations.service.js';

@Module({
  imports: [SessionBillingModule],
  controllers: [ReservationsController],
  providers: [ReservationsService, ReservationsRepository],
})
export class ReservationsModule {}
