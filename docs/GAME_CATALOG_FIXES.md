# Game catalog fixes

This note records the backend changes made on 2026-09-30 to the game catalog.
Read it before touching `modules/games` or the `installed_games` /
`catalog_status` handling in `ops/agent.gateway.ts`.

Out of scope, on purpose: gamers don't launch games from the portal or the
lock screen. They use the desktop shortcuts once the PC is unlocked, and the
staff **Launch game** command stays as the way to start a game for someone
who can't (e.g. kids).

---

## 0. Before you run it

Migration `prisma/migrations/20260930190000_game_catalog_fixes`. Apply it,
then restart the backend:

```sh
npx prisma migrate deploy
```

| Change | Meaning |
|---|---|
| `machine_games.excluded BOOLEAN NOT NULL DEFAULT false` | The game is **not** offered on this machine, although its branch offers it |
| New table `station_installed_games` (`machine_id`, `launch_type`, `target`, `name`, `process_name`, `reported_at`) | Launcher games a station reported installed |

---

## 1. Installed games feed "add to catalog"

**Problem.** After every catalog sync the agent sends `installed_games`: the
Steam and Epic games installed on the PC. The backend ignored the frame, so
admins typed every Steam app id and Epic AppName by hand.

**Change.**
- The gateway handles `installed_games`. Each report replaces that station's
  list in `station_installed_games`.
  - Entries are checked one by one: `steam`/`epic` only, a valid target, a
    name, and an optional process name.
  - A bad entry is skipped and logged; it never drops the list.
- **`GET /api/v1/games/installed`** (staff) returns one row per game, with the
  stations that have it and `catalogGame` (the catalog entry with the same
  launcher and target, or `null`).
  - `?stationId=`: one station.
  - `?branchId=`: one branch.
  - No parameter: the caller's own branch, or every branch for HQ.
- The dashboard's Games page lists these games. **Add to catalog** fills the
  game form from the row (name, launcher, target, process name, a suggested
  game id).

## 2. Where a game is offered is visible

**Problem.** No endpoint said which branches or stations offer a game, so the
dashboard had to try an unassign and read the 404.

**Change.** For staff, `GET /api/v1/games` now includes each game's assignments:

```json
"assignments": { "branchIds": ["…"], "stationIds": ["…"], "excludedStationIds": ["…"] }
```

A branch manager or employee only sees their own branch's part; HQ sees
everything. The Games page shows an **Offered at** column, and enables only the
branch button that applies (**Offer** or **Stop offering**).

## 3. A branch manager can't change another branch's games

**Problem.** The catalog is shared by every branch, and any manager could edit
or disable a game, changing it at every other branch too.

**Change.**
- Editing (`PATCH /api/v1/games/:id`) and the new delete are allowed to:
  - HQ, for any game;
  - a manager, only for a game that no other branch offers, at branch or
    station level.
- Otherwise the answer is `403 GAME_SHARED_WITH_OTHER_BRANCHES`.
- Creating a game is unchanged: a new game is offered nowhere, so it affects
  no one.

## 4. Gamers no longer see launch details

**Problem.** `GET /api/v1/games` gave gamers every enabled game in every
branch with its full launch spec: `.exe` paths, arguments, working folder.

**Change.** For gamers it returns only `{ id, gameId, name, iconUrl, sortOrder }`,
and only for enabled games offered at some branch or station.

## 5. One station can be taken off a branch-offered game

**Problem.** When a branch offered a game, every station there had it, with no
way to take one off. `DELETE …/stations/:stationId` removed the station's
override and answered `assigned: false`, but the station kept the game.

**Change.**
- `DELETE /api/v1/games/:id/stations/:stationId` now works in both cases:
  - **The game's branch offers it:** the station is excluded
    (`machine_games.excluded = true`). The rest of the branch keeps the game.
  - **Only that station has it:** the assignment is removed, as before.
  - **The station doesn't have the game:** `404 ASSIGNMENT_NOT_FOUND`.
- `PUT …/stations/:stationId` offers the game there again, lifting an exclusion.
- A station's catalog (`resolvedFor`) is now:
  - the enabled games its branch offers, unless the station is excluded, plus
  - the games assigned to the station itself.

## 6. Install reports are dropped when they go out of date

**Problem.** After a game's launch details changed, the station's last
"installed" report stayed until it synced again. A launch in that gap passed
the backend's check and failed on the station.

**Change.**
- Editing a launch field (`gameId`, `launchType`, `target`, `arguments`,
  `workingDirectory`, `processName`) deletes the stations' reports for that
  game, under both the old and the new id.
- Changing a station's overrides deletes that station's report.
- Launches answer `GAME_STATUS_UNKNOWN` until the station reports again, which
  it does right after the `CATALOG_UPDATE` that the edit triggers.
- A rename, `enabled`, `iconUrl` or `sortOrder` change keeps the reports.

## 7. Games can be deleted

**Problem.** A game could only be disabled, so the catalog only grew and a
mistyped game id could never be reused.

**Change.**
- New **`DELETE /api/v1/games/:id`**, with the same permission rule as editing (§3).
- It removes the game, its branch and station assignments, and the stations'
  reports about it.
- Every station that offered it gets a `CATALOG_UPDATE`.
- Past `LAUNCH_GAME` commands stay, with a null `gameId`.

---

## New error codes

| Code | Status | When |
|---|---|---|
| `GAME_SHARED_WITH_OTHER_BRANCHES` | 403 | A manager edits or deletes a game another branch offers |

## Tests

- **Unit:** `src/modules/games/services/games.service.spec.ts` (13 tests) covers:
  - what gamers and staff see in the list
  - the cross-branch edit rule, delete
  - station exclusion
  - dropping stale install reports
  - installed-game parsing and grouping
- **e2e:** new cases in `test/commands.e2e-spec.ts` cover the gamer view,
  exclusion, stale reports, `installed_games`, delete and the cross-branch
  rule. They need the migration applied and **have not been run yet**.

## Note for the agent team

`Desktop-Agent/docs/GamesHandling.md` still says the backend ignores
`installed_games`; that is no longer true.
