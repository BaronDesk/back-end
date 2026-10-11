import { Module } from '@nestjs/common';
import { WalletModule } from '../wallet/wallet.module.js';
import { OpsModule } from '../ops/ops.module.js';
import { TournamentsController } from './tournaments.controller.js';
import { TournamentsService } from './tournaments.service.js';

@Module({
  imports: [WalletModule, OpsModule],
  controllers: [TournamentsController],
  providers: [TournamentsService],
})
export class TournamentsModule {}
