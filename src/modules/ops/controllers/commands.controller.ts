import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';

import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { RequireScope } from '../../../common/decorators/require-scope.decorator.js';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import {
  issueCommandBodySchema,
  listCommandsQuerySchema,
  type IssueCommandBody,
  type ListCommandsQuery,
} from '../schemas/command.schemas.js';
import { uuidParamSchema } from '../schemas/telemetry.schemas.js';
import { CommandsService } from '../services/commands.service.js';

@Controller('api/v1')
export class CommandsController {
  constructor(private readonly commands: CommandsService) {}

  /** 202: the command is queued; poll GET /commands/:commandId or watch `command_update`. */
  @RequireScope('staff')
  @Post('stations/:id/commands')
  @HttpCode(202)
  issue(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
    @Body(new ZodValidationPipe(issueCommandBodySchema)) body: IssueCommandBody,
  ) {
    return this.commands.issue(caller, id, body);
  }

  @RequireScope('staff')
  @Get('stations/:id/commands')
  list(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
    @Query(new ZodValidationPipe(listCommandsQuerySchema)) query: ListCommandsQuery,
  ) {
    return this.commands.list(caller, id, query);
  }

  @RequireScope('staff')
  @Get('commands/:commandId')
  get(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('commandId', new ZodValidationPipe(uuidParamSchema)) commandId: string,
  ) {
    return this.commands.get(caller, commandId);
  }
}
