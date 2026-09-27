import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';

import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { Prisma } from '../../../generated/prisma/index.js';
import { WalletRepository } from '../repository/wallet.repository.js';
import type { CreditDto, DebitDto, ListEntriesQuery } from '../schemas/wallet.schemas.js';
import { toPublicEntry, toPublicWallet } from '../util/public-wallet.js';

@Injectable()
export class WalletService {
  constructor(private readonly wallets: WalletRepository) {}

  async getOrCreateWallet(gamerProfileId: string) {
    const existing = await this.wallets.findByGamerProfileId(gamerProfileId);
    if (existing) return existing;

    try {
      return await this.wallets.createForGamerProfile(gamerProfileId);
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2003') {
        throw new NotFoundException({ code: 'GAMER_PROFILE_NOT_FOUND', error: 'gamer profile not found' });
      }
      throw err;
    }
  }

  async getMyWallet(caller: AccessTokenPayload) {
    const gamerProfileId = await this.resolveOwnGamerProfileId(caller);
    return toPublicWallet(await this.getOrCreateWallet(gamerProfileId));
  }

  async listMyEntries(caller: AccessTokenPayload, query: ListEntriesQuery) {
    const gamerProfileId = await this.resolveOwnGamerProfileId(caller);
    return this.listEntries(gamerProfileId, query.take, query.cursor);
  }

  async getWalletForGamer(gamerProfileId: string) {
    return toPublicWallet(await this.getOrCreateWallet(gamerProfileId));
  }

  async listEntries(gamerProfileId: string, take: number, cursor?: string) {
    const wallet = await this.getOrCreateWallet(gamerProfileId);
    const entries = await this.wallets.listEntries(wallet.id, take, cursor);
    return entries.map(toPublicEntry);
  }

  async credit(gamerProfileId: string, dto: CreditDto) {
    const wallet = await this.getOrCreateWallet(gamerProfileId);
    const entry = await this.wallets.postEntry({
      walletId: wallet.id,
      amount: dto.amount,
      type: dto.type ?? 'CREDIT',
      sessionId: dto.sessionId,
      idempotencyKey: dto.idempotencyKey,
    });
    if (!entry) throw new ConflictException({ code: 'WALLET_POST_FAILED', error: 'could not post entry' });
    return toPublicEntry(entry);
  }

  async debit(gamerProfileId: string, dto: DebitDto) {
    const wallet = await this.getOrCreateWallet(gamerProfileId);
    const entry = await this.wallets.postEntry({
      walletId: wallet.id,
      amount: -dto.amount,
      type: dto.type ?? 'DEBIT',
      sessionId: dto.sessionId,
      idempotencyKey: dto.idempotencyKey,
    });
    if (!entry) {
      throw new ConflictException({ code: 'INSUFFICIENT_FUNDS', error: 'wallet balance cant go negative' }); // this isn't GTA
    }
    return toPublicEntry(entry);
  }

  private async resolveOwnGamerProfileId(caller: AccessTokenPayload): Promise<string> {
    const gamerProfileId = await this.wallets.findGamerProfileIdByUserId(caller.sub);
    if (!gamerProfileId) {
      throw new NotFoundException({ code: 'GAMER_PROFILE_NOT_FOUND', error: 'caller has no gamer profile' });
    }
    return gamerProfileId;
  }
}
