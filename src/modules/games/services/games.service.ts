import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  type OnModuleDestroy,
} from '@nestjs/common';
import { Subject } from 'rxjs';

import { assertScope } from '../../../common/utils/assert-scope.js';
import { SCOPE_RANK } from '../../../common/utils/scope.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import type { Game, MachineGame } from '../../../generated/prisma/index.js';
import { PresenceService, type StationRef } from '../../station/services/presence.service.js';
import { GamesRepository } from '../repository/games.repository.js';
import {
  launchSpecError,
  type AssignStationDto,
  type CatalogStatusPayload,
  type CreateGameDto,
  type UpdateGameDto,
} from '../schemas/games.schemas.js';

/** The agent refuses a catalog body over 1 MB (HttpGameCatalogClient.MaxResponseBytes). */
const MAX_CATALOG_BYTES = 1024 * 1024;

/**
 * Some stations' resolved catalog changed. Ops turns this into CATALOG_UPDATE
 * commands for the ones that are online (offline ones re-sync on connect).
 */
export interface CatalogChange {
  branchIds: string[];
  machineIds: string[];
  issuedBy: string;
}

/** One entry of GET /stations/me/games, exactly the agent's CatalogGame. */
export interface CatalogGameEntry {
  gameId: string;
  name: string;
  launchType: string;
  target: string;
  arguments: string | null;
  workingDirectory: string | null;
  processName: string | null;
}

/** API shape of a catalog entry. */
export function toGameDto(game: Game) {
  return {
    id: game.id,
    gameId: game.gameId,
    name: game.name,
    launchType: game.launchType,
    target: game.target,
    arguments: game.arguments,
    workingDirectory: game.workingDirectory,
    processName: game.processName,
    iconUrl: game.iconUrl,
    enabled: game.enabled,
    sortOrder: game.sortOrder,
    createdAt: game.createdAt.toISOString(),
    updatedAt: game.updatedAt.toISOString(),
  };
}

/** A game as one machine sees it: its per-machine overrides applied. */
function toCatalogEntry(game: Game, override: MachineGame | undefined): CatalogGameEntry {
  return {
    gameId: game.gameId,
    name: game.name,
    launchType: game.launchType,
    target: override?.target ?? game.target,
    // Same rules the agent applies: epic takes no arguments, only exe has a working directory.
    arguments: game.launchType === 'epic' ? null : (override?.arguments ?? game.arguments),
    workingDirectory: game.launchType === 'exe' ? (override?.workingDirectory ?? game.workingDirectory) : null,
    processName: game.processName,
  };
}

/**
 * The backend-side game catalog and its per-station view. A station pulls its
 * resolved catalog (GET /stations/me/games), and reports back what it can
 * actually launch (`catalog_status`), which is the only availability truth.
 */
@Injectable()
export class GamesService implements OnModuleDestroy {
  private readonly logger = new Logger(GamesService.name);

  readonly catalogChanges = new Subject<CatalogChange>();

  constructor(
    private readonly repo: GamesRepository,
    private readonly presence: PresenceService,
  ) {}

  onModuleDestroy(): void {
    this.catalogChanges.complete();
  }

  // --- catalog admin -------------------------------------------------------

  /** Gamers see enabled games only; staff+ see the whole catalog. */
  async list(caller: AccessTokenPayload) {
    const enabledOnly = SCOPE_RANK[caller.scope] < SCOPE_RANK.staff;
    return (await this.repo.list(enabledOnly)).map(toGameDto);
  }

  async create(dto: CreateGameDto) {
    assertLaunchSpec(dto);
    await this.assertGameIdFree(dto.gameId);
    // Not assigned anywhere yet, so no station's catalog changes.
    return toGameDto(await this.repo.create(dto));
  }

