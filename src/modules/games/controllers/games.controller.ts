import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query } from '@nestjs/common';

import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { RequireScope } from '../../../common/decorators/require-scope.decorator.js';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import {
  assignStationSchema,
  createGameSchema,
  installedGamesQuerySchema,
  updateGameSchema,
  uuidParamSchema,
  type AssignStationDto,
  type CreateGameDto,
  type InstalledGamesQuery,
  type UpdateGameDto,
} from '../schemas/games.schemas.js';
import { GamesService } from '../services/games.service.js';

/** Catalog admin. `:id` is the GAME row id (uuid), not the wire gameId. */
@Controller('api/v1')
export class GamesController {
  constructor(private readonly games: GamesService) {}

  @RequireScope('self')
  @Get('games')
  list(@CurrentUser() caller: AccessTokenPayload) {
    return this.games.list(caller);
  }

  @RequireScope('admin')
  @Post('games')
  create(@Body(new ZodValidationPipe(createGameSchema)) dto: CreateGameDto) {
    return this.games.create(dto);
  }

  /** HQ, or a manager whose branch alone offers the game (403 GAME_SHARED_WITH_OTHER_BRANCHES otherwise). */
  @RequireScope('admin')
  @Patch('games/:id')
  update(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
    @Body(new ZodValidationPipe(updateGameSchema)) dto: UpdateGameDto,
  ) {
    return this.games.update(caller, id, dto);
  }

  /** Removes the game from the catalog and every station. HQ, or a manager whose branch alone offers it. */
  @RequireScope('admin')
  @Delete('games/:id')
  remove(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
  ) {
    return this.games.remove(caller, id);
  }

  /** Launcher games the stations found installed, each with the catalog entry it matches: the source for "add to catalog". */
  @RequireScope('staff')
  @Get('games/installed')
  installed(
    @CurrentUser() caller: AccessTokenPayload,
    @Query(new ZodValidationPipe(installedGamesQuerySchema)) query: InstalledGamesQuery,
  ) {
    return this.games.installedGames(caller, query);
  }

  /** Offer the game at every station of a branch. */
  @RequireScope('admin')
  @Put('games/:id/branches/:branchId')
  assignBranch(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
    @Param('branchId', new ZodValidationPipe(uuidParamSchema)) branchId: string,
  ) {
    return this.games.assignBranch(caller, id, branchId);
  }

  @RequireScope('admin')
  @Delete('games/:id/branches/:branchId')
  unassignBranch(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
    @Param('branchId', new ZodValidationPipe(uuidParamSchema)) branchId: string,
  ) {
    return this.games.unassignBranch(caller, id, branchId);
  }

  /** Offer the game on one station, optionally with per-machine target/arguments/workingDirectory. */
  @RequireScope('admin')
  @Put('games/:id/stations/:stationId')
  assignStation(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
    @Param('stationId', new ZodValidationPipe(uuidParamSchema)) stationId: string,
    @Body(new ZodValidationPipe(assignStationSchema)) dto: AssignStationDto,
  ) {
    return this.games.assignStation(caller, id, stationId, dto);
  }

  @RequireScope('admin')
  @Delete('games/:id/stations/:stationId')
  unassignStation(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
    @Param('stationId', new ZodValidationPipe(uuidParamSchema)) stationId: string,
  ) {
    return this.games.unassignStation(caller, id, stationId);
  }

  /** A station's resolved catalog, with its last reported install state per game. */
  @RequireScope('staff')
  @Get('stations/:id/games')
  stationGames(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(uuidParamSchema)) id: string,
  ) {
    return this.games.stationGames(caller, id);
  }
}
