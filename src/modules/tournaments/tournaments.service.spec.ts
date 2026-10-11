import { ConflictException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccessTokenPayload } from '../../common/types/jwt-payload.js';
import { TournamentsService } from './tournaments.service.js';

const caller: AccessTokenPayload = {
  sub: 'user-1',
  role: 'GAMER',
  scope: 'self',
  branchId: null,
  jti: 'token-1',
};
const staff: AccessTokenPayload = {
  sub: 'staff-1',
  role: 'EMPLOYEE',
  scope: 'staff',
  branchId: 'branch-1',
  jti: 'token-2',
};

describe('TournamentsService', () => {
  let prisma: Record<string, any>;
  let wallet: { debit: ReturnType<typeof vi.fn> };
  let dashboard: { publishToBranch: ReturnType<typeof vi.fn> };
  let service: TournamentsService;

  beforeEach(() => {
    prisma = {
      gamerProfile: {
        findUnique: vi.fn().mockResolvedValue({ id: 'gamer-1' }),
      },
      tournamentMember: {
        findFirst: vi.fn(),
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
        findMany: vi.fn(),
        findUniqueOrThrow: vi
          .fn()
          .mockResolvedValue({ id: 'member-1', status: 'PAID' }),
      },
      tournamentEntrant: {
        updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      },
      tournament: { findUnique: vi.fn(), findUniqueOrThrow: vi.fn() },
      tournamentMatch: {},
      $transaction: vi.fn((callback: (tx: any) => unknown) => callback(prisma)),
      $executeRaw: vi.fn(),
    };
    wallet = { debit: vi.fn().mockResolvedValue({ id: 'ledger-1' }) };
    dashboard = { publishToBranch: vi.fn() };
    service = new TournamentsService(
      prisma as any,
      wallet as any,
      dashboard as any,
    );
  });

  it('charges a member once with the member-scoped idempotency key and confirms a solo entrant', async () => {
    prisma.tournamentMember.findFirst.mockResolvedValue({
      id: 'member-1',
      entrantId: 'entrant-1',
      tournamentId: 'tournament-1',
      gamerProfileId: 'gamer-1',
      role: 'CAPTAIN',
      status: 'PAYMENT_PENDING',
      amountDue: 500,
      tournament: {
        id: 'tournament-1',
        teamSize: 1,
        status: 'REGISTRATION_OPEN',
        registrationClosesAt: new Date(Date.now() + 60_000),
        branchId: 'branch-1',
      },
    });

    await service.pay(caller, 'member-1');

    expect(wallet.debit).toHaveBeenCalledWith('gamer-1', {
      amount: 500,
      type: 'PAYMENT',
      idempotencyKey: 'tournament-entry:member-1',
    });
    expect(prisma.tournamentMember.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'PAID',
          amountPaid: 500,
          ledgerEntryId: 'ledger-1',
        }),
      }),
    );
    expect(prisma.tournamentEntrant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'entrant-1', status: 'FORMING' },
        data: { status: 'CONFIRMED' },
      }),
    );
  });

  it('confirms a team only after every roster member has paid', async () => {
    const member = {
      id: 'member-2',
      entrantId: 'entrant-1',
      tournamentId: 'tournament-1',
      gamerProfileId: 'gamer-1',
      role: 'MEMBER',
      status: 'PAYMENT_PENDING',
      amountDue: 500,
      tournament: {
        id: 'tournament-1',
        teamSize: 2,
        status: 'REGISTRATION_OPEN',
        registrationClosesAt: new Date(Date.now() + 60_000),
        branchId: 'branch-1',
      },
    };
    prisma.tournamentMember.findFirst.mockResolvedValue(member);
    prisma.tournamentMember.findMany.mockResolvedValue([
      { id: 'member-1', status: 'PAID' },
      { id: 'member-2', status: 'PAYMENT_PENDING' },
    ]);
    await service.pay(caller, 'member-2');
    expect(prisma.tournamentEntrant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'entrant-1', status: 'FORMING' },
        data: { status: 'CONFIRMED' },
      }),
    );

    prisma.tournamentEntrant.updateMany.mockClear();
    prisma.tournamentMember.findMany.mockResolvedValue([
      { id: 'member-1', status: 'PAYMENT_PENDING' },
      { id: 'member-2', status: 'PAYMENT_PENDING' },
    ]);
    await service.pay(caller, 'member-2');
    expect(prisma.tournamentEntrant.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a check-in for an entrant without a fully paid roster', async () => {
    prisma.tournament.findUnique.mockResolvedValue({
      id: 'tournament-1',
      branchId: 'branch-1',
      status: 'REGISTRATION_CLOSED',
      checkInOpensAt: new Date(Date.now() - 60_000),
      checkInClosesAt: new Date(Date.now() + 60_000),
    });
    prisma.tournamentEntrant.updateMany.mockResolvedValue({ count: 0 });
    await expect(
      service.checkIn(staff, 'tournament-1', 'entrant-1'),
    ).rejects.toMatchObject({
      response: { code: 'ENTRANT_NOT_ELIGIBLE' },
    });
  });

  it('rejects a stale or duplicate result before changing the bracket', async () => {
    prisma.tournamentMatch.findUnique = vi.fn().mockResolvedValue({
      id: 'match-1',
      version: 2,
      status: 'COMPLETED',
      entrant1Id: 'entrant-1',
      entrant2Id: 'entrant-2',
      tournament: {
        id: 'tournament-1',
        branchId: 'branch-1',
        status: 'IN_PROGRESS',
      },
    });

    await expect(
      service.reportResult(staff, 'match-1', {
        version: 1,
        winnerEntrantId: 'entrant-1',
        scores: [2, 1],
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(prisma.tournamentMatch.updateMany).toBeUndefined();
  });
});