  async update(caller: AccessTokenPayload, id: string, dto: UpdateGameDto) {
    const existing = await this.getGame(id);
    const merged = { ...existing, ...dto };
    assertLaunchSpec(merged);
    if (dto.gameId && dto.gameId !== existing.gameId) await this.assertGameIdFree(dto.gameId);

    const updated = await this.repo.update(id, dto);
    // Existing per-machine overrides are not re-checked against a new launch
    // type: the agent rejects a bad one and reports it in catalog_status.
    this.announce(await this.repo.assignments(id), caller);
    return toGameDto(updated);
  }

  async assignBranch(caller: AccessTokenPayload, id: string, branchId: string) {
    assertScope(caller, { branchId });
    await this.getGame(id);
    await this.repo.assignBranch(id, branchId);
    this.announce({ branchIds: [branchId], machineIds: [] }, caller);
    return { gameId: id, branchId, assigned: true };
  }

  async unassignBranch(caller: AccessTokenPayload, id: string, branchId: string) {
    assertScope(caller, { branchId });
    if (!(await this.repo.unassignBranch(id, branchId))) throw assignmentNotFound();
    this.announce({ branchIds: [branchId], machineIds: [] }, caller);
    return { gameId: id, branchId, assigned: false };
  }

  async assignStation(caller: AccessTokenPayload, id: string, stationId: string, dto: AssignStationDto) {
    const station = await this.getStation(caller, stationId);
    const game = await this.getGame(id);
    const overrides = {
      target: dto.target ?? null,
      arguments: dto.arguments ?? null,
      workingDirectory: dto.workingDirectory ?? null,
    };
    assertLaunchSpec({
      launchType: game.launchType,
      target: overrides.target ?? game.target,
      workingDirectory: overrides.workingDirectory ?? game.workingDirectory,
    });
    const row = await this.repo.assignMachine(id, station.machineId, overrides);
    this.announce({ branchIds: [], machineIds: [station.machineId] }, caller);
    return { gameId: id, stationId: station.machineId, assigned: true, ...overrides, updatedAt: row.updatedAt.toISOString() };
  }

  async unassignStation(caller: AccessTokenPayload, id: string, stationId: string) {
    const station = await this.getStation(caller, stationId);
    if (!(await this.repo.unassignMachine(id, station.machineId))) throw assignmentNotFound();
    this.announce({ branchIds: [], machineIds: [station.machineId] }, caller);
    return { gameId: id, stationId: station.machineId, assigned: false };
  }

  /** Staff view of one station: its resolved catalog, each with what the agent last reported. */
  async stationGames(caller: AccessTokenPayload, stationId: string) {
    const station = await this.getStation(caller, stationId);
    const [games, statuses] = await Promise.all([
      this.repo.resolvedFor(station.machineId, station.branchId),
      this.repo.statusesFor(station.machineId),
    ]);
    const byGameId = new Map(statuses.map((s) => [s.gameId, s]));
    return games.map((game) => {
      const status = byGameId.get(game.gameId);
      return {
        ...toCatalogEntry(game, game.machineGames[0]),
        id: game.id,
        // null until the station has reported on this entry (after its next sync).
        installed: status?.installed ?? null,
        reason: status?.reason ?? null,
        reportedAt: status?.reportedAt.toISOString() ?? null,
      };
    });
  }

  // --- station-facing ------------------------------------------------------

  /** GET /stations/me/games: the full catalog, resolved for this machine. */
  async catalogFor(station: StationRef): Promise<{ games: CatalogGameEntry[] }> {
    const games = await this.repo.resolvedFor(station.machineId, station.branchId);
    const body = { games: games.map((game) => toCatalogEntry(game, game.machineGames[0])) };
    const bytes = Buffer.byteLength(JSON.stringify(body));
    if (bytes > MAX_CATALOG_BYTES) {
      // The agent would drop it and keep its old catalog: fail loudly instead.
      this.logger.error(`catalog for ${station.serialNumber} is ${bytes} bytes (limit ${MAX_CATALOG_BYTES})`);
      throw new InternalServerErrorException({ code: 'CATALOG_TOO_LARGE', error: 'station catalog exceeds 1 MB' });
    }
    this.logger.log(`served catalog to ${station.serialNumber}: ${body.games.length} game(s)`);
    return body;
  }

