import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';

import { RequireScope } from '../../../common/decorators/require-scope.decorator.js';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import {
  createRankSchema,
  idParamSchema,
  updateRankSchema,
  type CreateRankDto,
  type UpdateRankDto,
} from '../schemas/ranks.schemas.js';
import { RanksService } from '../services/ranks.service.js';

@Controller('ranks')
export class RanksController {
  constructor(private readonly ranks: RanksService) {}

  /** Every rank, lowest XP first. */
  @RequireScope('self')
  @Get()
  list() {
    return this.ranks.list();
  }

  @RequireScope('admin')
  @Post()
  create(@Body(new ZodValidationPipe(createRankSchema)) dto: CreateRankDto) {
    return this.ranks.create(dto);
  }

  @RequireScope('admin')
  @Patch(':id')
  update(
    @Param('id', new ZodValidationPipe(idParamSchema)) id: string,
    @Body(new ZodValidationPipe(updateRankSchema)) dto: UpdateRankDto,
  ) {
    return this.ranks.update(id, dto);
  }

  @RequireScope('admin')
  @Delete(':id')
  remove(@Param('id', new ZodValidationPipe(idParamSchema)) id: string) {
    return this.ranks.remove(id);
  }
}
