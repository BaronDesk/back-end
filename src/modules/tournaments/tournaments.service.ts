import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '../../generated/prisma/index.js';
import type { AccessTokenPayload } from '../../common/types/jwt-payload.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { DashboardGateway } from '../ops/dashboard.gateway.js';
import { WalletService } from '../wallet/services/wallet.service.js';
import type { CreateTournamentDto } from './tournaments.schemas.js';

@Injectable()
export class TournamentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly dashboard: DashboardGateway,
  ) {}

  list() {
    return this.prisma.tournament.findMany({
      where: { status: { not: 'DRAFT' } },
      include: { game: true, _count: { select: { entrants: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async get(id: string) {
    const row = await this.prisma.tournament.findUnique({
      where: { id },
      include: {
        game: true,
        entrants: {
          include: {
            members: {
              include: {
                gamerProfile: {
                  select: { user: { select: { username: true } } },
                },
              },
            },
          },
        },
        matches: { orderBy: [{ round: 'asc' }, { position: 'asc' }] },
      },
    });
    if (!row)
      throw new NotFoundException({
        code: 'TOURNAMENT_NOT_FOUND',
        error: 'tournament not found',
      });
    return row;
  }

  async create(caller: AccessTokenPayload, dto: CreateTournamentDto) {
    if (caller.scope === 'admin' && caller.branchId !== dto.branchId)
      throw new ConflictException({
        code: 'BRANCH_SCOPE',
        error: 'tournament branch is outside your scope',
      });
    if (dto.registrationClosesAt <= new Date())
      throw new ConflictException({
        code: 'INVALID_DATES',
        error: 'registration deadline must be in the future',
      });
    const game = await this.prisma.game.findFirst({
      where: {
        id: dto.gameId,
        enabled: true,
        gameBranches: { some: { branchId: dto.branchId } },
      },
      select: { id: true },
    });
    if (!game)
      throw new NotFoundException({
        code: 'GAME_NOT_AVAILABLE',
        error: 'game is not available at this branch',
      });
    return this.prisma.tournament.create({
      data: {
        branchId: dto.branchId,
        gameId: dto.gameId,
        entryFeePerPlayer: dto.entryFeePerPlayer,
        teamSize: dto.teamSize,
        maxEntrants: dto.maxEntrants,
        registrationClosesAt: dto.registrationClosesAt,
        checkInOpensAt: dto.checkInOpensAt,
        checkInClosesAt: dto.checkInClosesAt,
        prizesJson: dto.prizes,
      },
    });
  }

  async publish(caller: AccessTokenPayload, id: string) {
    const existing = await this.prisma.tournament.findUnique({ where: { id } });
    if (!existing)
      throw new NotFoundException({
        code: 'TOURNAMENT_NOT_FOUND',
        error: 'tournament not found',
      });
    this.assertBranch(caller, existing.branchId);
    const updated = await this.prisma.tournament.updateMany({
      where: { id, status: 'DRAFT' },
      data: { status: 'REGISTRATION_OPEN', publishedAt: new Date() },
    });
    if (!updated.count)
      throw new ConflictException({
        code: 'INVALID_TOURNAMENT_STATE',
        error: 'only a draft tournament can be published',
      });
    const tournament = await this.get(id);
    this.emit(tournament.branchId, id);
    return tournament;
  }

  async createEntrant(
    caller: AccessTokenPayload,
    tournamentId: string,
    kind: 'SOLO' | 'TEAM',
    name: string,
  ) {
    const gamer = await this.prisma.gamerProfile.findUnique({
      where: { userId: caller.sub },
      select: { id: true },
    });
    if (!gamer)
      throw new NotFoundException({
        code: 'GAMER_PROFILE_NOT_FOUND',
        error: 'gamer profile not found',
      });
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
    });
    if (!tournament)
      throw new NotFoundException({
        code: 'TOURNAMENT_NOT_FOUND',
        error: 'tournament not found',
      });
    if (
      tournament.status !== 'REGISTRATION_OPEN' ||
      tournament.registrationClosesAt <= new Date()
    )
      throw new ConflictException({
        code: 'REGISTRATION_CLOSED',
        error: 'registration is closed',
      });
    if ((kind === 'SOLO') !== (tournament.teamSize === 1))
      throw new ConflictException({
        code: 'ENTRANT_KIND_MISMATCH',
        error: 'entrant type does not match the tournament team size',
      });
    const entrant = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`tournament:${tournamentId}`}))`;
      const count = await tx.tournamentEntrant.count({
        where: {
          tournamentId,
          status: { notIn: ['WITHDRAWN', 'DISQUALIFIED'] },
        },
      });
      if (count >= tournament.maxEntrants)
        throw new ConflictException({
          code: 'TOURNAMENT_FULL',
          error: 'tournament is full',
        });
      return tx.tournamentEntrant.create({
        data: {
          tournamentId,
          kind,
          name,
          status: 'FORMING',
          members: {
            create: {
              tournamentId,
              gamerProfileId: gamer.id,
              role: 'CAPTAIN',
              status: 'PAYMENT_PENDING',
              amountDue: tournament.entryFeePerPlayer,
            },
          },
        },
        include: { members: true },
      });
    });
    const member = entrant.members[0];
    if (kind === 'SOLO') await this.payMember(member.id, gamer.id);
    return this.get(tournamentId);
  }

  async invite(
    caller: AccessTokenPayload,
    entrantId: string,
    username: string,
  ) {
    const gamer = await this.prisma.gamerProfile.findFirst({
      where: { user: { username } },
      select: { id: true },
    });
    if (!gamer)
      throw new NotFoundException({
        code: 'GAMER_NOT_FOUND',
        error: 'gamer not found',
      });
    return this.prisma.$transaction(async (tx) => {
      const entrant = await tx.tournamentEntrant.findUnique({
        where: { id: entrantId },
        include: { tournament: true, members: true },
      });
      if (
        !entrant ||
        entrant.tournament.status !== 'REGISTRATION_OPEN' ||
        entrant.tournament.registrationClosesAt <= new Date()
      )
        throw new ConflictException({
          code: 'REGISTRATION_CLOSED',
          error: 'team cannot be changed now',
        });
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`entrant:${entrantId}`}))`;
      const currentMembers = await tx.tournamentMember.count({
        where: { entrantId },
      });
      const captain = await tx.tournamentMember.findFirst({
        where: {
          entrantId,
          role: 'CAPTAIN',
          gamerProfile: { userId: caller.sub },
        },
      });
      if (!captain)
        throw new ConflictException({
          code: 'CAPTAIN_REQUIRED',
          error: 'only the team captain may invite players',
        });
      if (currentMembers >= entrant.tournament.teamSize)
        throw new ConflictException({
          code: 'TEAM_FULL',
          error: 'team roster is full',
        });
      return tx.tournamentMember.create({
        data: {
          entrantId,
          tournamentId: entrant.tournamentId,
          gamerProfileId: gamer.id,
          role: 'MEMBER',
          status: 'INVITED',
          amountDue: entrant.tournament.entryFeePerPlayer,
        },
      });
    });
  }

  async acceptInvite(caller: AccessTokenPayload, memberId: string) {
    const result = await this.prisma.tournamentMember.updateMany({
      where: {
        id: memberId,
        gamerProfile: { userId: caller.sub },
        status: 'INVITED',
        tournament: {
          status: 'REGISTRATION_OPEN',
          registrationClosesAt: { gt: new Date() },
        },
      },
      data: { status: 'PAYMENT_PENDING' },
    });
    if (!result.count)
      throw new ConflictException({
        code: 'INVITE_UNAVAILABLE',
        error: 'invite is no longer available',
      });
    return this.pay(caller, memberId);
  }

  async pay(caller: AccessTokenPayload, memberId: string) {
    const gamer = await this.prisma.gamerProfile.findUnique({
      where: { userId: caller.sub },
      select: { id: true },
    });
    if (!gamer)
      throw new NotFoundException({
        code: 'GAMER_PROFILE_NOT_FOUND',
        error: 'gamer profile not found',
      });
    return this.payMember(memberId, gamer.id);
  }

  private async payMember(memberId: string, gamerProfileId: string) {
    const member = await this.prisma.tournamentMember.findFirst({
      where: { id: memberId, gamerProfileId },
      include: { tournament: true },
    });
    if (!member)
      throw new NotFoundException({
        code: 'TOURNAMENT_MEMBER_NOT_FOUND',
        error: 'roster member not found',
      });
    if (member.status === 'PAID') return member;
    if (
      member.status !== 'PAYMENT_PENDING' ||
      member.tournament.status !== 'REGISTRATION_OPEN' ||
      member.tournament.registrationClosesAt <= new Date()
    )
      throw new ConflictException({
        code: 'PAYMENT_UNAVAILABLE',
        error: 'member is not awaiting payment',
      });
    const ledger =
      member.amountDue > 0
        ? await this.wallet.debit(gamerProfileId, {
            amount: member.amountDue,
            type: 'PAYMENT',
            idempotencyKey: `tournament-entry:${member.id}`,
          })
        : null;
    const paid = await this.prisma.tournamentMember.updateMany({
      where: { id: member.id, status: 'PAYMENT_PENDING' },
      data: {
        status: 'PAID',
        amountPaid: member.amountDue,
        paidAt: new Date(),
        ledgerEntryId: ledger?.id,
      },
    });
    if (member.role === 'CAPTAIN' && member.tournament.teamSize === 1)
      await this.prisma.tournamentEntrant.updateMany({
        where: { id: member.entrantId, status: 'FORMING' },
        data: { status: 'CONFIRMED' },
      });
    if (member.role === 'MEMBER') {
      const roster = await this.prisma.tournamentMember.findMany({
        where: { entrantId: member.entrantId },
      });
      if (
        roster.length === member.tournament.teamSize &&
        roster.every((m) => m.status === 'PAID' || m.id === member.id)
      ) {
        await this.prisma.tournamentEntrant.updateMany({
          where: { id: member.entrantId, status: 'FORMING' },
          data: { status: 'CONFIRMED' },
        });
      }
    }
    if (!paid.count)
      return this.prisma.tournamentMember.findUniqueOrThrow({
        where: { id: member.id },
      });
    this.emit(member.tournament.branchId, member.tournamentId);
    return this.prisma.tournamentMember.findUniqueOrThrow({
      where: { id: member.id },
    });
  }

  async closeRegistration(caller: AccessTokenPayload, id: string) {
    const existing = await this.prisma.tournament.findUnique({ where: { id } });
    if (!existing)
      throw new NotFoundException({
        code: 'TOURNAMENT_NOT_FOUND',
        error: 'tournament not found',
      });
    this.assertBranch(caller, existing.branchId);
    const row = await this.prisma.tournament.updateMany({
      where: { id, status: 'REGISTRATION_OPEN' },
      data: { status: 'REGISTRATION_CLOSED' },
    });
    if (!row.count)
      throw new ConflictException({
        code: 'INVALID_TOURNAMENT_STATE',
        error: 'registration is not open',
      });
    const tournament = await this.prisma.tournament.findUniqueOrThrow({
      where: { id },
    });
    this.emit(tournament.branchId, id);
    return tournament;
  }

  async checkIn(
    caller: AccessTokenPayload,
    tournamentId: string,
    entrantId: string,
  ) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id: tournamentId },
    });
    if (
      !tournament ||
      tournament.status !== 'REGISTRATION_CLOSED' ||
      new Date() < tournament.checkInOpensAt ||
      new Date() > tournament.checkInClosesAt
    )
      throw new ConflictException({
        code: 'CHECK_IN_CLOSED',
        error: 'check-in is not open',
      });
    this.assertBranch(caller, tournament.branchId);
    const updated = await this.prisma.tournamentEntrant.updateMany({
      where: {
        id: entrantId,
        tournamentId,
        status: 'CONFIRMED',
        members: { every: { status: 'PAID' } },
      },
      data: { status: 'CHECKED_IN', checkedInAt: new Date() },
    });
    if (!updated.count)
      throw new ConflictException({
        code: 'ENTRANT_NOT_ELIGIBLE',
        error: 'entrant must have a fully paid roster to check in',
      });
    this.emit(tournament.branchId, tournamentId);
    return this.get(tournamentId);
  }

  async start(caller: AccessTokenPayload, id: string) {
    return this.prisma
      .$transaction(async (tx) => {
        const tournament = await tx.tournament.findUnique({ where: { id } });
        if (!tournament || tournament.status !== 'REGISTRATION_CLOSED')
          throw new ConflictException({
            code: 'INVALID_TOURNAMENT_STATE',
            error:
              'tournament must be closed for registration before it starts',
          });
        if (new Date() < tournament.checkInClosesAt)
          throw new ConflictException({
            code: 'CHECK_IN_STILL_OPEN',
            error: 'check-in must close before the bracket starts',
          });
        this.assertBranch(caller, tournament.branchId);
        const entrants = await tx.tournamentEntrant.findMany({
          where: { tournamentId: id, status: 'CHECKED_IN' },
          orderBy: { checkedInAt: 'asc' },
        });
        if (entrants.length < 2)
          throw new ConflictException({
            code: 'NOT_ENOUGH_ENTRANTS',
            error: 'at least two checked-in entrants are required',
          });
        const size = 2 ** Math.ceil(Math.log2(entrants.length));
        const rounds = Math.log2(size);
        const ids: string[][] = [];
        for (let round = 1; round <= rounds; round++) {
          const slots = size / 2 ** round;
          ids[round] = [];
          for (let position = 0; position < slots; position++) {
            const match = await tx.tournamentMatch.create({
              data: {
                tournamentId: id,
                round,
                position,
                status: 'PENDING',
              },
            });
            ids[round][position] = match.id;
          }
        }
        const slots: ((typeof entrants)[number] | undefined)[] = new Array(
          size,
        );
        this.seedPositions(size).forEach((slot, seed) => {
          slots[slot] = entrants[seed];
        });
        const matches = await tx.tournamentMatch.findMany({
          where: { tournamentId: id, round: 1 },
          orderBy: { position: 'asc' },
        });
        for (const match of matches) {
          const a = slots[match.position * 2];
          const b = slots[match.position * 2 + 1];
          const winner = a && !b ? a : undefined;
          await tx.tournamentMatch.update({
            where: { id: match.id },
            data: {
              entrant1Id: a?.id,
              entrant2Id: b?.id,
              ...(a && b ? { status: 'READY' } : {}),
              ...(winner
                ? { winnerEntrantId: winner.id, status: 'COMPLETED' }
                : {}),
            },
          });
          if (winner) {
            await tx.tournamentEntrant.update({
              where: { id: winner.id },
              data: { seed: match.position + 1 },
            });
            await this.advanceTx(
              tx,
              id,
              match.position,
              winner.id,
              ids,
              rounds,
            );
          }
        }
        await tx.tournament.update({
          where: { id },
          data: { status: 'IN_PROGRESS' },
        });
        return { tournamentId: id, rounds, entrants: entrants.length };
      })
      .then(async (result) => {
        const tournament = await this.prisma.tournament.findUniqueOrThrow({
          where: { id },
        });
        this.emit(tournament.branchId, id);
        return result;
      });
  }

  private seedPositions(size: number): number[] {
    let positions = [0, 1];
    for (let n = 4; n <= size; n *= 2)
      positions = positions.flatMap((p) => [p, n - 1 - p]);
    return positions;
  }

  private async advanceTx(
    tx: Prisma.TransactionClient,
    tournamentId: string,
    roundOnePosition: number,
    winnerId: string,
    ids: string[][],
    rounds: number,
  ) {
    let position = roundOnePosition;
    for (let round = 2; round <= rounds; round++) {
      const nextPosition = Math.floor(position / 2);
      const matchId = ids[round][nextPosition];
      const slot = position % 2 === 0 ? 'entrant1Id' : 'entrant2Id';
      const match = await tx.tournamentMatch.update({
        where: { id: matchId },
        data: { [slot]: winnerId },
      });
      if (match.entrant1Id && match.entrant2Id)
        await tx.tournamentMatch.update({
          where: { id: matchId },
          data: { status: 'READY' },
        });
      else return;
      position = nextPosition;
    }
  }

  async reportResult(
    caller: AccessTokenPayload,
    matchId: string,
    body: { version: number; winnerEntrantId: string; scores: number[] },
  ) {
    const result = await this.prisma.$transaction(async (tx) => {
      const match = await tx.tournamentMatch.findUnique({
        where: { id: matchId },
        include: { tournament: true },
      });
      if (!match || match.tournament.status !== 'IN_PROGRESS')
        throw new NotFoundException({
          code: 'MATCH_NOT_FOUND',
          error: 'active tournament match not found',
        });
      this.assertBranch(caller, match.tournament.branchId);
      if (
        match.version !== body.version ||
        match.status !== 'READY' ||
        ![match.entrant1Id, match.entrant2Id].includes(body.winnerEntrantId)
      )
        throw new ConflictException({
          code: 'STALE_MATCH',
          error: 'match changed or winner is not a participant',
        });
      const updated = await tx.tournamentMatch.updateMany({
        where: { id: matchId, version: body.version, status: 'READY' },
        data: {
          status: 'COMPLETED',
          winnerEntrantId: body.winnerEntrantId,
          scoresJson: body.scores,
          version: { increment: 1 },
        },
      });
      if (!updated.count)
        throw new ConflictException({
          code: 'STALE_MATCH',
          error: 'match result was already submitted',
        });
      const loserId =
        body.winnerEntrantId === match.entrant1Id
          ? match.entrant2Id!
          : match.entrant1Id!;
      await tx.tournamentEntrant.updateMany({
        where: { id: loserId, tournamentId: match.tournamentId },
        data: { status: 'ELIMINATED' },
      });
      if (
        match.round ===
        (
          await tx.tournamentMatch.aggregate({
            where: { tournamentId: match.tournamentId },
            _max: { round: true },
          })
        )._max.round
      ) {
        await tx.tournamentEntrant.update({
          where: { id: body.winnerEntrantId },
          data: { status: 'WINNER' },
        });
        await tx.tournament.update({
          where: { id: match.tournamentId },
          data: { status: 'COMPLETED' },
        });
      } else {
        await tx.tournamentEntrant.updateMany({
          where: { id: body.winnerEntrantId, status: 'CHECKED_IN' },
          data: { status: 'CHECKED_IN' },
        });
        const next = await tx.tournamentMatch.findFirst({
          where: {
            tournamentId: match.tournamentId,
            round: match.round + 1,
            position: Math.floor(match.position / 2),
          },
        });
        if (next) {
          const slot = match.position % 2 === 0 ? 'entrant1Id' : 'entrant2Id';
          const placed = await tx.tournamentMatch.updateMany({
            where: { id: next.id, [slot]: null },
            data: { [slot]: body.winnerEntrantId },
          });
          if (placed.count) {
            const row = await tx.tournamentMatch.findUniqueOrThrow({
              where: { id: next.id },
            });
            if (row.entrant1Id && row.entrant2Id)
              await tx.tournamentMatch.update({
                where: { id: row.id },
                data: { status: 'READY' },
              });
          }
        }
      }
      return {
        tournamentId: match.tournamentId,
        branchId: match.tournament.branchId,
      };
    });
    this.emit(result.branchId, result.tournamentId);
    return this.get(result.tournamentId);
  }

  private emit(branchId: string, tournamentId: string) {
    this.dashboard.publishToBranch(branchId, 'tournament_update', {
      tournamentId,
    });
  }

  private assertBranch(caller: AccessTokenPayload, branchId: string) {
    if (caller.scope !== 'hq' && caller.branchId !== branchId)
      throw new ConflictException({
        code: 'BRANCH_SCOPE',
        error: 'tournament is outside your branch scope',
      });
  }
}
