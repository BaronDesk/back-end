import { Body, Controller, Get, Param, Patch, Post } from '@nestjs/common';
import { z } from 'zod';

import { Public } from '../../common/decorators/public.decorator.js';
import { CurrentUser } from '../../common/decorators/current-user.decorator.js';
import { RequireScope } from '../../common/decorators/require-scope.decorator.js';
import { ZodValidationPipe } from '../../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../../common/types/jwt-payload.js';
import { BranchesService } from './branches.service.js';

const idParamSchema = z.string().uuid();
const createBranchSchema = z.object({
  name: z.string().trim().min(1).max(100),
  location: z.string().trim().min(1).max(200),
});
const updateBranchSchema = createBranchSchema.partial().refine((v) => Object.keys(v).length > 0, 'nothing to update');

@Controller('branches')
export class BranchesController {
  constructor(private readonly branches: BranchesService) {}

  /** Public: the sign-up form lets a new gamer pick their branch. */
  @Public()
  @Get()
  list() {
    return this.branches.list();
  }

  @RequireScope('hq')
  @Post()
  create(@Body(new ZodValidationPipe(createBranchSchema)) dto: z.infer<typeof createBranchSchema>) {
    return this.branches.create(dto);
  }

  @RequireScope('hq')
  @Patch(':id')
  update(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('id', new ZodValidationPipe(idParamSchema)) id: string,
    @Body(new ZodValidationPipe(updateBranchSchema)) dto: z.infer<typeof updateBranchSchema>,
  ) {
    return this.branches.update(caller, id, dto);
  }

  /** The branch's stations for booking: any logged-in user (gamers book any branch). */
  @RequireScope('self')
  @Get(':id/stations')
  stations(@Param('id', new ZodValidationPipe(idParamSchema)) id: string) {
    return this.branches.stations(id);
  }
}