  /** Inbound `catalog_status`: replaces what we know this station can launch. */
  async recordStationStatus(station: StationRef, report: CatalogStatusPayload) {
    const reportedAt = new Date();
    const rows = report.games.map((g) => ({ gameId: g.gameId, installed: g.installed, reason: g.reason ?? null }));
    await this.repo.replaceStatuses(station.machineId, rows, reportedAt);
    const installed = rows.filter((r) => r.installed).length;
    this.logger.log(`catalog_status from ${station.serialNumber}: ${installed}/${rows.length} launchable`);
    return {
      machineId: station.machineId,
      serialNumber: station.serialNumber,
      branchId: station.branchId,
      reportedAt: reportedAt.toISOString(),
      games: rows,
    };
  }

  /**
   * LAUNCH_GAME pre-check, before a command exists: the game is in this
   * station's resolved catalog and the station reported it installed. The
   * agent only launches ids from its synced catalog, so anything else would
   * come back as EXEC_FAILED.
   */
  async findLaunchable(station: StationRef, gameId: string): Promise<Game> {
    const game = await this.repo.findByGameId(gameId);
    if (!game) throw new NotFoundException({ code: 'GAME_NOT_FOUND', error: 'game not found' });
    if (!game.enabled) throw new ConflictException({ code: 'GAME_DISABLED', error: 'game is disabled' });

    const offered = await this.repo.resolvedFor(station.machineId, station.branchId);
    if (!offered.some((g) => g.id === game.id)) {
      throw new ConflictException({ code: 'GAME_NOT_ASSIGNED', error: "game is not in this station's catalog" });
    }

    const status = await this.repo.statusOf(station.machineId, game.gameId);
    if (!status) {
      throw new ConflictException({
        code: 'GAME_STATUS_UNKNOWN',
        error: 'station has not reported this game yet (waiting for its catalog_status)',
      });
    }
    if (!status.installed) {
      throw new ConflictException({
        code: 'GAME_NOT_INSTALLED',
        error: `game is not launchable on this station${status.reason ? `: ${status.reason}` : ''}`,
      });
    }
    return game;
  }

  // --- helpers -------------------------------------------------------------

  private announce(change: Omit<CatalogChange, 'issuedBy'>, caller: AccessTokenPayload): void {
    if (change.branchIds.length === 0 && change.machineIds.length === 0) return;
    this.catalogChanges.next({ ...change, issuedBy: caller.sub });
  }

  private async getGame(id: string): Promise<Game> {
    const game = await this.repo.findById(id);
    if (!game) throw new NotFoundException({ code: 'GAME_NOT_FOUND', error: 'game not found' });
    return game;
  }

  private async getStation(caller: AccessTokenPayload, stationId: string): Promise<StationRef> {
    const station = await this.presence.resolveById(stationId);
    if (!station) throw new NotFoundException({ code: 'STATION_NOT_FOUND', error: 'station not found' });
    assertScope(caller, { branchId: station.branchId });
    return station;
  }

  private async assertGameIdFree(gameId: string): Promise<void> {
    if (await this.repo.findByGameId(gameId)) {
      throw new ConflictException({ code: 'GAME_ID_TAKEN', error: 'gameId already in use' });
    }
  }
}

function assertLaunchSpec(spec: Parameters<typeof launchSpecError>[0]): void {
  const error = launchSpecError(spec);
  if (error) throw new BadRequestException({ code: 'INVALID_LAUNCH_SPEC', error });
}

function assignmentNotFound() {
  return new NotFoundException({ code: 'ASSIGNMENT_NOT_FOUND', error: 'game is not assigned there' });
}
