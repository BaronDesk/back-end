import { ConflictException, NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { WalletService } from './wallet.service.js';

function caller(overrides: Partial<AccessTokenPayload> = {}): AccessTokenPayload {
  return { sub: 'user-1', role: 'GAMER', scope: 'self', branchId: null, jti: 'jti-1', ...overrides };
}

describe('WalletService', () => {
  let repo: {
    findByGamerProfileId: ReturnType<typeof vi.fn>;
    createForGamerProfile: ReturnType<typeof vi.fn>;
    findGamerProfileIdByUserId: ReturnType<typeof vi.fn>;
    listEntries: ReturnType<typeof vi.fn>;
    postEntry: ReturnType<typeof vi.fn>;
  };
  let service: WalletService;

  const wallet = { id: 'wallet-1', gamerProfileId: 'gamer-1', balance: 5000, updatedAt: new Date() };

  beforeEach(() => {
    repo = {
      findByGamerProfileId: vi.fn().mockResolvedValue(wallet),
      createForGamerProfile: vi.fn(),
      findGamerProfileIdByUserId: vi.fn().mockResolvedValue('gamer-1'),
      listEntries: vi.fn().mockResolvedValue([]),
      postEntry: vi.fn(),
    };
    service = new WalletService(repo as any);
  });

  it('creates a wallet lazily when the gamer has none yet', async () => {
    repo.findByGamerProfileId.mockResolvedValueOnce(null);
    repo.createForGamerProfile.mockResolvedValueOnce(wallet);

    const result = await service.getWalletForGamer('gamer-1');

    expect(repo.createForGamerProfile).toHaveBeenCalledWith('gamer-1');
    expect(result.balance).toBe(5000);
  });

  it('credits a wallet with a positive signed amount', async () => {
    repo.postEntry.mockResolvedValueOnce({
      id: 'e1', walletId: 'wallet-1', amount: 1000, balanceAfter: 6000,
      type: 'CREDIT', sessionId: null, createdAt: new Date(),
    });

    const result = await service.credit('gamer-1', { amount: 1000 });

    expect(repo.postEntry).toHaveBeenCalledWith(expect.objectContaining({ amount: 1000, type: 'CREDIT' }));
    expect(result.amount).toBe(1000);
    expect(result.balanceAfter).toBe(6000);
  });

  it('debits a wallet with a negative signed amount', async () => {
    repo.postEntry.mockResolvedValueOnce({
      id: 'e2', walletId: 'wallet-1', amount: -1000, balanceAfter: 4000,
      type: 'DEBIT', sessionId: null, createdAt: new Date(),
    });

    await service.debit('gamer-1', { amount: 1000 });

    expect(repo.postEntry).toHaveBeenCalledWith(expect.objectContaining({ amount: -1000, type: 'DEBIT' }));
  });

  it('rejects a debit that would overdraw the wallet', async () => {
    repo.postEntry.mockResolvedValueOnce(null);
    // not a millionaire, mate
    await expect(service.debit('gamer-1', { amount: 1000000 })).rejects.toThrow(ConflictException);
  });

  it('resolves "me" routes through the caller\'s own gamer profile', async () => {
    await service.getMyWallet(caller());
    expect(repo.findGamerProfileIdByUserId).toHaveBeenCalledWith('user-1');
  });

  it('rejects "me" routes for a caller with no gamer profile', async () => {
    repo.findGamerProfileIdByUserId.mockResolvedValueOnce(null);
    await expect(service.getMyWallet(caller())).rejects.toThrow(NotFoundException);
  });
});
