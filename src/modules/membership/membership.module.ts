import { Module } from '@nestjs/common';

import { MembershipController } from './membership.controller.js';
import { MembershipRepository } from './membership.repository.js';
import { MembershipService } from './membership.service.js';

@Module({
  controllers: [MembershipController],
  providers: [MembershipService, MembershipRepository],
  exports: [MembershipService],
})
export class MembershipModule {}
