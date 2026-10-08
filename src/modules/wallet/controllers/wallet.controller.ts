import { Body, Controller, ForbiddenException, Get, Param, Post, Query } from '@nestjs/common';

import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { RequireScope } from '../../../common/decorators/require-scope.decorator.js';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { SCOPE_RANK } from '../../../common/utils/scope.js';
import {
  creditSchema, debitSchema, gamerProfileIdParamSchema, listEntriesQuerySchema,
  type CreditDto, type DebitDto, type ListEntriesQuery,
} from '../schemas/wallet.schemas.js';
import { WalletService } from '../services/wallet.service.js';
import { AuditLogService } from '../../../common/audit/audit-log.service.js';

@Controller('wallets')
export class WalletController {
  constructor(
    private readonly wallet: WalletService,
    private readonly audit: AuditLogService,
  ) {}

  @RequireScope('self')
  @Get('me')
  getMyWallet(@CurrentUser() caller: AccessTokenPayload) {
    return this.wallet.getMyWallet(caller);
  }

  @RequireScope('self')
  @Get('me/entries')
  getMyEntries(
    @CurrentUser() caller: AccessTokenPayload,
    @Query(new ZodValidationPipe(listEntriesQuerySchema)) query: ListEntriesQuery,
  ) {
    return this.wallet.listMyEntries(caller, query);
  }

  @RequireScope('staff')
  @Get(':gamerProfileId')
  getWallet(@Param('gamerProfileId', new ZodValidationPipe(gamerProfileIdParamSchema)) gamerProfileId: string) {
    return this.wallet.getWalletForGamer(gamerProfileId);
  }

  @RequireScope('staff')
  @Get(':gamerProfileId/entries')
  getEntries(
    @Param('gamerProfileId', new ZodValidationPipe(gamerProfileIdParamSchema)) gamerProfileId: string,
    @Query(new ZodValidationPipe(listEntriesQuerySchema)) query: ListEntriesQuery,
  ) {
    return this.wallet.listEntries(gamerProfileId, query.take, query.cursor);
  }

  // any staff can top up; a refund or an adjustment is manager+ (checked on the body's type)
  @RequireScope('staff')
  @Post(':gamerProfileId/credit')
  async credit(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('gamerProfileId', new ZodValidationPipe(gamerProfileIdParamSchema)) gamerProfileId: string,
    @Body(new ZodValidationPipe(creditSchema)) dto: CreditDto,
  ) {
    if ((dto.type ?? 'CREDIT') !== 'CREDIT' && SCOPE_RANK[caller.scope] < SCOPE_RANK.admin) {
      throw new ForbiddenException({ code: 'INSUFFICIENT_SCOPE', error: 'refunds and adjustments require admin scope' });
    }
    const entry = await this.wallet.credit(gamerProfileId, dto);
    if (dto.type === 'REFUND' || dto.type === 'ADJUSTMENT') {
      await this.audit.record(caller.sub, 'UPDATE', `wallet:${gamerProfileId}`, {
          metadata: { event: dto.type === 'REFUND' ? 'WALLET_REFUND' : 'WALLET_ADJUSTMENT_CREDIT', amount: dto.amount },
        });
    }
    return entry;
  }

  // taking money out of a wallet by hand is manager+
  @RequireScope('admin')
  @Post(':gamerProfileId/debit')
  async debit(
    @CurrentUser() caller: AccessTokenPayload,
    @Param('gamerProfileId', new ZodValidationPipe(gamerProfileIdParamSchema)) gamerProfileId: string,
    @Body(new ZodValidationPipe(debitSchema)) dto: DebitDto,
  ) {
    const entry = await this.wallet.debit(gamerProfileId, dto);
    await this.audit.record(caller.sub, 'UPDATE', `wallet:${gamerProfileId}`, {
        metadata: { event: 'WALLET_ADJUSTMENT_DEBIT', amount: dto.amount, type: dto.type ?? 'DEBIT' },
      });
    return entry;
  }
}
