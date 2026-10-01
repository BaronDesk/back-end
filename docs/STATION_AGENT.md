# Station agent integration

This document covers the part of the backend that talks to the BaronDesk desktop
agent running on each gaming PC ("station"):

- station credentials and enrollment gating
- the `/agent-ws` WebSocket protocol
- node tracking (presence: ONLINE / OFFLINE)
- remote commands (LOCK, UNLOCK, SHUTDOWN, LAUNCH_GAME, END_SESSION, CATALOG_UPDATE)
- the per-station game catalog
- telemetry and hardware alerts
- the `/dashboard-io` live feed for staff dashboards (and the gamer's own events)

Updated on 2026-10-01 for the flow fixes (token version and renewal, PIN at booking,
`session_notice`, `station_credential`, peripherals, staff UNLOCK). The full list is in
`FLOW_FIXES.md`.

Enrollment itself (how a station gets its MACHINE row and its station JWT) is
not built yet. See [ENROLLMENT_HANDOFF.md](ENROLLMENT_HANDOFF.md) for the
contract it must fulfil.

---

## 1. Big picture

```text
 Gaming PC                          Server (Docker)                               Staff browser
┌──────────────┐  wss /agent-ws   ┌───────┐   ┌──────────────────────────────┐   socket.io   ┌───────────┐
│ BaronDesk    │─────────────────►│ Caddy │──►│ Nest backend :3000           │◄──────────────│ Dashboard │
│ agent        │  https /stations │ :443  │   │  AgentGateway (raw ws)       │ /dashboard-io │           │
│ (ServiceCore)│  /me/games       │  TLS  │   │  PresenceService             │               └───────────┘
└──────────────┘                  └───────┘   │  CommandsService + BullMQ    │   REST /api/v1/...
                                              │  GamesService, Telemetry     │◄──────────────
                                              └──────┬───────────────┬───────┘
                                                     │               │
                                                Postgres          Redis
                                          (MACHINE, COMMAND,  (node:<serial> cache,
                                           games, telemetry)   BullMQ queue)
```

| Module | Files | Role |
|---|---|---|
| `station` | [station-token.service.ts](../src/modules/station/services/station-token.service.ts), [station-auth.service.ts](../src/modules/station/services/station-auth.service.ts), [station-auth.guard.ts](../src/modules/station/guards/station-auth.guard.ts), [presence.service.ts](../src/modules/station/services/presence.service.ts) | Station identity, admission, presence |
| `ops` | [agent.gateway.ts](../src/modules/ops/agent.gateway.ts), [dashboard.gateway.ts](../src/modules/ops/dashboard.gateway.ts), [commands.service.ts](../src/modules/ops/services/commands.service.ts), telemetry and alerts services | Agent socket, dashboard socket, commands, telemetry |
| `games` | [games.service.ts](../src/modules/games/services/games.service.ts), [station-catalog.controller.ts](../src/modules/games/controllers/station-catalog.controller.ts) | Game catalog and per-station resolution |
| `infra/realtime` | [envelope.ts](../src/infra/realtime/envelope.ts), [frame.ts](../src/infra/realtime/frame.ts), [seq-guard.ts](../src/infra/realtime/seq-guard.ts), [registry.ts](../src/infra/realtime/registry.ts) | Wire envelope, anti-replay, serial-to-socket registry |

---

## 2. Station credentials and admission

### 2.1 The station token

A station authenticates with a **station JWT**, sent as `Authorization: Bearer <jwt>`
on both the WebSocket upgrade and station-facing REST calls.

| Claim | Type | Meaning |
|---|---|---|
| `sub` | uuid | `Machine.id` |
| `type` | `"station"` | Tells a station token apart from a user token |
| `serialNumber` | string | `Machine.serialNumber` |
| `branchId` | uuid | `Machine.branchId` |
| `exp` | number | Required. A token without expiry is rejected |
| `ver` | number | Credential version; must equal `Machine.credentialVersion`. Missing = 1 |

- Signed **HS256** with `JWT_ACCESS_SECRET`, the same key as user access tokens.
- `StationTokenService.verify` checks signature and expiry through identity's
  `TokenService.verifyAccessKeySignature`, then validates the claim shape.
- A station token can never pass as a user token: `TokenService.verifyAccessToken`
  rejects any payload that has a `type` claim. The reverse also holds: a user
  token has no `type: "station"` and is rejected as a station token.
- The identity always comes from the token. The handshake `serialNumber` is only
  compared against it, never trusted on its own.
- **Rotation:** redeeming a rotation token (`POST /machines/:id/rotate-token`) bumps
  `credentialVersion`, so the old token stops working.
- **Renewal:** on handshake, a token that expires within 30 days is replaced: the
  backend sends `station_credential { stationToken }` (same version). The agent saves
  it and uses it from the next reconnect.

### 2.2 The admission rule

A valid token is not enough. `assertStationAdmitted` (in
[presence.service.ts](../src/modules/station/services/presence.service.ts)) reads
the MACHINE row fresh and requires all of the following:

1. The row with `id = sub` exists. Else `UnknownStationError`.
2. `enrollmentStatus = ENROLLED`. Else `StationNotEnrolledError`.
3. The row's `serialNumber` and `branchId` still equal the token's. Else
   `StationIdentityMismatchError`.
4. The token's `ver` equals the row's `credentialVersion`. Else
   `StationIdentityMismatchError`.

There is **no fallback**: no serial-only identification, no `x-station-serial`
header, no auto-created MACHINE rows, in any environment.

The rule runs at three points:

| Where | Bad or missing token | Valid token, not admitted |
|---|---|---|
| WSS upgrade on `/agent-ws` | HTTP **401**, no socket | Socket opens, then closes at once with **1008** |
| Handshake frame (re-check, enrollment may have changed) | n/a | Close **1008** |
| `GET /stations/me/games` (`StationAuthGuard`) | **401** `MISSING_STATION_TOKEN` / `INVALID_STATION_TOKEN` | **403** `STATION_NOT_ENROLLED`, or **401** `STATION_TOKEN_MISMATCH` |

1008 close reasons: `station not enrolled` (no row, or not ENROLLED),
`station token does not match the station` (serial or branch changed),
`serial number does not match station token` (handshake serial differs from the token).

Consequences worth knowing:

- Moving a machine to another branch, or changing its serial, invalidates its
  current token. The station needs a new one.
- Rejecting or revoking a station closes its open socket at once (1008). Revoke also
  settles any open session on it and cancels its bookings ahead.
- A rejected or revoked PC can enroll again with a fresh enrollment token for the same
  branch: it goes back to PENDING (new key and name) and waits for approval.

### 2.3 Station-facing REST

Station routes live under `/stations/me/*`, **without** the `api/v1` prefix,
because the agent derives the URL from its server host. They use `@Public()` (so
the user `JwtAuthGuard` steps aside) plus `@UseGuards(StationAuthGuard)`. The
guard puts a `StationRef { machineId, branchId, serialNumber }` on the request;
read it with `@CurrentStation()`.

---

## 3. The `/agent-ws` protocol

Raw `ws` server attached to Nest's HTTP server (not socket.io), path `/agent-ws`,
behind Caddy on 443.

### 3.1 Envelope

Every frame, in both directions, is a JSON envelope:

```json
{ "type": "heartbeat", "id": "<uuid>", "ts": "2026-09-28T10:00:00.000Z", "seq": 7, "payload": { } }
```

- `ts`: ISO-8601 (the agent) or epoch ms. Normalised to epoch ms on parse.
- Anti-replay (`SeqGuard`, one per stream per socket): `seq` must strictly increase,
  and `ts` must be within **30 s** of server time. Failing frames are dropped and
  logged (`seq_replay` / `ts_out_of_window`).
- The agent uses two sequence streams: `telemetry` and `device_event` have their own
  counter, everything else shares the connection counter. The backend keeps one
  `SeqGuard` per stream.
- Outbound frames get a fresh `seq` starting at 1 per connection (`OutboundSequencer`)
  and a fresh `ts` at send time. Commands reuse their `commandId` as the envelope `id`
  on every resend, because the agent keys idempotency on it.

### 3.2 Connection lifecycle

1. Upgrade with `Authorization: Bearer <station jwt>`. Admission runs (§2.2).
2. The agent must send `handshake` within **10 s**, or the socket closes with 4408.
3. The backend re-checks admission, marks the station ONLINE, registers the socket
   and answers `handshake_ack`.
4. Frames other than `handshake` sent before the handshake completes are ignored.
5. A new connection for the same serial replaces the old one (old socket closed 4000).

### 3.3 Agent to server

| type | Payload | Handling |
|---|---|---|
| `handshake` | `{ serialNumber, agentVersion?, osVersion?, machineName? }` | Admission, ONLINE, `handshake_ack` |
| `heartbeat` | `{ locked, sessionId? }` | Bumps `lastSeen`, updates lock/session. Always answered with `heartbeat_ack` carrying a renewed lease (§3.6) |
| `state_report` | `{ locked?, sessionId?, runningGameId?, leaseExpiresAt?, peripherals? }` | Updates lock / session / running game. Sent on (re)connect. A reported session is reconciled; with no `sessionId`, a session still open on the PC is settled (§3.6) |
| `login_request` | `{ method: "pin", credential }` | The lock screen relays the PIN; the agent validates nothing. Answered with `login_result`. A malformed frame is logged and dropped |
| `telemetry` | `{ samples: [{ metric, value, sampledAt? }] }` | Ingested, cached, pushed to dashboards. No ack |
| `alert` | `{ category, type, severity, detail, occurredAt }` | Stored as a `TelemetryAlert`, repeats folded into the open alert. No ack |
| `device_event` | legacy | Kept for older agents |
| `command_ack` | `{ commandId }` | Command → `ACKED` |
| `command_nack` | `{ commandId, code, reason? }` | Command → `FAILED` or `NACKED` (§5.3) |
| `catalog_status` | `{ games: [{ gameId, installed, reason? }] }` | Stored per station, pushed to dashboards |
| `installed_games` | `{ games: [{ launchType: steam \| epic, target, name, processName? }] }` | Stored per station (`station_installed_games`) for the staff's "installed here" list. Bad entries are skipped one by one |
| `peripheral_status` | `{ peripherals: [{ deviceId, name?, vendorProductId?, connected, changedAt? }] }` | The full list, on every change. Stored on the machine, pushed to the branch as `peripheral_status`. `state_report.peripherals` is handled the same way |

### 3.4 Server to agent

| type | Payload |
|---|---|
| `handshake_ack` | `{}` |
| `heartbeat_ack` | `{ leaseSeconds, serverTime }`: never null (§3.6) |
| `login_result` | `{ requestId, accepted, reason? }`: `requestId` is the `login_request` envelope id. `reason`: `invalid_pin`, `pin_expired`, `pin_used`, `too_many_attempts`, `no_pending_session` (no booking has started on this PC), `insufficient_funds` (below the minimum play time), `unsupported_method`, `unavailable` |
| `session_notice` | `{ sessionId, kind: LOW_BALANCE \| TIME_LEFT \| CLEAR, endsAt, message: null }`: the corner box. LOW_BALANCE when the runout warning fires, TIME_LEFT `SESSION_ENDING_NOTICE_MINUTES` before the end, CLEAR after a top-up or an extend. `endsAt` is when the station locks |
| `station_credential` | `{ stationToken }`: a renewed station token (§2.1) |
| `LOCK`, `UNLOCK`, `SHUTDOWN`, `LAUNCH_GAME`, `END_SESSION`, `CATALOG_UPDATE` | Command payload (§5) |

### 3.5 Close codes

| Code | Reason |
|---|---|
| 1008 | Station not admitted, or handshake serial differs from the token (§2.2) |
| 1011 | Handshake failed on a server error |
| 4000 | Replaced by a newer connection for the same station |
| 4400 | Malformed envelope, or invalid handshake payload |
| 4408 | No handshake within 10 s |
| 4409 | Serial number changed mid-connection |

### 3.6 Login, lease and reconnect

1. Every booking and walk-in gets a `PENDING` session with a 6-digit PIN when it is made; the
   gamer's app shows it. The argon2 hash does the login check; a sealed copy (`pin_cipher`)
   lets the app show it again. The PIN works on that PC only, from the booking's start until
   the no-show deadline (`NO_SHOW_GRACE_MINUTES` after the start, never past the end). It is
   single-use and burned after `SESSION_PIN_MAX_ATTEMPTS` wrong entries. Nothing is sent to
   the station. (`POST /sessions` stays as the desk's way to issue one.)
2. The gamer types the PIN; the agent sends `login_request`. The backend checks it against the
   PENDING session of the booking that has started on this PC, checks the balance covers
   `SESSION_MIN_PLAY_MINUTES`, and answers `login_result`. An accepted login closes any other
   session still open on the PC. Only then does it send
   `UNLOCK { sessionId, leaseSeconds, serverTime }` through the command pipeline.
3. The agent re-locks when its lease lapses. Every `heartbeat_ack` renews it:
   `leaseSeconds` = the shorter of the remaining reservation window and `SESSION_LEASE_CAP_S`
   for a logged-in, open session of this station; `0` otherwise. If a renewal cannot be
   computed, the lease already granted is re-sent unextended.
4. The session goes `ACTIVE` (reservation `CONFIRMED` to `ACTIVE`) only when the agent reports
   `locked=false`, never from the UNLOCK ack.
5. `state_report` with a `sessionId`: an open in-window session gets a fresh UNLOCK + lease; a
   session past its window is settled and ended (`END_SESSION`); any other is ended.
6. A sweep (`SESSION_SWEEP_INTERVAL_MS`) marks a booking `NO_SHOW` once its PIN reaches the
   no-show deadline unused (its session is cancelled and the PC is free again), and settles
   open sessions past their window. It sends `END_SESSION` only if the station still runs that
   very session. Settlement moves the reservation to `COMPLETED`.
7. A station going OFFLINE pauses its ACTIVE session at its last heartbeat (`lockReason
   'offline'`); it resumes when the station reports itself unlocked again.

---

## 4. Presence (node tracking)

`PresenceService` owns ONLINE / OFFLINE. Three stores, each with a job:

| Store | Content | Written |
|---|---|---|
| Postgres `machines.status`, `last_seen`, `ip_address`, `name` | Authoritative status | On connect / disconnect, and `last_seen` at most every `PRESENCE_PERSIST_INTERVAL_MS` (15 s) |
| Redis hash `node:<serial>` | `status, lastSeen, ip, locked, sessionId, runningGameId, leaseExpiresAt` | On every change and heartbeat. A Redis failure is logged, never fatal |
| In-memory map | Live state scanned by the watchdog | Always |

Transitions:

- **ONLINE**: handshake accepted.
- **OFFLINE, immediately**: socket closed (clean stop, killed process: the OS closes TCP).
- **OFFLINE, watchdog**: no heartbeat for `PRESENCE_OFFLINE_AFTER_MS` (45 s),
  checked every `PRESENCE_WATCHDOG_INTERVAL_MS` (10 s). Covers cable pulled, power loss.
  A heartbeat on the same socket flips it back to ONLINE.
- **Stale rows**: rows left ONLINE by a previous server process are set OFFLINE by the watchdog.

Every ONLINE/OFFLINE change and every change in `locked`, `sessionId` or
`runningGameId` is emitted on `presence.statusChanges` and pushed to dashboards as
`station_status`.

**Session end.** When a station that had a `sessionId` reports none, presence emits
`presence.sessionEnded` (`{ machineId, branchId, serialNumber, sessionId, reason, endedAt }`).
`reason` is the END_SESSION reason when one was issued in the previous 2 minutes, else
`agent_reported`. Billing close-out subscribes to this event; it is not handled here.

---

## 5. Remote commands

### 5.1 REST

| Method and path | Scope | Purpose |
|---|---|---|
| `POST /api/v1/stations/:id/commands` | staff+ (SHUTDOWN: admin+, i.e. MANAGER and ADMIN) | Issue a command |
| `GET /api/v1/stations/:id/commands?limit=20` | staff+ | Recent commands of a station |
| `GET /api/v1/commands/:commandId` | staff+ | One command |

Body:

```json
{ "type": "UNLOCK" }
{ "type": "LAUNCH_GAME", "gameId": "notepad" }
{ "type": "END_SESSION", "reason": "staff_end" }
```

| type | Payload on the wire | Notes |
|---|---|---|
| `LOCK` | `{}` | |
| `UNLOCK` | `{}` over REST; `{ sessionId, leaseSeconds, serverTime }` on the wire | A staff UNLOCK resumes the station's own open session: the backend fills in its session and lease. It never carries a PIN |
| `SHUTDOWN` | `{}` | A session on the station is settled up to now first. The agent's power-off is currently a stub that only logs |
| `LAUNCH_GAME` | `{ gameId }` | The catalog's wire `gameId`. The agent launches from its synced catalog; no path goes on the wire |
| `END_SESSION` | `{ reason? }` | The agent stops the tracked game, ends the session and locks. No separate stop command |
| `CATALOG_UPDATE` | `{}` | The agent re-pulls `GET /stations/me/games`. Also sent automatically (§6) |

### 5.2 Checks before anything is queued

A rejected request creates no COMMAND row.

| Code | When |
|---|---|
| 403 `INSUFFICIENT_SCOPE` | SHUTDOWN below admin scope |
| 409 `STATION_OFFLINE` | Station not ONLINE or no live socket |
| 409 `STATION_NOT_IN_SESSION` | LAUNCH_GAME while locked or without a session |
| 404 `GAME_NOT_FOUND`; 409 `GAME_DISABLED`, `GAME_NOT_ASSIGNED`, `GAME_STATUS_UNKNOWN` (no `catalog_status` yet), `GAME_NOT_INSTALLED` | LAUNCH_GAME catalog checks |
| 409 `NO_ACTIVE_SESSION` | END_SESSION without a session |
| 409 `NO_SESSION_TO_UNLOCK` | UNLOCK on a station with no open session of its own |
| 409 `INSUFFICIENT_FUNDS` | UNLOCK of a session locked because the money ran out, while the wallet still can't cover the minimum play time |
| 400 `SIMULATION_DISABLED` | `simulate` used in production |

### 5.3 Lifecycle

```text
POST ─► PENDING ─(BullMQ worker sends on socket)─► SENT ─┬─ command_ack ─────────────► ACKED
                                                         ├─ nack UNKNOWN_TYPE /
                                                         │  INVALID_PAYLOAD /
                                                         │  EXEC_FAILED ─────────────► FAILED
                                                         ├─ nack STALE (or unknown) ─► NACKED
                                                         └─ no reply in time ─ retry ─► TIMEOUT
```

- `ACKED` means the agent **accepted** the command, not that the effect is visible.
  Lock state, session and running game only come from heartbeats and state reports.
- Ack timeout `COMMAND_ACK_TIMEOUT_MS` (10 s), up to `COMMAND_MAX_ATTEMPTS` (2),
  `COMMAND_RETRY_BACKOFF_MS` between them. A retry reuses the same `commandId`.
- Nacks are never retried.
- A late reply still overrides `TIMEOUT`: the agent did act.
- No live socket at send time: `COMMAND_OFFLINE_STATUS` (default `FAILED`).
- Every status change is compare-and-set in Postgres and pushed as `command_update`.

### 5.4 Dev-only fault injection

`"simulate"` in the body, refused when `NODE_ENV=production`:

| Value | Effect |
|---|---|
| `stale_ts` | Frame `ts` backdated 10 min. Agent nacks `STALE` → `NACKED` |
| `duplicate_send` | Same command id sent twice. Agent runs it once and re-acks |
| `invalid_payload` | LAUNCH_GAME with empty `gameId`. Agent nacks `INVALID_PAYLOAD` → `FAILED` |
| `exec_failed` | LAUNCH_GAME for an id in no catalog. Agent nacks `EXEC_FAILED` → `FAILED` |

---

## 6. Game catalog

- `Game` is the global catalog (`gameId` wire id, `launchType` exe / steam / epic,
  `target`, `arguments`, `workingDirectory`, `processName`, `enabled`).
- A game reaches a station through a **branch assignment** (`GameBranch`) or a
  **station assignment** (`MachineGame`, which may override `target`, `arguments`,
  `workingDirectory`).
- The agent pulls `GET /stations/me/games` (station token) on every (re)connect and
  on `CATALOG_UPDATE`. The response is already resolved for that machine.
- After each sync the agent sends `catalog_status`: the only truth about what is
  installed. LAUNCH_GAME is refused up front for a game not reported as installed.
- Any catalog or assignment change emits `games.catalogChanges`; `CommandsService`
  then sends one `CATALOG_UPDATE` to each affected online station (skipped if one is
  already open). Offline stations sync on their next connect.
- `runningGameId` updates only from `state_report`, which the agent sends on
  reconnect, not on heartbeat.

Staff REST (`api/v1`): `GET games` (self+), `POST games`, `PATCH games/:id`,
`PUT|DELETE games/:id/branches/:branchId`, `PUT|DELETE games/:id/stations/:stationId`
(admin+), `GET stations/:id/games` (staff+: resolved catalog plus last `catalog_status`).

---

## 7. Telemetry and alerts

- `telemetry` samples are cached in Redis (`TELEMETRY_CACHE_TTL_S`), pushed live as
  `telemetry_update`, and snapshotted to `NodeTelemetry` every
  `TELEMETRY_HISTORY_INTERVAL_MS` (kept `TELEMETRY_HISTORY_RETENTION_HOURS`).
- Crossing `CPU_TEMP_THRESHOLD_C` (85) or `GPU_TEMP_THRESHOLD_C` (90) raises a
  hardware alert. The agent also raises its own alerts (`alert` frame).
- REST: `GET /api/v1/stations/:id/telemetry`, `GET /api/v1/stations/:id/telemetry/history`, `GET /api/v1/alerts`,
  `POST /api/v1/alerts/:id/resolve` (staff+).
- Dashboard events: `telemetry_update`, `alert`, `alert_resolved`.

---

## 8. Dashboard feed (`/dashboard-io`)

socket.io on path `/dashboard-io`. Authenticate with a **user** access token in
`auth.token` (or the `token` query).

- Staff with a branch join `branch:<branchId>`; HQ (no branch) joins `branch:all` and
  sees every branch. Staff with no branch join nothing.
- A gamer joins only `user:<userId>` (`publishToUser`).

Branch events: `station_status`, `catalog_status`, `telemetry_update`, `alert`,
`alert_resolved`, `command_update`, `peripheral_status`.
Gamer events: `session_runout_warning`, `session_notice`.

Staff REST for stations: `GET /api/v1/stations` (the Postgres rows merged with the
Redis presence cache, scoped to the caller's branch), `GET /api/v1/stations/:id` (with
`peripherals` and `peripheralsReportedAt`), `PATCH /api/v1/stations/:id { name }`
(manager and up: a rename sticks, the agent's own name only fills an empty one) and
`GET /api/v1/stations/:id/telemetry/history?hours=` (1 to 48).

---

## 9. Known limitations

| Limitation | Impact |
|---|---|
| No token revocation list | `enrollmentStatus` and `credentialVersion` are the revocation. Use them |
| `AgentRegistry` is in memory | One backend instance only. A second instance splits agents across two registries |
| Docker Desktop NATs inbound traffic | In dev, the IP column shows Docker's gateway (`172.x`, `192.168.65.x`), not the PC |
| Agent SHUTDOWN is a stub | The command acks but the PC stays on |
| `runningGameId` only on reconnect | The dashboard shows `-` after a launch until the agent reconnects |

---

## 10. Configuration

| Variable | Default | Meaning |
|---|---|---|
| `JWT_ACCESS_SECRET` | required | Signs user access tokens **and** station tokens |
| `PRESENCE_OFFLINE_AFTER_MS` | 45000 | Heartbeat silence before OFFLINE |
| `PRESENCE_WATCHDOG_INTERVAL_MS` | 10000 | Watchdog sweep period |
| `PRESENCE_PERSIST_INTERVAL_MS` | 15000 | Max `last_seen` write rate to Postgres |
| `COMMAND_ACK_TIMEOUT_MS` | 10000 | Wait for ack (max 25000, under BullMQ's job lock) |
| `COMMAND_MAX_ATTEMPTS` | 2 | Sends per command (1 to 5) |
| `COMMAND_RETRY_BACKOFF_MS` | 1000 | Delay between attempts |
| `COMMAND_OFFLINE_STATUS` | FAILED | Final status when no socket at send time |
| `CPU_TEMP_THRESHOLD_C` / `GPU_TEMP_THRESHOLD_C` | 85 / 90 | Hardware alert thresholds |
| `TELEMETRY_CACHE_TTL_S` | 30 | Redis TTL of live telemetry |
| `TELEMETRY_HISTORY_INTERVAL_MS` / `TELEMETRY_HISTORY_RETENTION_HOURS` | 60000 / 48 | Telemetry history |
| `NO_SHOW_GRACE_MINUTES` | 30 | The PIN's deadline after the booking's start; then NO_SHOW |
| `SESSION_MIN_PLAY_MINUTES` | 5 | A login needs the balance for this much play |
| `SESSION_PIN_MAX_ATTEMPTS` | 5 | Wrong PINs before it is burned |
| `SESSION_LEASE_CAP_S` | 180 | Longest lease per heartbeat_ack |
| `SESSION_ENDING_NOTICE_MINUTES` | 10 | TIME_LEFT notice before the end |

Migrations for this part: `20260924120000_machine_presence`,
`20260926120000_telemetry_alerts`, `20260926180000_station_commands`,
`20260926200000_games_catalog`, `20260927120000_station_game_catalog`, and from the flow
fixes `20260930220000_station_credentials_and_peripherals` and
`20261001090000_session_pin_cipher` (all of them: `FLOW_FIXES.md` §0).

---

## 11. Connecting a real agent (dev)

The station needs an ENROLLED MACHINE row and a station JWT. Until enrollment ships,
create both by hand (see [ENROLLMENT_HANDOFF.md §6](ENROLLMENT_HANDOFF.md#6-until-enrollment-ships-manual-provisioning)).

The agent defaults to `wss://127.0.0.1:8443/agent-ws`, but Caddy serves port **443**
and only the names `localhost` and `cstam-server.local` (an IP sends no TLS SNI and
fails). Point the agent at a served name with environment variables:

```powershell
# same PC as Docker
$env:Agent__ServerUrl = "wss://localhost/agent-ws"
# other PC on the LAN: hosts entry "<server ip>  cstam-server.local" on the gaming PC,
# inbound 443 open on the server PC
$env:Agent__ServerUrl = "wss://cstam-server.local/agent-ws"
# debugging only, skips TLS
$env:Agent__ServerUrl = "ws://localhost:3000/agent-ws"

$env:Agent__SerialNumber = "STATION-DEV-01"   # must equal the token's serialNumber
dotnet run
```

Expected backend log: `agent connected: STATION-DEV-01 [machine <id>, branch <id>] (...)`,
then `served catalog to STATION-DEV-01`.

Troubleshooting:

| Symptom | Cause |
|---|---|
| Upgrade refused, HTTP 401 | Missing, invalid or expired station JWT |
| Close 1008 `station not enrolled` | No MACHINE row for the token's `sub`, or not ENROLLED |
| Close 1008 `station token does not match the station` | Row's serial or branch changed after the token was minted |
| Close 1008 `serial number does not match station token` | `Agent__SerialNumber` differs from the token |
| Close 4408 after 10 s | No handshake reached Nest |
| Close 4400 | Envelope or handshake payload rejected, often a clock skew over 30 s |
| Agent loops on `Connection lost or could not be established` | Wrong URL, port or host name (see above) |

---

## 12. Tests

```powershell
npm test          # unit: presence admission, station token, commands
npm run test:int  # e2e in the backend container (stack up): realtime, commands, telemetry
```

| File | Covers |
|---|---|
| `src/modules/station/services/presence.service.spec.ts` | Admission rule, ONLINE/OFFLINE, watchdog, session end |
| `src/modules/station/services/station-token.service.spec.ts` | Token verification: claims, expiry, user vs station |
| `src/modules/ops/services/commands.spec.ts` | Command checks, transitions, nack mapping |
| `test/realtime.e2e-spec.ts` | `/agent-ws` upgrade, 401 / 1008 cases, handshake, presence, dashboard events (staff get their branch's; a gamer only their own `user:<id>` events) |
| `test/commands.e2e-spec.ts` | Command REST, delivery, ack / nack / timeout; a staff UNLOCK with no session on the station is refused (`NO_SESSION_TO_UNLOCK`) and never sent |
| `test/telemetry.e2e-spec.ts` | Telemetry ingest, alerts |
| `test/station-token.ts` | `mintStationToken()` helper: mints a token exactly as enrollment must |
