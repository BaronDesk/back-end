import { Module } from '@nestjs/common';
import { IdentityModule } from '../identity/identity.module.js';
import { OpsModule } from '../ops/ops.module.js';
import { SessionBillingModule } from '../session-billing/session-billing.module.js';

import { EnrollmentController } from './controllers/enrollment.controller.js';
import { MachinesController } from './controllers/machines.controller.js';
import { EnrollmentTokensRepository } from './repository/enrollment-tokens.repository.js';
import { MachinesRepository } from './repository/machines.repository.js';
import { EnrollmentService } from './services/enrollment.service.js';
import { MachinesService } from './services/machines.service.js';


@Module({
  imports: [IdentityModule, OpsModule, SessionBillingModule],
  controllers: [EnrollmentController, MachinesController],
  providers: [EnrollmentService, MachinesService, MachinesRepository, EnrollmentTokensRepository],
  exports: [MachinesService, MachinesRepository],
})
export class MachinesModule {}
