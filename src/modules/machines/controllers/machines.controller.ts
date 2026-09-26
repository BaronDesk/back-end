import { Controller, Get, HttpCode, Param, Post, Query } from '@nestjs/common';

import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { RequireScope } from '../../../common/decorators/require-scope.decorator.js';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import {
  idParamSchema,
  listMachinesQuerySchema,
  type ListMachinesQueryDto,
} from '../schemas/machines.schemas.js';
import { MachinesService } from '../services/machines.service.js';

@Controller()
export class MachinesController {
  constructor(private readonly machines: MachinesService) {}

  // staff(branch): staff/managers see their own branch; hq sees everything, or one branch via ?branchId.
  @RequireScope('staff')
  @Get('machines')
  list(
    @CurrentUser() caller: AccessTokenPayload,
    @Query(new ZodValidationPipe(listMachinesQuerySchema)) query: ListMachinesQueryDto,
  ) {
    return this.machines.list(caller, query);
  }

  @RequireScope('staff')
  @Get('machines/:id')
  get(@CurrentUser() caller: AccessTokenPayload, @Param('id', new ZodValidationPipe(idParamSchema)) id: string) {
    return this.machines.get(caller, id);
  }

  // admin(branch): these mutate an existing resource, not create one — 200, not the POST default 201.
  @RequireScope('admin')
  @HttpCode(200)
  @Post('machines/:id/approve')
  approve(@CurrentUser() caller: AccessTokenPayload, @Param('id', new ZodValidationPipe(idParamSchema)) id: string) {
    return this.machines.approve(caller, id);
  }

  @RequireScope('admin')
  @HttpCode(200)
  @Post('machines/:id/reject')
  reject(@CurrentUser() caller: AccessTokenPayload, @Param('id', new ZodValidationPipe(idParamSchema)) id: string) {
    return this.machines.reject(caller, id);
  }

  @RequireScope('admin')
  @HttpCode(200)
  @Post('machines/:id/revoke')
  revoke(@CurrentUser() caller: AccessTokenPayload, @Param('id', new ZodValidationPipe(idParamSchema)) id: string) {
    return this.machines.revoke(caller, id);
  }
}
