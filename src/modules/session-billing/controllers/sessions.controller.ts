import { Body, Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';

import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { RequireScope } from '../../../common/decorators/require-scope.decorator.js';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import {
  endSessionBodySchema,
  idParamSchema,
  listSessionsQuerySchema,
  startSessionSchema,
  type EndSessionBodyDto,
  type ListSessionsQuery,
  type StartSessionDto,
} from '../schemas/session.schemas.js';
import { SessionsService } from '../services/sessions.service.js';

@Controller('sessions')
export class SessionsController {
  constructor(private readonly sessions: SessionsService) {}

  @RequireScope('staff')
  @Post()
  start(@CurrentUser() caller: AccessTokenPayload, @Body(new ZodValidationPipe(startSessionSchema)) dto: StartSessionDto) {
    return this.sessions.start(caller, dto.reservationId);
  }

  /** The desk's session list (replaces the per-browser list). */
  @RequireScope('staff')
  @Get()
  list(@CurrentUser() caller: AccessTokenPayload, @Query(new ZodValidationPipe(listSessionsQuerySchema)) query: ListSessionsQuery) {
    return this.sessions.list(caller, query);
  }

  /** The gamer's own session now (null when not playing). Declared before :id. */
  @RequireScope('self')
  @Get('me/current')
  current(@CurrentUser() caller: AccessTokenPayload) {
    return this.sessions.currentForGamer(caller.sub);
  }

  @RequireScope('staff')
  @Get(':id')
  get(@CurrentUser() caller: AccessTokenPayload, @Param('id', new ZodValidationPipe(idParamSchema)) id: string) {
    return this.sessions.get(caller, id);
  }

  @RequireScope('staff')
  @Post(':id/end')
  @HttpCode(202)
  end(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(idParamSchema)) id: string,
    @Body(new ZodValidationPipe(endSessionBodySchema)) dto: EndSessionBodyDto,
  ) {
    return this.sessions.end(caller, id, dto.reason);
  }

  /** Settles now, without waiting for the station to confirm the end. */
  @RequireScope('staff')
  @Post(':id/force-close')
  @HttpCode(200)
  forceClose(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(idParamSchema)) id: string,
    @Body(new ZodValidationPipe(endSessionBodySchema)) dto: EndSessionBodyDto,
  ) {
    return this.sessions.forceClose(caller, id, dto.reason);
  }
}
