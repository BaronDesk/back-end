# Station agent: physical test plan

A manual test of the whole backend against a real BaronDesk desktop agent. You
act as the server operator: you send commands and run the gamer flow with the
station console, then check the effect on the gaming PC and in the backend.

| Part | Covers |
|---|---|
| §1 to §7 | The station itself: admission, presence, commands, catalog, fault injection, telemetry, dashboard feed |
| §8 to §12 | The business flow: users and roles, pricing, wallet, membership and subscription plans, reservation, session with PIN, metering, end and billing settlement |
| §13 | The full walkthrough in one run (start here for a quick smoke test) |

Reference for the protocol and the error codes: [STATION_AGENT.md](STATION_AGENT.md).

---

## 0. Setup

### 0.1 Backend

```powershell
npm run docker:dev          # stack up (backend, postgres, redis, caddy)
npm run docker:logs         # keep this open in a second terminal
```

The HQ admin comes from the seed (`hq-admin` / `change-me-immediately`, or
`SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD`).

### 0.2 Station

The real enrollment flow (`POST /enrollment/request`, admin approval) is not on
this branch. The console stands in for it, like the old `scripts/node-monitor.ts`
(`station-enroll`, `station-token`, `station-auth`): it writes the ENROLLED
MACHINE row and mints the station JWT exactly as enrollment must
([ENROLLMENT_HANDOFF.md §3](ENROLLMENT_HANDOFF.md#3-what-enrollment-must-produce)).

1. Start the console (§0.3). With no station yet, it offers the enrollment menu.
   Otherwise type `e`.
2. `1` enroll a station: serial `STATION-DEV-01`, status `ENROLLED`, pick the branch
   (it creates `Dev branch` if there is none). Answer `y` to mint the token.
3. The console prints the token and the PowerShell lines to paste on the gaming PC
   (`Agent__ServerUrl`, `Agent__SerialNumber`, `Agent__StationToken`, `dotnet run`).
   Details: [STATION_AGENT.md §11](STATION_AGENT.md#11-connecting-a-real-agent-dev).
4. Backend log must show `agent connected: STATION-DEV-01 ...` and
   `served catalog to STATION-DEV-01`.

The console needs Docker for this (it runs `psql` and reads `JWT_ACCESS_SECRET`
from the backend container), so start it from the repo root.

### 0.3 Station console

```powershell
node scripts/station-console.mjs
# optional
$env:BASE_URL = "http://localhost:3000"
$env:CONSOLE_USER = "hq-admin"; $env:CONSOLE_PASS = "change-me-immediately"
$env:STATION_SERIAL = "STATION-DEV-01"
```

The console logs in, connects to `/dashboard-io`, and prints live events for the
selected station: `[station_status]`, `[command_update]`, `[catalog_status]`,
`[alert]`, `[alert_resolved]` (`[telemetry_update]` is off by default, turn it on
with `f`). After each command it waits for the final status and prints
`=> <TYPE>: ACKED | NACKED | FAILED | TIMEOUT`.

`ACKED` only means the agent accepted the command. Check the real effect on the
PC and in the next `[station_status]` (lock, session and running game come from
heartbeats and state reports).

### 0.4 Useful SQL (`npm run db:psql`)

```sql
SELECT id, serial_number, branch_id, enrollment_status, status, last_seen, ip_address FROM machines;
SELECT type, status, attempts, nack_code, nack_reason, failure_reason, issued_at
  FROM commands ORDER BY issued_at DESC LIMIT 10;
```

### 0.5 Result sheet

Mark each case **P** (pass) or **F** (fail) and note what you saw.

---

## 1. Enrollment, connection and admission

### 1.a Automated admission cases (console `e`, `4`)

Runs against `/agent-ws` and `GET /stations/me/games` and prints PASS/FAIL per
line. It flips the row's `enrollment_status` and restores it at the end. It
never handshakes with the real station's valid token, so the real agent stays
connected, except while the row is not ENROLLED (it is refused and reconnects).

| Case | Checks | P/F |
|---|---|---|
| a | ENROLLED + valid token: socket stays open, catalog 200 | |
| b | PENDING / INACTIVE / DEACTIVATED: socket closed 1008, catalog 403. Back to ENROLLED: open again | |
| c | Valid signature, no MACHINE row: 1008 on upgrade and handshake, catalog 403, no row created | |
| d | Token branch differs from the row: 1008 / 401. Handshake serial differs from the token: 1008 | |
| e | No token, `?serialNumber=` or `x-station-serial` only, garbage, expired or user token: 401. No row auto-created | |

Result line: `all passed`, or the number of failures.

### 1.b With the real agent

| # | Action | Expected on server | Expected on PC | P/F |
|---|---|---|---|---|
| 1.1 | Start the agent with a valid token | Log `agent connected`, `served catalog`. Console: `[station_status] ONLINE`, then `[catalog_status]`. `s` shows `ONLINE`, `lastSeen` moves, `ip` set | Agent log: handshake acked, catalog synced | |
| 1.2 | Stop the agent, clear `Agent__StationToken`, start it | Upgrade refused with HTTP 401, no `agent connected` | Agent loops on connection errors | |
| 1.3 | Start with a tampered token (change 1 char) | HTTP 401 | Same as 1.2 | |
| 1.4 | Valid token, `Agent__SerialNumber` = another value | Close 1008 `serial number does not match station token` | Agent reports the close and retries | |
| 1.5 | Console `e`, `3`: set `INACTIVE` (revoke), then restart the agent | Close 1008 `station not enrolled`. Station stays OFFLINE | Agent cannot connect | |
| 1.6 | Same as 1.5 while the agent is connected (do not restart) | Socket stays open (known limitation, STATION_AGENT §9). Next reconnect is refused | Agent keeps working until it reconnects | |
| 1.7 | `e`, `3`: set back `ENROLLED`, restart agent | Connects again (1.1) | Normal | |
| 1.10 | `e`, `2`: mint a token valid `0` days (already expired), give it to the agent | HTTP 401 | Agent loops on connection errors | |
| 1.11 | `e`, `1`: enroll a second serial `STATION-DEV-02`, mint its token, give it to the agent with `Agent__SerialNumber = STATION-DEV-02` | Connects as a new station. `p` lists both | Normal | |
| 1.12 | `e`, `5`: agent's view of the catalog | 200 with the station's resolved games (same as what the agent syncs) | - | |
| 1.8 | Start a second agent process with the same token and serial (or a test client) | Old socket closed 4000, new one registered | First agent reports replaced connection | |
| 1.9 | Change the PC clock 2 minutes ahead, restart agent | Frames dropped (`ts_out_of_window`) or close 4400 | Agent cannot hold a session | |

Reset the PC clock after 1.9.

---

## 2. Presence

| # | Action | Expected on server | Expected on PC | P/F |
|---|---|---|---|---|
| 2.1 | Agent running, idle 1 minute | `s`: `ONLINE`, `lastSeen` updates. No `OFFLINE` | - | |
| 2.2 | Stop the agent cleanly | `[station_status] OFFLINE` at once | - | |
| 2.3 | Kill the agent process (Task Manager, End task) | `[station_status] OFFLINE` at once (OS closes TCP) | - | |
| 2.4 | Start agent, then pull the network cable / disable Wi-Fi | `[station_status] OFFLINE` after 45 to 55 s (watchdog) | - | |
| 2.5 | Plug the network back | Agent reconnects: `ONLINE`, `state_report` fields in `[station_status]` | Agent reconnects on its own | |
| 2.6 | Restart the backend (`npm run docker:up` after a stop) with agent running | Agent reconnects. Rows left ONLINE by the old process are fixed by the watchdog | Agent reconnects on its own | |

---

## 3. Remote commands (console main menu)

Start each case from the state named in the "Start" column.

| # | Start | Console action | Expected result | Expected on PC | P/F |
|---|---|---|---|---|---|
| 3.1 | Unlocked | `1` LOCK | `ACKED`. `[station_status] locked=true` | Lock screen (LockUI) covers the desktop | |
| 3.2 | Locked | `1` LOCK again | `ACKED` (idempotent) | Stays locked, no second lock screen | |
| 3.3 | Locked | `2` UNLOCK (admin) | `ACKED`. `locked=false`, lease granted | Lock screen closes, desktop usable | |
| 3.4 | Locked | `3` UNLOCK booking, keep default sessionId, PIN `4821` | `ACKED`. `sessionId` set, `locked` stays `true` | LockUI asks for the PIN | |
| 3.5 | After 3.4 | Type a wrong PIN on the PC | No change on server | LockUI refuses, stays locked | |
| 3.6 | After 3.4 | Type `4821` on the PC | `[station_status] locked=false`, same `sessionId` | Desktop unlocks | |
| 3.7 | Unlocked, no session (after 3.3) | `4` LAUNCH_GAME `notepad` | 409 `STATION_NOT_IN_SESSION`. No command row (`c`) | Nothing | |
| 3.8 | Session active (after 3.6), game installed (§4) | `4` LAUNCH_GAME `notepad` | `ACKED` | Notepad opens | |
| 3.9 | Session active | `4` LAUNCH_GAME `does-not-exist` | 404 `GAME_NOT_FOUND` | Nothing | |
| 3.10 | Session active, game running | `5` END_SESSION reason `staff_end` | `ACKED`. `[station_status]` `sessionId=null`, `locked=true`. Backend emits `presence.sessionEnded` with reason `staff_end` (billing log) | Game closes, session ends, lock screen | |
| 3.11 | No session | `5` END_SESSION | 409 `NO_ACTIVE_SESSION` | Nothing | |
| 3.12 | Session active | End the session from the PC side (agent UI or lease expiry) | `sessionEnded` with reason `agent_reported` | Lock screen | |
| 3.13 | Any | `6` CATALOG_UPDATE | `ACKED`. Log `served catalog to ...`, then `[catalog_status]` | Agent re-syncs its catalog | |
| 3.14 | Any, logged in as ADMIN | `7` SHUTDOWN, confirm `y` | `ACKED` | Agent logs the shutdown. PC stays on (stub) | |
| 3.15 | Logged in as a STAFF user (not MANAGER/ADMIN) | `7` SHUTDOWN | 403 `INSUFFICIENT_SCOPE`. No command row | Nothing | |
| 3.16 | Agent stopped (OFFLINE) | `1` LOCK | 409 `STATION_OFFLINE`. No command row | - | |
| 3.17 | Any | `c` recent commands | Every command above with its final status, nack code and reason | - | |

For 3.15, create an EMPLOYEE with the console (`u`, `3`, case 8.3), then run a
second console with `CONSOLE_USER` / `CONSOLE_PASS` set to it.

### 3.x Delivery, retry and timeout

| # | Action | Expected result | P/F |
|---|---|---|---|
| 3.18 | Freeze the agent: Resource Monitor, CPU tab, right-click the agent process, **Suspend process**. Within 45 s send `1` LOCK | `SENT`, no ack for 10 s, second attempt (`attempts=2`, same commandId), then `TIMEOUT` | |
| 3.19 | **Resume process** right after 3.18 | If the agent still acks the command: status goes from `TIMEOUT` to `ACKED` (late reply wins). PC locks | |
| 3.20 | Kill the agent, then send a command in the ~1 s before `OFFLINE` shows (or stop it between queue and send) | Final status `FAILED` (`COMMAND_OFFLINE_STATUS`), reason names no live socket | |

---

## 4. Game catalog (console `g`)

Start: station ONLINE, session active and unlocked (3.4 + 3.6).

| # | Console action | Expected result | Expected on PC | P/F |
|---|---|---|---|---|
| 4.1 | `3` create game, `exe`, defaults (`notepad`, `C:\Windows\System32\notepad.exe`) | 201, game listed in `1` | Nothing yet (not assigned) | |
| 4.2 | `3` create game `exe` with target `notepad.exe` (not a full path) | 400, validation message about the full path | - | |
| 4.3 | `4` assign `notepad` to this station | 2xx. A `CATALOG_UPDATE` is sent on its own (`[command_update] CATALOG_UPDATE ACKED`), then `[catalog_status]` with `notepad installed=true` | Agent re-syncs | |
| 4.4 | `2` station catalog | `notepad` in the resolved list, and in the last `catalog_status` | - | |
| 4.5 | Main menu `4` LAUNCH_GAME `notepad` | `ACKED` | Notepad opens | |
| 4.6 | `3` create game `exe`, gameId `ghost`, target `C:\Games\Ghost\ghost.exe` (missing file), then `4` assign | `[catalog_status]` `ghost installed=false` with a reason | - | |
| 4.7 | LAUNCH_GAME `ghost` | 409 `GAME_NOT_INSTALLED` | Nothing | |
| 4.8 | `8` disable `notepad` | Automatic `CATALOG_UPDATE`. LAUNCH_GAME `notepad` gives 409 `GAME_DISABLED` | Agent re-syncs, game gone from its catalog | |
| 4.9 | `8` enable `notepad` again | Automatic `CATALOG_UPDATE`, launch works again | - | |
| 4.10 | `9` edit `notepad` field `arguments` = `C:\Windows\win.ini` | Automatic `CATALOG_UPDATE`. Next launch opens win.ini in Notepad | Notepad shows win.ini | |
| 4.11 | `5` unassign `notepad` from this station | Automatic `CATALOG_UPDATE`. LAUNCH_GAME gives 409 `GAME_NOT_ASSIGNED` | - | |
| 4.12 | `6` assign `notepad` to the branch (branchId prefilled once a `[station_status]` or `[command_update]` came in) | Automatic `CATALOG_UPDATE`. Launch works again | - | |
| 4.13 | `4` assign to station with override target `C:\Windows\System32\mspaint.exe`, then launch `notepad` | Paint opens instead of Notepad (station override wins) | Paint opens | |
| 4.14 | `7` unassign from branch, `5` unassign from station | Catalog empty for this game | - | |
| 4.15 | Stop the agent, change the catalog, start the agent | No CATALOG_UPDATE while offline. On connect: `served catalog`, then `[catalog_status]` with the change | Agent has the new catalog | |
| 4.16 | Steam game (`3`, `steam`, target `730`), assign, launch (Steam installed on PC) | `ACKED` | Steam starts the game | |
| 4.17 | New game, first launch before any `catalog_status` for it (send LAUNCH_GAME fast, or on a station that never synced) | 409 `GAME_STATUS_UNKNOWN` | - | |

---

## 5. Fault injection (console `8`, needs `NODE_ENV` not `production`)

| # | Simulation | Expected result | P/F |
|---|---|---|---|
| 5.1 | `stale_ts` with LOCK | `NACKED`, nack code `STALE`. PC does not lock | |
| 5.2 | `duplicate_send` with LOCK | `ACKED` once. Agent log shows the duplicate re-acked, action ran once | |
| 5.3 | `invalid_payload` | `FAILED`, `INVALID_PAYLOAD`, reason `gameId is required (1-128 characters).` | |
| 5.4 | `exec_failed` while locked | `FAILED`, `EXEC_FAILED`, reason "must be unlocked with an active session" | |
| 5.5 | `exec_failed` while unlocked with a session | `FAILED`, `EXEC_FAILED`, reason "not in catalog" | |
| 5.6 | Backend with `NODE_ENV=production`, any simulation | 400 `SIMULATION_DISABLED` | |

---

## 6. Telemetry and alerts

| # | Action | Expected result | P/F |
|---|---|---|---|
| 6.1 | Console `f`, turn on telemetry | `[telemetry_update]` lines with CPU, GPU, RAM metrics every few seconds | |
| 6.2 | Console `t` | Latest metrics for the station | |
| 6.3 | Wait over 1 minute, then `SELECT count(*) FROM node_telemetry;` | Count grows (one snapshot per minute) | |
| 6.4 | Load the CPU on the PC (stress tool, or a game) until CPU temp > 85 °C (or lower `CPU_TEMP_THRESHOLD_C` in `.env` and restart backend to test) | `[alert]` hardware / CPU temperature. Console `a` lists it as open | |
| 6.5 | Keep the load on | No new alert per sample: repeats fold into the open alert | |
| 6.6 | Unplug a USB device (mouse, keyboard) on the PC | `[alert]` from the agent (anti_theft / device category) | |
| 6.7 | Console `a`, resolve the alert by id | `[alert_resolved]`. `a` with `resolved` shows it | |
| 6.8 | Plug the device back, unplug again | New open alert | |

---

## 7. Dashboard feed and REST scope

| # | Action | Expected result | P/F |
|---|---|---|---|
| 7.1 | HQ admin console (no branch) | Events from every branch | |
| 7.2 | Console with a user of another branch | No events and 403/404 for this station | |
| 7.3 | `curl http://localhost:3000/api/v1/stations` (no token) | 401 | |
| 7.4 | Console `r` `POST /api/v1/stations/<id>/commands` body `{"type":"LOCK","gameId":"x"}` | 400 `gameId is only accepted for LAUNCH_GAME` | |
| 7.5 | `r` body `{"type":"UNLOCK","payload":{"sessionId":"not-a-uuid","pin":"1"}}` | 400 | |
| 7.6 | `r` body `{"type":"REBOOT"}` | 400 (type not allowed) | |
| 7.7 | `curl -k https://localhost/stations/me/games -H "Authorization: Bearer <station jwt>"` | 200, resolved catalog | |
| 7.8 | Same without the header / with a user token | 401 `MISSING_STATION_TOKEN` / `INVALID_STATION_TOKEN` | |
| 7.9 | Same with a valid token after `enrollment_status='INACTIVE'` | 403 `STATION_NOT_ENROLLED` | |

---

## 8. Users and roles (console `u`)

Roles map to scopes: GAMER = self, EMPLOYEE = staff, MANAGER = admin, ADMIN = hq.

| # | Console action | Expected result | P/F |
|---|---|---|---|
| 8.1 | `1` create gamer (default name, password `gamer-pass-123`) | 201. Console logs in as the gamer and prints its `gamerProfileId` (from `GET /wallets/me`) | |
| 8.2 | `1` again with the same username | 409 (username taken) | |
| 8.3 | `3` create EMPLOYEE for the station's branch | 201, `branchId` set. Note username / password for 3.15 and 8.6 | |
| 8.4 | `3` create MANAGER for the station's branch | 201 | |
| 8.5 | `6` gamer `/auth/me` | Role `GAMER`, scope `self` | |
| 8.6 | Second console as the EMPLOYEE: `m`, `2` create a membership plan | 403 (admin scope needed) | |
| 8.7 | Second console as the MANAGER: `u`, `3` create a MANAGER | 403 (a manager may only create EMPLOYEE, in its own branch) | |
| 8.8 | `4` change the EMPLOYEE to `GAMER`, then log in with it | Logs in, staff routes give 403 | |
| 8.9 | `r` raw request as HQ: `POST /employees` with an unknown `branchId` | 4xx, no user created | |

---

## 9. Branch pricing (console `b`)

`paygRate` and `bookingRate` are **cents per hour**. The session rate is
`round(paygRate * (1 - membership discount) / 60)` cents per minute.
The console suggests `6000` (60.00 per hour = 100 cents per minute) so one
minute of play is easy to see in the wallet.

| # | Console action | Expected result | P/F |
|---|---|---|---|
| 9.1 | `1` show pricing on a branch never priced | 404 `PRICING_NOT_SET` | |
| 9.2 | `6` start a session in that state (needs a reservation, §12) | 404 `PRICING_NOT_SET`. No session row (`l`) and no UNLOCK sent | |
| 9.3 | `2` set pricing `6000` / `6000` | 2xx. `1` shows the rates and `100 cents/minute` | |
| 9.4 | `2` set `paygRate` `0` or `12.5` | 400 | |
| 9.5 | Second console as EMPLOYEE: `b`, `2` | 403 (admin scope needed). `1` works (staff) | |

---

## 10. Wallet and ledger (console `w`)

Amounts are integer **cents**. A reused `idempotencyKey` must not post twice.

| # | Console action | Expected result | P/F |
|---|---|---|---|
| 10.1 | `1` gamer `GET /wallets/me` on a new gamer | Balance `0` (wallet created on first read) | |
| 10.2 | `3` credit `10000` | 2xx, entry `CREDIT +10000`, `balanceAfter 10000` | |
| 10.3 | `3` credit `500` with key `topup-1`, then again with `topup-1` | Second call posts nothing new: balance grows by 500 only once (`2`) | |
| 10.4 | `6` debit `200` | Entry `DEBIT -200`, balance down by 200 | |
| 10.5 | `6` debit more than the balance | 409 `INSUFFICIENT_FUNDS`. Balance unchanged | |
| 10.6 | `3` credit `0`, `-5` or `1.5` | 400 | |
| 10.7 | `4` / `5` staff view of the same wallet | Same balance and entries as the gamer view | |
| 10.8 | `r` raw request with the gamer: not possible from `r` (staff token). Use curl with the gamer token on `POST /wallets/<id>/credit` | 403 (staff scope needed) | |

---

## 11. Membership and subscription plans (console `m`)

Plan `price` is in currency units. A purchase debits `price x 100` cents from the
gamer's wallet. At most one ACTIVE membership per gamer. The membership
`discountPercent` (snapshot at purchase) lowers the session rate (§12).

| # | Console action | Expected result | P/F |
|---|---|---|---|
| 11.1 | `2` create membership plan `price 5`, `discountPercent 50`, `30` days | 201 | |
| 11.2 | `2` same name again | 409 (name unique) | |
| 11.3 | `5` gamer purchase, key `m-1`, wallet ≥ 500 | 2xx, membership ACTIVE. Wallet: `PAYMENT -500` | |
| 11.4 | `5` again with key `m-1` | Same membership returned. No second debit | |
| 11.5 | `5` again with another key (or none) | 409 `MEMBERSHIP_ALREADY_ACTIVE`. No debit | |
| 11.6 | New gamer with balance 0: `5` purchase | 409 `INSUFFICIENT_FUNDS`. No membership | |
| 11.7 | `m` gamer `GET /memberships/me` | The ACTIVE membership, with start / end dates and discount snapshot | |
| 11.8 | `3` update the plan `discountPercent 25` | 2xx. Existing membership keeps its 50% snapshot (check with the rate in 12.5) | |
| 11.9 | `4` delete a plan with memberships | Refused (plan in use) | |
| 11.10 | `4` delete an unused plan | 2xx | |
| 11.11 | `7` create subscription plan (default benefits: every day, 00:00 to 23:59, 20%) | 201 | |
| 11.12 | `7` with benefits `{"windows":[{"daysOfWeek":[9],"startTime":"25:00","endTime":"x","discountPercent":20}]}` | 400 | |
| 11.13 | `p` gamer purchase subscription (wallet ≥ price x 100) | 2xx, subscription ACTIVE, wallet debited | |
| 11.14 | `p` with balance too low | 409 `INSUFFICIENT_FUNDS` | |
| 11.15 | `s` gamer `GET /subscriptions/me` | The subscription with its benefits snapshot | |

---

## 12. Reservation, session and billing (console `b`)

Reservations have no REST route yet: the console inserts them with SQL
(`docker compose exec postgres psql`, so run the console from the repo root with
the stack up). If that fails, the console prints the SQL to run with
`npm run db:psql`.

How it fits together:

```text
POST /sessions {reservationId}
  -> session PENDING, rate fixed, PIN returned
  -> booking UNLOCK {sessionId, pin} sent to the station
PC shows the PIN prompt, gamer types the PIN
  -> heartbeat locked=false with sessionId -> session ACTIVE, metering starts
staff LOCK (or wrong state)      -> locked=true  -> PAUSED, metered seconds banked
staff UNLOCK                     -> locked=false -> ACTIVE again
POST /sessions/:id/end (or the agent ends it)
  -> END_SESSION command -> agent stops the game, clears the session, locks
  -> presence.sessionEnded -> settlement:
     COMPLETED, billingBreakdown, wallet PAYMENT -totalCents (key session-settlement:<id>)
```

Start: station ONLINE and locked, pricing `6000` (§9), gamer with wallet
`10000` and no membership (§8, §10).

| # | Console action | Expected result | Expected on PC | P/F |
|---|---|---|---|---|
| 12.1 | `3` create reservation, status `PENDING` | Reservation id printed | - | |
| 12.2 | `6` start session on it | 409 `RESERVATION_NOT_CONFIRMED`. No session | Nothing | |
| 12.3 | `6` with a random uuid | 404 `RESERVATION_NOT_FOUND` | Nothing | |
| 12.4 | `5` set it `CONFIRMED`, `6` start session | 201: session `PENDING`, `rateCentsPerMinute 100`, **PIN** printed. `[command_update] UNLOCK ... ACKED` | PIN prompt on the lock screen | |
| 12.5 | `6` again on the same reservation | 409 `SESSION_ALREADY_STARTED` | Nothing | |
| 12.6 | `7` show session before the PIN | `PENDING`, `metered=0` | Still locked | |
| 12.7 | Type a wrong PIN on the PC | Session stays `PENDING` | Refused, stays locked | |
| 12.8 | Type the right PIN, then `8` watch session | `ACTIVE` within one heartbeat. `[station_status] locked=false sessionId=<session id>` | Desktop unlocked | |
| 12.9 | Main menu `4` LAUNCH_GAME `notepad` | `ACKED` | Notepad opens | |
| 12.10 | Play 2 minutes, main menu `1` LOCK, `7` show session | `PAUSED`, `lockedAt` set, `metered` ≈ 120 s | Lock screen | |
| 12.11 | Wait 1 minute locked, `7` | `metered` unchanged (no billing while locked) | - | |
| 12.12 | Main menu `2` UNLOCK (admin), wait 1 minute, `7` | `ACTIVE` again, `lockedAt` cleared, metering restarted | Desktop unlocked, same session | |
| 12.13 | `9` end session, reason `staff_end`, then `8` watch | `[command_update] END_SESSION ACKED`, then `COMPLETED`, `settledAt` set, `billingBreakdown` `{ rateCentsPerMinute: 100, meteredSeconds: ≈180, totalCents: ≈300, appliedMembershipId: null }` | Game closes, session ends, lock screen | |
| 12.14 | `w`, `2` gamer ledger | `PAYMENT -totalCents` with `sessionId` = the session, balance `10000 - totalCents` | - | |
| 12.15 | `9` end the same session again | 409 `SESSION_NOT_OPEN` | Nothing | |
| 12.16 | `l` list sessions | The session `COMPLETED` with its breakdown | - | |

Check the numbers: `totalCents = round(meteredSeconds / 60 * rateCentsPerMinute)`.

### 12.x Billing variants

Each variant needs a new CONFIRMED reservation (`3`) and a new session (`6`).

| # | Setup / action | Expected result | P/F |
|---|---|---|---|
| 12.17 | Gamer with an ACTIVE 50% membership (§11.3), start session | `rateCentsPerMinute 50`. Breakdown `appliedMembershipId` = the membership | |
| 12.18 | After 11.8 (plan changed to 25%), start a session for the same gamer | Still `50` per minute (snapshot at purchase) | |
| 12.19 | Gamer with an ACTIVE subscription and no membership | Rate is the full `paygRate`: subscription windows are not applied to sessions yet (see §14). Note what you see | |
| 12.20 | Gamer wallet `0`, play 1 minute, end | Session still `COMPLETED`. Breakdown has `debitFailed: true`. No PAYMENT entry | |
| 12.21 | Start, type PIN, then end the session from the PC side (agent UI, or let the lease expire) | `COMPLETED` with settlement. Backend log shows reason `agent_reported` | |
| 12.22 | Start, type PIN, then main menu `5` END_SESSION (command, not REST) | Same settlement as 12.13: billing follows the station, not the route | |
| 12.23 | Start a session, never type the PIN, end it with `9` | Allowed while `PENDING`: `COMPLETED`, `meteredSeconds 0`, `totalCents 0`, no ledger entry | |
| 12.24 | Stop the agent, then `6` start a session | 201 with PIN, session `PENDING`, backend log `booking UNLOCK not sent`. Start the agent, then main menu `3` booking UNLOCK with this session id and PIN: PIN prompt appears, flow continues as 12.8 | |
| 12.25 | During an ACTIVE session, kill the agent (Task Manager) | Station OFFLINE. Session state after restart: note whether it stays `ACTIVE` (metering keeps counting) or ends. Report it | |
| 12.26 | During an ACTIVE session, stop the backend 1 minute, start it again | Session keeps its state. Check `meteredSeconds` at the end | |
| 12.27 | Two sessions in a row for the same gamer (new reservation each) | Two PAYMENT entries, each with its own `sessionId` | |

---

## 13. Full walkthrough (smoke test, about 10 minutes)

One run through every part. Stop at the first failure and note the step.

1. Start the stack. Console: `node scripts/station-console.mjs`. `e`, `1`: enroll `STATION-DEV-01` and mint its token. `e`, `4`: admission cases `all passed`. Start the agent with the printed lines, pick the station.
2. `[station_status] ONLINE`, `[catalog_status]` arrive.
3. `u`, `1`: create a gamer. Note the `gamerProfileId`.
4. `b`, `2`: pricing `6000` / `6000`.
5. `w`, `3`: credit `10000`. `w`, `1`: balance `10000`.
6. `m`, `2`: membership plan price `5`, discount `50`. `m`, `5`: purchase. Wallet `9500`.
7. `g`, `3` then `4`: create `notepad` and assign it to the station. `[catalog_status]` `notepad installed=true`.
8. `1` LOCK: PC locked.
9. `b`, `3`: CONFIRMED reservation. `b`, `6`: start session, rate `50`, note the PIN.
10. Type the PIN on the PC: desktop unlocks. `b`, `7`: `ACTIVE`.
11. `4` LAUNCH_GAME `notepad`: Notepad opens.
12. Wait 2 minutes. `1` LOCK: `PAUSED`, about 120 s metered.
13. `2` UNLOCK. Wait 1 minute.
14. `b`, `9` end session. `b`, `8` watch: `COMPLETED`, `totalCents` about 150.
15. `w`, `2`: `PAYMENT -150` (about) with the session id. Balance about `9350`.
16. `t` telemetry and `a` alerts answer. `c` shows every command `ACKED`.

---

## 14. Known limitations (not failures)

- SHUTDOWN is a stub on the agent: the PC stays on.
- `runningGameId` only updates on reconnect (`state_report`), so it shows `-`
  after a launch until the agent reconnects.
- Deactivating a station does not close its open socket.
- In dev on Docker Desktop, `ip` shows the Docker gateway, not the PC.
- Reservations have no REST route: created with SQL for this test.
- Starting or ending a session does not change the reservation's status.
- Subscription benefit windows are not applied to the session rate; only the
  membership discount is.
- No run-out timer yet: a session keeps metering when the wallet cannot cover it.
  The shortfall only shows as `debitFailed: true` at settlement.
- A session started while the station is offline stays `PENDING`, and a second
  `POST /sessions` is refused (`SESSION_ALREADY_STARTED`). Resend the booking
  UNLOCK by hand (12.24).
