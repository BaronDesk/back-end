import { Body, Controller, Get, NotFoundException, Post } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString } from 'class-validator';

import { CommandService } from './command.service.js';

class IssueCommandDto {
  @IsString() machineId: string;
  @IsString() type: string;
  @IsOptional() @IsObject() payload?: Record<string, unknown>;
}

@ApiTags('ops')
@Controller('ops/commands')
export class CommandController {
  constructor(private readonly commands: CommandService) {}

  @Post()
  issue(@Body() dto: IssueCommandDto) {
    this.assertDev();
    return this.commands.issue(dto.machineId, dto.type, dto.payload ?? {});
  }

  @Get('counts')
  counts() {
    this.assertDev();
    return this.commands.counts();
  }

  private assertDev() {
    // Delete this whole controller once you have real auth. Until then, make sure
    // it cannot possibly answer in production.
    if (process.env.NODE_ENV === 'production') throw new NotFoundException();
  }
}
