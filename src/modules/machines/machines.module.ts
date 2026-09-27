import { Module } from '@nestjs/common';

import { EnrollmentController } from './controllers/enrollment.controller.js';
import { MachinesController } from './controllers/machines.controller.js';
import { EnrollmentTokensRepository } from './repository/enrollment-tokens.repository.js';
import { MachinesRepository } from './repository/machines.repository.js';
import { EnrollmentService } from './services/enrollment.service.js';
import { MachinesService } from './services/machines.service.js';


@Module({
  controllers: [EnrollmentController, MachinesController],
  providers: [EnrollmentService, MachinesService, MachinesRepository, EnrollmentTokensRepository],
  exports: [MachinesService],
})
export class MachinesModule {}
