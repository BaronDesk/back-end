import {
  ConflictException,
  Injectable,
  NotFoundException,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import type { Queue } from 'bullmq';
import type { Subscription } from 'rxjs';
import { AgentGateway } from '../ops/agent.gateway.js';
import { SessionsService } from '../session-billing/services/sessions.service.js';
import { PresenceService } from '../station/services/presence.service.js';
import { Prisma } from '../../generated/prisma/index.js';
import type { AccessTokenPayload } from '../../common/types/jwt-payload.js';
import { PrismaService } from '../../infra/prisma/prisma.service.js';
import { DashboardGateway } from '../ops/dashboard.gateway.js';
import { WalletService } from '../wallet/services/wallet.service.js';
import type { CreateTournamentDto } from './tournaments.schemas.js';
import {
  TOURNAMENT_JOBS,
  TOURNAMENT_QUEUE,
  type TournamentJobData,
} from './tournament-timers.schemas.js';

@Injectable()
export class TournamentsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(TournamentsService.name);
  private readonly subscriptions: Subscription[] = [];
  private readonly retryTimers = new Set<NodeJS.Timeout>();
  private readonly matchDurationMs = 120 * 60_000;
  constructor(
    private readonly prisma: PrismaService,
    private readonly wallet: WalletService,
    private readonly dashboard: DashboardGateway,
    private readonly agents: AgentGateway,
    private readonly sessions: SessionsService,
    private readonly presence: PresenceService,
    @InjectQueue(TOURNAMENT_QUEUE)
    private readonly queue: Queue<TournamentJobData>,
  ) {}

  onModuleInit() {
    this.subscriptions.push(
      this.presence.sessionEnded.subscribe((event) =>
        this.retrySeatAssignment(event.branchId),
      ),
      this.presence.statusChanges.subscribe((event) => {
        if (event.status === 'ONLINE')
          void this.seatReadyMatchesForBranch(event.branchId);
      }),
    );
  }

  onModuleDestroy() {
    this.subscriptions.forEach((subscription) => subscription.unsubscribe());
    for (const timer of this.retryTimers) clearTimeout(timer);
  }

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
    await this.scheduleLifecycle(tournament);
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
    const closedTournament = await this.prisma.tournament.findUniqueOrThrow({
      where: { id },
    });
    this.emit(closedTournament.branchId, id);
    await this.expireFormingEntrants(id);
    return closedTournament;
  }

  private async scheduleLifecycle(
    tournament: Awaited<ReturnType<TournamentsService['get']>>,
  ) {
    const tasks = [
      [TOURNAMENT_JOBS.CLOSE_REGISTRATION, tournament.registrationClosesAt],
      [TOURNAMENT_JOBS.OPEN_CHECK_IN, tournament.checkInOpensAt],
      [TOURNAMENT_JOBS.CLOSE_CHECK_IN, tournament.checkInClosesAt],
    ] as const;
    for (const [name, when] of tasks) {
      await this.scheduleJob(name, tournament.id, when);
    }
  }

  private scheduleJob(
    name: string,
    tournamentId: string,
    when: Date,
    retry = false,
  ) {
    return this.queue.add(
      name,
      { tournamentId },
      {
        jobId: `${name}-${tournamentId}-${retry ? `retry-${Date.now()}` : when.getTime()}`,
        delay: Math.max(when.getTime() - Date.now(), 0) + (retry ? 1_000 : 0),
        attempts: 8,
        backoff: { type: 'exponential', delay: 1_000 },
        removeOnComplete: true,
        removeOnFail: false,
      },
    );
  }

  async onRegistrationDeadline(id: string): Promise<void> {
    const now = new Date();
    const tournament = await this.prisma.tournament.findUnique({
      where: { id },
    });
    if (
      tournament?.status === 'REGISTRATION_OPEN' &&
      tournament.registrationClosesAt > now
    ) {
      await this.scheduleJob(
        TOURNAMENT_JOBS.CLOSE_REGISTRATION,
        id,
        tournament.registrationClosesAt,
        true,
      );
      return;
    }
    if (
      !tournament ||
      !['REGISTRATION_OPEN', 'REGISTRATION_CLOSED'].includes(tournament.status)
    )
      return;
    if (tournament.status === 'REGISTRATION_OPEN') {
      const changed = await this.prisma.tournament.updateMany({
        where: {
          id,
          status: 'REGISTRATION_OPEN',
          registrationClosesAt: { lte: now },
        },
        data: { status: 'REGISTRATION_CLOSED' },
      });
      if (!changed.count) return;
    }
    await this.expireFormingEntrants(id);
    const closedTournament = await this.prisma.tournament.findUniqueOrThrow({
      where: { id },
    });
    this.emit(closedTournament.branchId, id);
  }

  async onCheckInOpen(id: string): Promise<void> {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id },
    });
    if (
      tournament?.status === 'REGISTRATION_CLOSED' &&
      tournament.checkInOpensAt > new Date()
    ) {
      await this.scheduleJob(
        TOURNAMENT_JOBS.OPEN_CHECK_IN,
        id,
        tournament.checkInOpensAt,
        true,
      );
      return;
    }
    if (tournament?.status === 'REGISTRATION_CLOSED')
      this.emit(tournament.branchId, id);
  }

  async onCheckInDeadline(id: string): Promise<void> {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id },
    });
    if (!tournament || tournament.status !== 'REGISTRATION_CLOSED') return;
    if (tournament.checkInClosesAt > new Date()) {
      await this.scheduleJob(
        TOURNAMENT_JOBS.CLOSE_CHECK_IN,
        id,
        tournament.checkInClosesAt,
        true,
      );
      return;
    }
    await this.prisma.tournamentEntrant.updateMany({
      where: { tournamentId: id, status: 'CONFIRMED' },
      data: { status: 'WITHDRAWN' },
    });
    await this.refundPaidMembers(id, { entrant: { status: 'WITHDRAWN' } });
    this.emit(tournament.branchId, id);
  }

  private async expireFormingEntrants(tournamentId: string): Promise<void> {
    await this.prisma.tournamentEntrant.updateMany({
      where: { tournamentId, status: 'FORMING' },
      data: { status: 'WITHDRAWN' },
    });
    await this.refundPaidMembers(tournamentId, {
      entrant: { status: 'WITHDRAWN' },
    });
  }

  private async refundPaidMembers(
    tournamentId: string,
    extraWhere: Record<string, unknown> = {},
  ): Promise<void> {
    const members = await this.prisma.tournamentMember.findMany({
      where: { tournamentId, status: 'PAID', ...extraWhere },
    });
    for (const member of members) {
      const ledger =
        member.amountPaid > 0
          ? await this.wallet.credit(member.gamerProfileId, {
              amount: member.amountPaid,
              type: 'REFUND',
              idempotencyKey: `tournament-refund:${member.id}`,
            })
          : null;
      await this.prisma.tournamentMember.updateMany({
        where: { id: member.id, status: 'PAID' },
        data: { status: 'REFUNDED', refundLedgerEntryId: ledger?.id },
      });
    }
  }

  async cancel(caller: AccessTokenPayload, id: string) {
    const tournament = await this.prisma.tournament.findUnique({
      where: { id },
    });
    if (!tournament)
      throw new NotFoundException({
        code: 'TOURNAMENT_NOT_FOUND',
        error: 'tournament not found',
      });
    this.assertBranch(caller, tournament.branchId);
    if (tournament.status === 'COMPLETED')
      throw new ConflictException({
        code: 'TOURNAMENT_COMPLETED',
        error: 'completed tournaments cannot be cancelled',
      });
    if (tournament.status !== 'CANCELLED') {
      await this.prisma.tournament.updateMany({
        where: { id, status: tournament.status },
        data: { status: 'CANCELLED' },
      });
    }
    await this.prisma.tournamentEntrant.updateMany({
      where: {
        tournamentId: id,
        status: {
          notIn: ['ELIMINATED', 'WINNER', 'WITHDRAWN', 'DISQUALIFIED'],
        },
      },
      data: { status: 'WITHDRAWN' },
    });
    const matches = await this.prisma.tournamentMatch.findMany({
      where: { tournamentId: id },
      select: { id: true },
    });
    for (const match of matches)
      await this.sessions.endTournamentMatch(match.id);
    await this.refundPaidMembers(id);
    this.emit(tournament.branchId, id);
    return this.get(id);
  }

  async withdraw(caller: AccessTokenPayload, entrantId: string) {
    const entrant = await this.prisma.tournamentEntrant.findUnique({
      where: { id: entrantId },
      include: { tournament: true },
    });
    if (!entrant)
      throw new NotFoundException({
        code: 'ENTRANT_NOT_FOUND',
        error: 'entrant not found',
      });
    const captain = await this.prisma.tournamentMember.findFirst({
      where: {
        entrantId,
        role: 'CAPTAIN',
        gamerProfile: { userId: caller.sub },
      },
    });
    if (!captain)
      throw new ConflictException({
        code: 'CAPTAIN_REQUIRED',
        error: 'only the entrant captain may withdraw it',
      });
    if (
      !['REGISTRATION_OPEN', 'REGISTRATION_CLOSED'].includes(
        entrant.tournament.status,
      )
    )
      throw new ConflictException({
        code: 'WITHDRAWAL_CLOSED',
        error: 'entrants cannot withdraw after bracket play starts',
      });
    await this.prisma.tournamentEntrant.updateMany({
      where: {
        id: entrantId,
        status: { in: ['FORMING', 'CONFIRMED', 'CHECKED_IN'] },
      },
      data: { status: 'WITHDRAWN' },
    });
    await this.refundPaidMembers(entrant.tournamentId, { entrantId });
    this.emit(entrant.tournament.branchId, entrant.tournamentId);
    return this.get(entrant.tournamentId);
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
          const winner = a && !b ? a : !a && b ? b : undefined;
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
        await this.seatReadyMatches(id);
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
        !['READY', 'IN_PROGRESS'].includes(match.status) ||
        ![match.entrant1Id, match.entrant2Id].includes(body.winnerEntrantId)
      )
        throw new ConflictException({
          code: 'STALE_MATCH',
          error: 'match changed or winner is not a participant',
        });
      const updated = await tx.tournamentMatch.updateMany({
        where: {
          id: matchId,
          version: body.version,
          status: { in: ['READY', 'IN_PROGRESS'] },
        },
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
    await this.sessions.endTournamentMatch(matchId);
    await this.seatReadyMatches(result.tournamentId);
    return this.get(result.tournamentId);
  }

  private async seatReadyMatches(tournamentId: string): Promise<void> {
    const matches = await this.prisma.tournamentMatch.findMany({
      where: { tournamentId, status: 'READY', reservations: { none: {} } },
      select: { id: true },
      orderBy: [{ round: 'asc' }, { position: 'asc' }],
    });
    for (const match of matches) {
      try {
        await this.seatMatch(match.id);
      } catch (error) {
        this.logger.error(
          `could not assign tournament match ${match.id}: ${(error as Error).message}`,
        );
      }
    }
  }

  private async seatReadyMatchesForBranch(branchId: string): Promise<void> {
    const tournaments = await this.prisma.tournament.findMany({
      where: { branchId, status: 'IN_PROGRESS' },
      select: { id: true },
    });
    for (const tournament of tournaments)
      await this.seatReadyMatches(tournament.id);
  }

  private retrySeatAssignment(branchId: string) {
    const timer = setTimeout(() => {
      this.retryTimers.delete(timer);
      void this.seatReadyMatchesForBranch(branchId);
    }, 1_000);
    this.retryTimers.add(timer);
  }

  /** Assigns every roster member a game-ready station in one locked reservation transaction. */
  private async seatMatch(matchId: string): Promise<void> {
    const match = await this.prisma.tournamentMatch.findUnique({
      where: { id: matchId },
      include: {
        tournament: { include: { game: true } },
        entrant1: {
          include: {
            members: {
              where: { status: 'PAID' },
              orderBy: { createdAt: 'asc' },
              include: {
                gamerProfile: { include: { user: { select: { id: true } } } },
              },
            },
          },
        },
        entrant2: {
          include: {
            members: {
              where: { status: 'PAID' },
              orderBy: { createdAt: 'asc' },
              include: {
                gamerProfile: { include: { user: { select: { id: true } } } },
              },
            },
          },
        },
      },
    });
    if (
      !match ||
      match.status !== 'READY' ||
      !match.entrant1 ||
      !match.entrant2
    )
      return;
    const members = [...match.entrant1.members, ...match.entrant2.members];
    if (members.length !== match.tournament.teamSize * 2) {
      this.logger.warn(
        `match ${match.id} has incomplete paid rosters; stations not assigned`,
      );
      return;
    }
    const candidates = await this.prisma.machine.findMany({
      where: {
        branchId: match.tournament.branchId,
        status: 'ONLINE',
        enrollmentStatus: 'ENROLLED',
        machineGames: {
          some: { gameId: match.tournament.gameId, excluded: false },
        },
        gameStatuses: {
          some: { gameId: match.tournament.game.gameId, installed: true },
        },
      },
      select: { id: true, name: true, serialNumber: true },
      orderBy: { id: 'asc' },
    });
    if (candidates.length < members.length) return;

    const now = new Date();
    const endTime = new Date(now.getTime() + this.matchDurationMs);
    const created = await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`tournament-match:${match.id}`}))`;
      const current = await tx.tournamentMatch.findUnique({
        where: { id: match.id },
      });
      if (
        !current ||
        current.status !== 'READY' ||
        (await tx.reservation.count({ where: { tournamentMatchId: match.id } }))
      )
        return [];
      for (const machine of candidates)
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${machine.id}))`;
      const gamerIds = members.map((member) => member.gamerProfileId).sort();
      for (const gamerId of gamerIds)
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`gamer:${gamerId}`}))`;
      const reserved = await tx.reservation.findMany({
        where: {
          status: { in: ['PENDING', 'CONFIRMED', 'ACTIVE'] },
          startTime: { lt: endTime },
          endTime: { gt: now },
          OR: [
            { machineId: { in: candidates.map((item) => item.id) } },
            { gamerProfileId: { in: gamerIds } },
          ],
        },
        select: { machineId: true, gamerProfileId: true },
      });
      const busyMachines = new Set(reserved.map((row) => row.machineId));
      const busyGamers = new Set(reserved.map((row) => row.gamerProfileId));
      const selected = candidates
        .filter((machine) => !busyMachines.has(machine.id))
        .slice(0, members.length);
      if (
        selected.length < members.length ||
        gamerIds.some((gamerId) => busyGamers.has(gamerId))
      )
        return [];
      const rows = [];
      for (let index = 0; index < members.length; index++) {
        rows.push(
          await tx.reservation.create({
            data: {
              gamerProfileId: members[index].gamerProfileId,
              machineId: selected[index].id,
              startTime: now,
              endTime,
              status: 'CONFIRMED',
              isWalkIn: false,
              tournamentId: match.tournamentId,
              tournamentMatchId: match.id,
            },
          }),
        );
      }
      await tx.tournamentMatch.update({
        where: { id: match.id },
        data: { status: 'IN_PROGRESS' },
      });
      return rows;
    });
    if (!created.length) return;

    try {
      for (let index = 0; index < created.length; index++) {
        const reservation = created[index];
        const session = await this.sessions.createTournamentSession(
          reservation.id,
        );
        const station = candidates.find(
          (item) => item.id === reservation.machineId,
        )!;
        const userId = members[index].gamerProfile.user.id;
        this.dashboard.publishToUser(userId, 'tournament_update', {
          tournamentId: match.tournamentId,
          matchId: match.id,
          station: {
            id: station.id,
            name: station.name,
            serialNumber: station.serialNumber,
          },
          pin: session.pin,
          pinExpiresAt: session.pinExpiresAt,
        });
        this.agents.sendControl(station.serialNumber, 'session_notice', {
          sessionId: session.sessionId,
          kind: 'TIME_LEFT',
          endsAt: endTime.toISOString(),
          message: `Tournament match ready: ${match.tournament.game.name}, round ${match.round}`,
        });
      }
    } catch (error) {
      await this.sessions.endTournamentMatch(match.id);
      await this.prisma.tournamentMatch.updateMany({
        where: { id: match.id, status: 'IN_PROGRESS' },
        data: { status: 'READY' },
      });
      throw error;
    }
    this.emit(match.tournament.branchId, match.tournamentId);
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
