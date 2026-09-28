import { Injectable } from '@nestjs/common';

import { BaseRepository } from '../../../common/repository/base.repository.js';
import { PrismaService } from '../../../infra/prisma/prisma.service.js';
import type { Prisma } from '../../../generated/prisma/index.js';

export interface StationGameStatusRow {
  gameId: string;
  installed: boolean;
  reason: string | null;
}

@Injectable()
export class GamesRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  list(enabledOnly: boolean) {
    return this.prisma.game.findMany({
      where: enabledOnly ? { enabled: true } : {},
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  findById(id: string) {
    return this.prisma.game.findUnique({ where: { id } });
  }

  /** By wire id. */
  findByGameId(gameId: string) {
    return this.prisma.game.findUnique({ where: { gameId } });
  }

  create(data: Prisma.GameCreateInput) {
    return this.prisma.game.create({ data });
  }

  update(id: string, data: Prisma.GameUpdateInput) {
    return this.prisma.game.update({ where: { id }, data });
  }

  /** Where a game is offered: the branches and single machines it is assigned to. */
  async assignments(id: string): Promise<{ branchIds: string[]; machineIds: string[] }> {
    const [branches, machines] = await Promise.all([
      this.prisma.gameBranch.findMany({ where: { gameId: id }, select: { branchId: true } }),
      this.prisma.machineGame.findMany({ where: { gameId: id }, select: { machineId: true } }),
    ]);
    return { branchIds: branches.map((b) => b.branchId), machineIds: machines.map((m) => m.machineId) };
  }

  assignBranch(gameId: string, branchId: string) {
    return this.prisma.gameBranch.upsert({
      where: { gameId_branchId: { gameId, branchId } },
      update: {},
      create: { gameId, branchId },
    });
  }

  async unassignBranch(gameId: string, branchId: string): Promise<boolean> {
    const { count } = await this.prisma.gameBranch.deleteMany({ where: { gameId, branchId } });
    return count > 0;
  }

  assignMachine(
    gameId: string,
    machineId: string,
    overrides: { target: string | null; arguments: string | null; workingDirectory: string | null },
  ) {
    return this.prisma.machineGame.upsert({
      where: { machineId_gameId: { machineId, gameId } },
      update: overrides,
      create: { machineId, gameId, ...overrides },
    });
  }

  async unassignMachine(gameId: string, machineId: string): Promise<boolean> {
    const { count } = await this.prisma.machineGame.deleteMany({ where: { gameId, machineId } });
    return count > 0;
  }

  /**
   * The games offered on one machine: enabled, and assigned to its branch or
   * to the machine itself. Carries that machine's override row, if any.
   */
  resolvedFor(machineId: string, branchId: string) {
    return this.prisma.game.findMany({
      where: {
        enabled: true,
        OR: [{ gameBranches: { some: { branchId } } }, { machineGames: { some: { machineId } } }],
      },
      include: { machineGames: { where: { machineId } } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  statusesFor(machineId: string) {
    return this.prisma.stationGameStatus.findMany({ where: { machineId } });
  }

  statusOf(machineId: string, gameId: string) {
    return this.prisma.stationGameStatus.findUnique({ where: { machineId_gameId: { machineId, gameId } } });
  }

  /** A catalog_status is the station's full picture: it replaces the previous one. */
  replaceStatuses(machineId: string, rows: StationGameStatusRow[], reportedAt: Date) {
    return this.prisma.$transaction([
      this.prisma.stationGameStatus.deleteMany({ where: { machineId } }),
      this.prisma.stationGameStatus.createMany({
        data: rows.map((row) => ({ machineId, ...row, reportedAt })),
        skipDuplicates: true,
      }),
    ]);
  }
}
