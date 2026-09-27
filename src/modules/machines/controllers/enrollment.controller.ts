import { Body, Controller, Param, Post } from '@nestjs/common';

import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { Public } from '../../../common/decorators/public.decorator.js';
import { RequireScope } from '../../../common/decorators/require-scope.decorator.js';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import {
  issueEnrollmentTokenSchema,
  redeemEnrollmentTokenSchema,
  type IssueEnrollmentTokenDto,
  type RedeemEnrollmentTokenDto,
} from '../schemas/enrollment.schemas.js';
import { idParamSchema } from '../schemas/machines.schemas.js';
import { EnrollmentService } from '../services/enrollment.service.js';

@Controller()
export class EnrollmentController {
  constructor(private readonly enrollment: EnrollmentService) {}

  
  @RequireScope('admin')
  @Post('machines/enrollment-tokens')
  issueToken(
    @CurrentUser() caller: AccessTokenPayload,
    @Body(new ZodValidationPipe(issueEnrollmentTokenSchema)) dto: IssueEnrollmentTokenDto,
  ) {
    return this.enrollment.issueToken(caller, dto);
  }

  
  @RequireScope('admin')
  @Post('machines/:id/rotate-token')
  rotateToken(@CurrentUser() caller: AccessTokenPayload, @Param('id', new ZodValidationPipe(idParamSchema)) id: string) {
    return this.enrollment.rotateToken(caller, id);
  }

  
  @Public()
  @Post('machines/enroll')
  redeem(@Body(new ZodValidationPipe(redeemEnrollmentTokenSchema)) dto: RedeemEnrollmentTokenDto) {
    return this.enrollment.redeem(dto);
  }
}
