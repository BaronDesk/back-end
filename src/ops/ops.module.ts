import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';

import { COMMANDS_QUEUE } from './commands.constants.js';
import { CommandService } from './command.service.js';
import { CommandProcessor } from './command.processor.js';
import { CommandController } from './command.controller.js';

@Module({
  imports: [BullModule.registerQueue({ name: COMMANDS_QUEUE })],
  controllers: [CommandController],
  providers: [CommandService, CommandProcessor],
  exports: [CommandService],
})
export class OpsModule {}
