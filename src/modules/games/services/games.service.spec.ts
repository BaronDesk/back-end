import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { GamesService } from './games.service.js';

const BRANCH = 'b1';
const OTHER = 'b2';
const STATION = { machineId: 'm1', branchId: BRANCH, serialNumber: 'SN-1' };

const hq: AccessTokenPayload = { sub: 'hq', role: 'ADMIN', scope: 'hq', branchId: null, jti: 'j' };
const manager: AccessTokenPayload = { sub: 'mgr', role: 'MANAGER', scope: 'admin', branchId: BRANCH, jti: 'j' };
const gamer: AccessTokenPayload = { sub: 'g', role: 'GAMER', scope: 'self', branchId: null, jti: 'j' };

function game(overrides: Record<string, unknown> = {}) {
  return {
    id: 'game-1', gameId: 'cs2', name: 'CS2', launchType: 'steam', target: '730', arguments: null,
    workingDirectory: null, processName: 'cs2.exe', iconUrl: null, enabled: true, sortOrder: 0,
    createdAt: new Date(), updatedAt: new Date(),
    gameBranches: [] as { branchId: string }[],
    machineGames: [] as { machineId: string; excluded: boolean; machine: { branchId: string } }[],
    ...overrides,
  };
}

describe('GamesService', () => {
  let repo: Record<string, ReturnType<typeof vi.fn>>;
  let presence: { resolveById: ReturnType<typeof vi.fn> };
  let service: GamesService;
  let announced: unknown[];

  beforeEach(() => {
    repo = {
      listOffered: vi.fn(async () => [game()]),
      listWithAssignments: vi.fn(async () => [game()]),
      findById: vi.fn(async () => game()),
      findWithAssignments: vi.fn(async () => game()),
      findByGameId: vi.fn(async () => null),
      update: vi.fn(async (_id, dto) => ({ ...game(), ...dto })),
      delete: vi.fn(async () => undefined),
      assignments: vi.fn(async () => ({ branchIds: [BRANCH], machineIds: [] })),
      forgetStatuses: vi.fn(async () => ({ count: 1 })),
      machineRow: vi.fn(async () => null),
      isOfferedAtBranch: vi.fn(async () => false),
      excludeMachine: vi.fn(async () => ({})),
      deleteMachineRow: vi.fn(async () => true),
      assignMachine: vi.fn(async () => ({ updatedAt: new Date() })),
      replaceInstalled: vi.fn(async () => []),
      installedIn: vi.fn(async () => []),
      findByTargets: vi.fn(async () => []),
    };
    presence = { resolveById: vi.fn(async () => STATION) };
    service = new GamesService(repo as any, presence as any);
    announced = [];
    service.catalogChanges.subscribe((c) => announced.push(c));
  });

  describe('list', () => {
    it('shows gamers the offered games without any launch detail', async () => {
      const [entry] = await service.list(gamer);
      expect(entry).toEqual({ id: 'game-1', gameId: 'cs2', name: 'CS2', iconUrl: null, sortOrder: 0 });
      expect(repo.listOffered).toHaveBeenCalled();
      expect(repo.listWithAssignments).not.toHaveBeenCalled();
    });

    it("shows staff where a game is offered, limited to their own branch unless HQ", async () => {
      repo.listWithAssignments.mockResolvedValue([
        game({
          gameBranches: [{ branchId: BRANCH }, { branchId: OTHER }],
          machineGames: [
            { machineId: 'm1', excluded: true, machine: { branchId: BRANCH } },
            { machineId: 'm9', excluded: false, machine: { branchId: OTHER } },
          ],
        }),
      ]);
      const [mine] = (await service.list(manager)) as unknown as { assignments: unknown }[];
      expect(mine.assignments).toEqual({ branchIds: [BRANCH], stationIds: [], excludedStationIds: ['m1'] });
      const [all] = (await service.list(hq)) as unknown as { assignments: unknown }[];
      expect(all.assignments).toEqual({ branchIds: [BRANCH, OTHER], stationIds: ['m9'], excludedStationIds: ['m1'] });
    });
  });

  describe('editing a shared catalog', () => {
    it('lets a manager edit a game only their branch offers', async () => {
      repo.findWithAssignments.mockResolvedValue(game({ gameBranches: [{ branchId: BRANCH }] }));
      await expect(service.update(manager, 'game-1', { enabled: false })).resolves.toMatchObject({ enabled: false });
    });

    it('refuses a manager an edit or delete of a game another branch offers, at branch or station level', async () => {
      repo.findWithAssignments.mockResolvedValue(game({ gameBranches: [{ branchId: OTHER }] }));
      await expect(service.update(manager, 'game-1', { enabled: false })).rejects.toMatchObject({
        response: { code: 'GAME_SHARED_WITH_OTHER_BRANCHES' },
      });
      repo.findWithAssignments.mockResolvedValue(game({ machineGames: [{ machineId: 'm9', excluded: false, machine: { branchId: OTHER } }] }));
      await expect(service.remove(manager, 'game-1')).rejects.toMatchObject({ response: { code: 'GAME_SHARED_WITH_OTHER_BRANCHES' } });
      expect(repo.update).not.toHaveBeenCalled();
      expect(repo.delete).not.toHaveBeenCalled();
    });

    it('lets HQ edit any game', async () => {
      repo.findWithAssignments.mockResolvedValue(game({ gameBranches: [{ branchId: OTHER }] }));
      await expect(service.update(hq, 'game-1', { name: 'x' })).resolves.toMatchObject({ name: 'x' });
    });

    it('forgets install reports when the launch spec changes (old and new wire id), not on a rename', async () => {
      await service.update(hq, 'game-1', { name: 'Renamed' });
      expect(repo.forgetStatuses).not.toHaveBeenCalled();
      await service.update(hq, 'game-1', { gameId: 'cs2-new', target: '731' });
      expect(repo.forgetStatuses).toHaveBeenCalledWith(['cs2', 'cs2-new']);
    });

    it('deletes a game and tells the stations that offered it to re-sync', async () => {
      await expect(service.remove(hq, 'game-1')).resolves.toEqual({ id: 'game-1', deleted: true });
      expect(repo.delete).toHaveBeenCalledWith('game-1', 'cs2');
      expect(announced).toEqual([{ branchIds: [BRANCH], machineIds: [], issuedBy: 'hq' }]);
    });
  });

  describe('station assignments', () => {
    it('excludes one station from a game its branch offers, instead of a no-op', async () => {
      repo.isOfferedAtBranch.mockResolvedValue(true);
      await expect(service.unassignStation(manager, 'game-1', 'm1')).resolves.toMatchObject({ assigned: false });
      expect(repo.excludeMachine).toHaveBeenCalledWith('game-1', 'm1');
      expect(repo.deleteMachineRow).not.toHaveBeenCalled();
    });

    it('unassigns a game assigned to the station alone, and 404s when there is nothing to take off', async () => {
      await service.unassignStation(manager, 'game-1', 'm1');
      expect(repo.deleteMachineRow).toHaveBeenCalledWith('game-1', 'm1');

      repo.machineRow.mockResolvedValueOnce({ excluded: true });
      await expect(service.unassignStation(manager, 'game-1', 'm1')).rejects.toMatchObject({ response: { code: 'ASSIGNMENT_NOT_FOUND' } });
      repo.deleteMachineRow.mockResolvedValueOnce(false);
      await expect(service.unassignStation(manager, 'game-1', 'm1')).rejects.toMatchObject({ response: { code: 'ASSIGNMENT_NOT_FOUND' } });
    });

    it("forgets the station's install report when its overrides change", async () => {
      repo.findById.mockResolvedValue(game({ launchType: 'exe', target: 'C:\\Games\\a.exe' }));
      await service.assignStation(manager, 'game-1', 'm1', { target: 'D:\\Games\\a.exe' });
      expect(repo.forgetStatuses).toHaveBeenCalledWith(['cs2'], 'm1');
    });
  });

  describe('installed games', () => {
    it('keeps the valid installed_games entries and skips the rest', async () => {
      const count = await service.recordInstalledGames(STATION, [
        { launchType: 'Steam', target: '730', name: 'CS2', processName: 'cs2.exe', inCatalog: true },
        { launchType: 'epic', target: 'Fortnite', name: 'Fortnite' },
        { launchType: 'steam', target: 'abc', name: 'Bad id' },
        { launchType: 'exe', target: 'C:\\x.exe', name: 'Not a launcher game' },
        'garbage',
      ]);
      expect(count).toBe(2);
      expect(repo.replaceInstalled.mock.calls[0][1]).toEqual([
        { launchType: 'steam', target: '730', name: 'CS2', processName: 'cs2.exe' },
        { launchType: 'epic', target: 'Fortnite', name: 'Fortnite', processName: null },
      ]);
    });

    it('groups installs by game across stations and marks the ones already in the catalog', async () => {
      const at = new Date('2026-09-30T10:00:00Z');
      const row = (machineId: string, target: string, name: string) => ({
        machineId, launchType: 'steam', target, name, processName: null, reportedAt: at,
        machine: { id: machineId, name: null, serialNumber: `SN-${machineId}`, branchId: BRANCH },
      });
      repo.installedIn.mockResolvedValue([row('m1', '730', 'CS2'), row('m2', '730', 'CS2'), row('m1', '570', 'Dota 2')]);
      repo.findByTargets.mockResolvedValue([{ id: 'game-1', gameId: 'cs2', name: 'CS2', launchType: 'steam', target: '730' }]);

      const list = await service.installedGames(manager, {});
      expect(repo.installedIn).toHaveBeenCalledWith([BRANCH], undefined);
      expect(list).toHaveLength(2);
      expect(list.find((g) => g.target === '730')).toMatchObject({
        stations: [{ id: 'm1' }, { id: 'm2' }],
        catalogGame: { id: 'game-1', gameId: 'cs2', name: 'CS2' },
      });
      expect(list.find((g) => g.target === '570')).toMatchObject({ catalogGame: null });
    });

    it('lets HQ see every branch, and keeps branch staff to their own', async () => {
      await service.installedGames(hq, {});
      expect(repo.installedIn).toHaveBeenCalledWith(null, undefined);
      await expect(service.installedGames(manager, { branchId: OTHER })).rejects.toThrow();
    });
  });
});
