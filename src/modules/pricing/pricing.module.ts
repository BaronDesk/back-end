import { Module } from '@nestjs/common';

import { PricingController } from './controllers/pricing.controller.js';
import { PricingRepository } from './repository/pricing.repository.js';
import { PricingService } from './services/pricing.service.js';

@Module({
  controllers: [PricingController],
  providers: [PricingService, PricingRepository],
  exports: [PricingService],
})
export class PricingModule {}