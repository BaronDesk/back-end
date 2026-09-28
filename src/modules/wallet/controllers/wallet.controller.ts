import { Body, Controller, Get, Param, Post, Query } from '@nestjs/common';

import { CurrentUser } from '../../../common/decorators/current-user.decorator.js';
import { RequireScope } from '../../../common/decorators/require-scope.decorator.js';
import { ZodValidationPipe } from '../../../common/pipes/zod-validation.pipe.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import {
  creditSchema, debitSchema, gamerProfileIdParamSchema, listEntriesQuerySchema,
  type CreditDto, type DebitDto, type ListEntriesQuery,
} from '../schemas/wallet.schemas.js';
import { WalletService } from '../services/wallet.service.js';

@Controller('wallets')
export class WalletController {
  constructor(private readonly wallet: WalletService) {}

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

  @RequireScope('staff')
  @Post(':gamerProfileId/credit')
  credit(
    @Param('gamerProfileId', new ZodValidationPipe(gamerProfileIdParamSchema)) gamerProfileId: string,
    @Body(new ZodValidationPipe(creditSchema)) dto: CreditDto,
  ) {
    return this.wallet.credit(gamerProfileId, dto);
  }

  @RequireScope('staff')
  @Post(':gamerProfileId/debit')
  debit(
    @Param('gamerProfileId', new ZodValidationPipe(gamerProfileIdParamSchema)) gamerProfileId: string,
    @Body(new ZodValidationPipe(debitSchema)) dto: DebitDto,
  ) {
    return this.wallet.debit(gamerProfileId, dto);
  }
}