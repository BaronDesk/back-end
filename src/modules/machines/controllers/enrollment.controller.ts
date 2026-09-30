import { Body, Controller, HttpCode, Logger, Param, Post } from '@nestjs/common';

import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { Public } from '../../../common/decorators/public.decorator.js';
import { RequireScope } from '../../../common/decorators/require-scope.decorator.js';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import {
  issueEnrollmentTokenSchema,
  redeemEnrollmentTokenSchema,
  type IssueEnrollmentTokenDto,
} from '../schemas/enrollment.schemas.js';
import { idParamSchema } from '../schemas/machines.schemas.js';
import { EnrollmentService, type EnrollmentResult } from '../services/enrollment.service.js';

@Controller()
export class EnrollmentController {
  private readonly logger = new Logger(EnrollmentController.name);

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

  // The agent polls this and reads only the body's status, so refusals
  // (including a malformed body) are a 200 REJECTED rather than a 4xx.
  @Public()
  @HttpCode(200)
  @Post('enrollment/request')
  async redeem(@Body() body: unknown): Promise<EnrollmentResult> {
    const parsed = redeemEnrollmentTokenSchema.safeParse(body);
    if (!parsed.success) {
      this.logger.warn(`enrollment request rejected: INVALID_REQUEST ${JSON.stringify(parsed.error.issues)}`);
      return { status: 'REJECTED', reason: 'INVALID_REQUEST' };
    }
    const result = await this.enrollment.redeem(parsed.data);
    if (result.status === 'REJECTED') {
      this.logger.warn(`enrollment request rejected: ${result.reason} (serial ${parsed.data.serialNumber})`);
    } else {
      this.logger.log(`enrollment request: ${result.status} machine ${result.machineId} (serial ${parsed.data.serialNumber})`);
    }
    return result;
  }
}
