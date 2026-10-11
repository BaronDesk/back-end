import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequireScope } from '../../common/decorators/require-scope.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../../common/types/jwt-payload.js';
import { TournamentsService } from './tournaments.service.js';
import {
  createTournamentSchema,
  entrantSchema,
  idSchema,
  inviteSchema,
  resultSchema,
} from './tournaments.schemas.js';

@Controller('tournaments')
export class TournamentsController {
  constructor(private readonly tournaments: TournamentsService) {}

  @Get() list() {
    return this.tournaments.list();
  }
  @Get(':id') get(@Param('id', new ZodValidationPipe(idSchema)) id: string) {
    return this.tournaments.get(id);
  }

  @RequireScope('admin')
  @Post()
  create(
    @CurrentUser() caller: AccessTokenPayload,
    @Body(new ZodValidationPipe(createTournamentSchema)) body: any,
  ) {
    return this.tournaments.create(caller, body);
  }

  @RequireScope('admin')
  @Post(':id/publish')
  publish(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
  ) {
    return this.tournaments.publish(caller, id);
  }

  @RequireScope('self')
  @Post(':id/entrants/solo')
  solo(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(entrantSchema)) body: any,
  ) {
    return this.tournaments.createEntrant(caller, id, 'SOLO', body.name);
  }

  @RequireScope('self')
  @Post(':id/entrants/teams')
  team(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(entrantSchema)) body: any,
  ) {
    return this.tournaments.createEntrant(caller, id, 'TEAM', body.name);
  }

  @RequireScope('self')
  @Post('entrants/:entrantId/invites')
  invite(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('entrantId', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(inviteSchema)) body: any,
  ) {
    return this.tournaments.invite(caller, id, body.username);
  }

  @RequireScope('self')
  @Post('members/:memberId/accept')
  accept(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('memberId', new ZodValidationPipe(idSchema)) id: string,
  ) {
    return this.tournaments.acceptInvite(caller, id);
  }

  @RequireScope('self')
  @Post('members/:memberId/pay')
  pay(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('memberId', new ZodValidationPipe(idSchema)) id: string,
  ) {
    return this.tournaments.pay(caller, id);
  }

  @RequireScope('staff')
  @Post(':id/close-registration')
  closeRegistration(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
  ) {
    return this.tournaments.closeRegistration(caller, id);
  }

  @RequireScope('staff')
  @Post(':id/entrants/:entrantId/check-in')
  checkIn(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
    @Param('entrantId', new ZodValidationPipe(idSchema)) entrant: string,
  ) {
    return this.tournaments.checkIn(caller, id, entrant);
  }

  @RequireScope('staff')
  @Post(':id/start')
  start(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(idSchema)) id: string,
  ) {
    return this.tournaments.start(caller, id);
  }

  @RequireScope('staff')
  @Patch('matches/:matchId/result')
  result(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('matchId', new ZodValidationPipe(idSchema)) id: string,
    @Body(new ZodValidationPipe(resultSchema)) body: any,
  ) {
    return this.tournaments.reportResult(caller, id, body);
  }
}
