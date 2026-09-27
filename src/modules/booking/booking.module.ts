import { Module } from '@nestjs/common';

import { PrismaModule } from '../../infra/prisma/prisma.module.js';
import { BookingController } from './controllers/booking.controller.js';
import { BookingRepository } from './repository/booking.repository.js';
import { BookingService } from './services/booking.service.js';

@Module({
  imports: [PrismaModule],
  controllers: [BookingController],
  providers: [BookingService, BookingRepository],
})
export class BookingModule {}