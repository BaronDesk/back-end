import { Injectable } from '@nestjs/common';

import { BaseRepository } from '../../../common/repository/base.repository.js';
import { PrismaService } from '../../../infra/prisma/prisma.service.js';
import type { GameLaunchType, Prisma } from '../../../generated/prisma/index.js';

export interface StationGameStatusRow {
  gameId: string;
  installed: boolean;
  reason: string | null;
}

export interface InstalledGameRow {
  launchType: GameLaunchType;
  target: string;
  name: string;
  processName: string | null;
}

/** Where a game is offered: branches, and single-machine rows (an assignment, or an exclusion from its branch). */
const WITH_ASSIGNMENTS = {
  gameBranches: { select: { branchId: true } },
  machineGames: { select: { machineId: true, excluded: true, machine: { select: { branchId: true } } } },
} as const;

export type GameWithAssignments = Prisma.GameGetPayload<{ include: typeof WITH_ASSIGNMENTS }>;

@Injectable()
export class GamesRepository extends BaseRepository {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  /** The whole catalog, with where each game is offered. */
  listWithAssignments() {
    return this.prisma.game.findMany({
      include: WITH_ASSIGNMENTS,
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  /** Enabled games offered at some branch or station at all. */
  listOffered() {
    return this.prisma.game.findMany({
      where: {
        enabled: true,
        OR: [{ gameBranches: { some: {} } }, { machineGames: { some: { excluded: false } } }],
      },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  findById(id: string) {
    return this.prisma.game.findUnique({ where: { id } });
  }

  findWithAssignments(id: string) {
    return this.prisma.game.findUnique({ where: { id }, include: WITH_ASSIGNMENTS });
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

  /** Removes the game, its assignments (cascade) and what stations reported about it. Past commands keep a null gameId. */
  async delete(id: string, wireGameId: string) {
    await this.prisma.$transaction([
      this.prisma.stationGameStatus.deleteMany({ where: { gameId: wireGameId } }),
      this.prisma.game.delete({ where: { id } }),
    ]);
  }

  /** Where a game is offered: the branches and single machines it is assigned to (or excluded from). */
  async assignments(id: string): Promise<{ branchIds: string[]; machineIds: string[] }> {
    const [branches, machines] = await Promise.all([
      this.prisma.gameBranch.findMany({ where: { gameId: id }, select: { branchId: true } }),
      this.prisma.machineGame.findMany({ where: { gameId: id }, select: { machineId: true } }),
    ]);
    return { branchIds: branches.map((b) => b.branchId), machineIds: machines.map((m) => m.machineId) };
  }

  isOfferedAtBranch(gameId: string, branchId: string) {
    return this.prisma.gameBranch
      .findUnique({ where: { gameId_branchId: { gameId, branchId } } })
      .then((row) => row !== null);
  }

  machineRow(gameId: string, machineId: string) {
    return this.prisma.machineGame.findUnique({ where: { machineId_gameId: { machineId, gameId } } });
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

  /** Offers the game on the machine (lifting an exclusion), with its overrides. */
  assignMachine(
    gameId: string,
    machineId: string,
    overrides: { target: string | null; arguments: string | null; workingDirectory: string | null },
  ) {
    const data = { ...overrides, excluded: false };
    return this.prisma.machineGame.upsert({
      where: { machineId_gameId: { machineId, gameId } },
      update: data,
      create: { machineId, gameId, ...data },
    });
  }

  /** Keeps a branch-offered game off one machine. */
  excludeMachine(gameId: string, machineId: string) {
    const data = { target: null, arguments: null, workingDirectory: null, excluded: true };
    return this.prisma.machineGame.upsert({
      where: { machineId_gameId: { machineId, gameId } },
      update: data,
      create: { machineId, gameId, ...data },
    });
  }

  async deleteMachineRow(gameId: string, machineId: string): Promise<boolean> {
    const { count } = await this.prisma.machineGame.deleteMany({ where: { gameId, machineId } });
    return count > 0;
  }

  /**
   * The games offered on one machine: enabled, and either offered at its
   * branch without an exclusion for this machine, or assigned to the machine
   * itself. Carries that machine's override row, if any.
   */
  resolvedFor(machineId: string, branchId: string) {
    return this.prisma.game.findMany({
      where: {
        enabled: true,
        OR: [
          { gameBranches: { some: { branchId } }, machineGames: { none: { machineId, excluded: true } } },
          { machineGames: { some: { machineId, excluded: false } } },
        ],
      },
      include: { machineGames: { where: { machineId, excluded: false } } },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  statusesFor(machineId: string) {
    return this.prisma.stationGameStatus.findMany({ where: { machineId } });
  }

  statusOf(machineId: string, gameId: string) {
    return this.prisma.stationGameStatus.findUnique({ where: { machineId_gameId: { machineId, gameId } } });
  }

  /** Forgets what stations reported about these wire ids: their launch spec changed, so the reports are stale. */
  forgetStatuses(wireGameIds: string[], machineId?: string) {
    return this.prisma.stationGameStatus.deleteMany({
      where: { gameId: { in: wireGameIds }, ...(machineId ? { machineId } : {}) },
    });
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

  /** An installed_games report is the station's full list: it replaces the previous one. */
  replaceInstalled(machineId: string, rows: InstalledGameRow[], reportedAt: Date) {
    return this.prisma.$transaction([
      this.prisma.stationInstalledGame.deleteMany({ where: { machineId } }),
      this.prisma.stationInstalledGame.createMany({
        data: rows.map((row) => ({ machineId, ...row, reportedAt })),
        skipDuplicates: true,
      }),
    ]);
  }

  /** Installed launcher games across the stations of these branches (all branches when null). */
  installedIn(branchIds: string[] | null, machineId?: string) {
    return this.prisma.stationInstalledGame.findMany({
      where: {
        ...(branchIds ? { machine: { branchId: { in: branchIds } } } : {}),
        ...(machineId ? { machineId } : {}),
      },
      include: { machine: { select: { id: true, name: true, serialNumber: true, branchId: true } } },
      orderBy: { name: 'asc' },
    });
  }

  /** Catalog games with these launcher targets, to tell which installed games are already in the catalog. */
  findByTargets(targets: { launchType: GameLaunchType; target: string }[]) {
    if (targets.length === 0) return Promise.resolve([]);
    return this.prisma.game.findMany({
      where: { OR: targets.map((t) => ({ launchType: t.launchType, target: t.target })) },
      select: { id: true, gameId: true, name: true, launchType: true, target: true },
    });
  }
}
