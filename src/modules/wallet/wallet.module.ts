import { Module } from '@nestjs/common';

import { WalletController } from './controllers/wallet.controller.js';
import { WalletRepository } from './repository/wallet.repository.js';
import { WalletService } from './services/wallet.service.js';

@Module({
  controllers: [WalletController],
  providers: [WalletService, WalletRepository],
  exports: [WalletService],
})
export class WalletModule {}