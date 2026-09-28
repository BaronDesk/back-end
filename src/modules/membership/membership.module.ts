import { Module } from '@nestjs/common';

import { WalletModule } from '../wallet/wallet.module.js';
import { MembershipController } from './controllers/membership.controller.js';
import { MembershipRepository } from './repository/membership.repository.js';
import { MembershipService } from './services/membership.service.js';

@Module({
  imports: [WalletModule],
  controllers: [MembershipController],
  providers: [MembershipService, MembershipRepository],
  exports: [MembershipService],
})
export class MembershipModule {}
