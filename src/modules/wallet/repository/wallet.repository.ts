import { Injectable } from '@nestjs/common';

import { BaseRepository } from '../../../common/repository/base.repository.js';
import { PrismaService } from '../../../infra/prisma/prisma.service.js';
import { Prisma, type TransactionType } from '../../../generated/prisma/index.js';

export interface PostEntryInput {
  walletId: string;
  amount: number;
  type: TransactionType;
  sessionId?: string;
  idempotencyKey?: string;
}

@Injectable()
export class WalletRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  findByGamerProfileId(gamerProfileId: string) {
    return this.prisma.wallet.findUnique({ where: { gamerProfileId } });
  }

  createForGamerProfile(gamerProfileId: string) {
    return this.prisma.wallet.create({ data: { gamerProfileId } });
  }

  findGamerProfileIdByUserId(userId: string) {
    return this.prisma.gamerProfile
      .findUnique({ where: { userId }, select: { id: true } })
      .then((p) => p?.id ?? null);
  }

  listEntries(walletId: string, take: number, cursor?: string) {
    return this.prisma.ledgerEntry.findMany({
      where: { walletId },
      orderBy: { createdAt: 'desc' },
      take,
      ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
    });
  }


  /*
   * posts one ledger entry and moves wallet's cached balanced by same amount
   * atomically with guard against racing (read-then-write window)
   *
   * returns null whe nwallet doen't exit or debit'd overdraw it
   * returns original entry untouched on repeated idempotencyKey
   */
  /*
   * debits as much of `maxAmount` as the balance holds, atomically, as one
   * entry. returns null when there was nothing to take (or no wallet); the
   * original entry on a repeated idempotencyKey.
   */
  async postCappedDebit(input: PostEntryInput & { maxAmount: number }) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        // Row lock first: the balance read and the update can't be split by another post.
        const [locked] = await tx.$queryRaw<{ balance: number }[]>`
          SELECT balance FROM wallets WHERE id = ${input.walletId}::uuid FOR UPDATE
        `;
        const taken = Math.min(locked?.balance ?? 0, input.maxAmount);
        if (taken <= 0) return null;

        const [row] = await tx.$queryRaw<{ balance: number }[]>`
          UPDATE wallets
          SET balance = balance - ${taken}::integer, updated_at = now()
          WHERE id = ${input.walletId}::uuid
          RETURNING balance
        `;

        return tx.ledgerEntry.create({
          data: {
            walletId: input.walletId,
            amount: -taken,
            balanceAfter: row.balance,
            type: input.type,
            sessionId: input.sessionId,
            idempotencyKey: input.idempotencyKey,
          },
        });
      });
    } catch (err) {
      if (input.idempotencyKey && err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
        return this.prisma.ledgerEntry.findUnique({
          where: { walletId_idempotencyKey: { walletId: input.walletId, idempotencyKey: input.idempotencyKey } },
        });
      }
      throw err;
    }
  }

  async postEntry(input: PostEntryInput) {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const [row] = await tx.$queryRaw<{ balance: number }[]>`
          UPDATE wallets
          SET balance = balance + ${input.amount}::integer, updated_at = now()
          WHERE id = ${input.walletId}::uuid
            AND balance + ${input.amount}::integer >= 0
          RETURNING balance
        `;
        if (!row) return null;

        return tx.ledgerEntry.create({
          data: {
            walletId: input.walletId,
            amount: input.amount,
            balanceAfter: row.balance,
            type: input.type,
            sessionId: input.sessionId,
            idempotencyKey: input.idempotencyKey,
          },
        });
      });
    } catch (err) {
      if (
        input.idempotencyKey &&
        err instanceof Prisma.PrismaClientKnownRequestError &&
        err.code === 'P2002'
      ) {
        return this.prisma.ledgerEntry.findUnique({
          where: { walletId_idempotencyKey: { walletId: input.walletId, idempotencyKey: input.idempotencyKey } },
        });
      }
      throw err;
    }
  }
}
