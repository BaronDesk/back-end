import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';

import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { RequireScope } from '../../../common/decorators/require-scope.decorator.js';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import {
  createGameSchema,
  gameIdParamSchema,
  updateGameSchema,
  type CreateGameDto,
  type UpdateGameDto,
} from '../schemas/games.schemas.js';
import { GamesService } from '../services/games.service.js';

@Controller('api/v1/games')
export class GamesController {
  constructor(private readonly games: GamesService) {}

  @RequireScope('self')
  @Get()
  list(@CurrentUser() caller: AccessTokenPayload) {
    return this.games.list(caller);
  }

  @RequireScope('admin')
  @Post()
  create(@Body(new ZodValidationPipe(createGameSchema)) dto: CreateGameDto) {
    return this.games.create(dto);
  }

  @RequireScope('admin')
  @Patch(':id')
  update(
    @Param('id', new ZodValidationPipe(gameIdParamSchema)) id: string,
    @Body(new ZodValidationPipe(updateGameSchema)) dto: UpdateGameDto,
  ) {
    return this.games.update(id, dto);
  }
}
