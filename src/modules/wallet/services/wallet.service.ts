import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Subject } from 'rxjs';

import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { Prisma } from '../../../generated/prisma/index.js';
import { WalletRepository } from '../repository/wallet.repository.js';
import type { CreditDto, DebitDto, ListEntriesQuery } from '../schemas/wallet.schemas.js';
import { toPublicEntry, toPublicWallet } from '../util/public-wallet.js';

/** Money of the gamer's that other spending must not touch (e.g. what a running session already used). */
export type ReserveProvider = (gamerProfileId: string) => Promise<number>;

@Injectable()
export class WalletService {
  readonly credited = new Subject<{ gamerProfileId: string; amount: number; balanceAfter: number }>();
  /** Every debit but a session settlement: the money a running session can still use went down. */
  readonly debited = new Subject<{ gamerProfileId: string; amount: number; balanceAfter: number }>();

  private reserve?: ReserveProvider;

  constructor(private readonly wallets: WalletRepository) {}

  /** Session-billing registers what running sessions have used so far (it can't be imported here). */
  setReserveProvider(provider: ReserveProvider): void {
    this.reserve = provider;
  }

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
    this.credited.next({ gamerProfileId, amount: dto.amount, balanceAfter: entry.balanceAfter });
    return toPublicEntry(entry);
  }

  /**
   * A purchase, a desk debit: never overdraws, and never spends what a
   * running session has already used (that is paid when the session ends).
   */
  async debit(gamerProfileId: string, dto: DebitDto) {
    const wallet = await this.getOrCreateWallet(gamerProfileId);
    const reserved = this.reserve ? await this.reserve(gamerProfileId) : 0;
    if (reserved > 0 && wallet.balance - reserved < dto.amount) {
      throw new ConflictException({
        code: 'INSUFFICIENT_FUNDS',
        error: 'part of the balance is held for the session in progress',
      });
    }
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
    this.debited.next({ gamerProfileId, amount: dto.amount, balanceAfter: entry.balanceAfter });
    return toPublicEntry(entry);
  }

  /**
   * Takes up to dto.amount: all of it when the balance covers it, else what
   * the wallet holds. Resolves to the amount actually taken (0 on an empty
   * wallet). For bills already incurred, like a finished session.
   */
  async debitUpTo(gamerProfileId: string, dto: DebitDto): Promise<number> {
    const wallet = await this.getOrCreateWallet(gamerProfileId);
    const entry = await this.wallets.postCappedDebit({
      walletId: wallet.id,
      maxAmount: dto.amount,
      amount: -dto.amount,
      type: dto.type ?? 'DEBIT',
      sessionId: dto.sessionId,
      idempotencyKey: dto.idempotencyKey,
    });
    return entry ? -entry.amount : 0;
  }

  private async resolveOwnGamerProfileId(caller: AccessTokenPayload): Promise<string> {
    const gamerProfileId = await this.wallets.findGamerProfileIdByUserId(caller.sub);
    if (!gamerProfileId) {
      throw new NotFoundException({ code: 'GAMER_PROFILE_NOT_FOUND', error: 'caller has no gamer profile' });
    }
    return gamerProfileId;
  }
}
