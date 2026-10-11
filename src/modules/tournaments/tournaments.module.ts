import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { WalletModule } from '../wallet/wallet.module.js';
import { OpsModule } from '../ops/ops.module.js';
import { SessionBillingModule } from '../session-billing/session-billing.module.js';
import { StationModule } from '../station/station.module.js';
import { TOURNAMENT_QUEUE } from './tournament-timers.schemas.js';
import { TournamentsController } from './tournaments.controller.js';
import { TournamentsService } from './tournaments.service.js';
import { TournamentTimersProcessor } from './tournament-timers.processor.js';

@Module({
  imports: [
    WalletModule,
    OpsModule,
    SessionBillingModule,
    StationModule,
    BullModule.registerQueue({ name: TOURNAMENT_QUEUE }),
  ],
  controllers: [TournamentsController],
  providers: [TournamentsService, TournamentTimersProcessor],
})
export class TournamentsModule {}
