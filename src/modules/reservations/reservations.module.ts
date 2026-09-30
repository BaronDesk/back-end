import { Module } from '@nestjs/common';

import { MembershipModule } from '../membership/membership.module.js';
import { SessionBillingModule } from '../session-billing/session-billing.module.js';
import { ReservationsController } from './reservations.controller.js';
import { ReservationsRepository } from './reservations.repository.js';
import { ReservationsService } from './reservations.service.js';

@Module({
  imports: [SessionBillingModule, MembershipModule],
  controllers: [ReservationsController],
  providers: [ReservationsService, ReservationsRepository],
})
export class ReservationsModule {}
