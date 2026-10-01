# Station agent: physical test plan

A manual test of the whole backend against a real BaronDesk desktop agent. You
drive the backend with the **station console**, a command palette: log in as any
profile, run any command it is allowed to run, in any order, and check the effect
on the gaming PC and in the backend.

| Part | Covers |
|---|---|
| §0 | Setup, prerequisites, the console |
| §1 | The palette: commands per profile, identity switching, observer |
| §2 | Enrollment (real flow), admission cases |
| §3 to §7 | The station: presence, commands, catalog, fault injection, telemetry and alerts |
| §8 to §13 | Scoping and the business flow: users, pricing, wallet, plans, reservation, session with PIN, run-out, billing |
| §14 | Full walkthrough in one run (start here for a quick smoke test) |

Reference for the protocol and the error codes: [STATION_AGENT.md](STATION_AGENT.md).
Enrollment design: [ENROLLMENT_HANDOFF.md](ENROLLMENT_HANDOFF.md).

---

## 0. Setup

### 0.1 Prerequisites

- Stack up, seeded: `npm run docker:dev`, then keep `npm run docker:logs` open in a second terminal.
- Seed data the console relies on: the HQ admin (`hq-admin` / `change-me-immediately`, or
  `SEED_ADMIN_USERNAME` / `SEED_ADMIN_PASSWORD`), the branches, their pricing, and the
  seed staff and gamers (`manager.manar`, `employee.manar1`, `gamer.wood`, ... password
  `password123`). Machines and tokens are **not** taken from the seed: they are created
  through the enrollment API (§2).
- **The desktop agent must run elevated (Run as administrator) or as the SYSTEM service.**
  It stores its station credential with DPAPI in machine scope and cannot read it
  otherwise: a non-elevated agent fails to load its credential and tries to enroll again.
- Node 18+ on the machine that runs the console (it uses the built-in `fetch`).
- The negative admission cases (§2.4) need Docker and the repo root as the working
  directory: they run `psql` in the postgres container and read `JWT_ACCESS_SECRET`
  from the backend container.

### 0.2 Start the console

```powershell
node scripts/station-console.mjs
# optional
$env:BASE_URL = "http://localhost:3000"
$env:CONSOLE_USER = "hq-admin"; $env:CONSOLE_PASS = "change-me-immediately"
$env:CONSOLE_USER = ""          # start logged out
```

The console logs in as `CONSOLE_USER`, then shows the palette. Type a number to run
a command. Each command asks for its inputs (defaults in brackets, Enter keeps them),
makes one call, and prints the request and the full response:

```text
-> POST /sessions {"reservationId":"6c1f..."}  (hq-admin)
<- 201
{ "id": "...", "status": "PENDING", "rateCentsPerMinute": 100, "pin": "482193", ... }
```

The console holds no business logic. It never decides whether a call should work:
the backend answers, and the console prints the answer.

### 0.3 Top-level keys

| Key | Action |
|---|---|
| number | Run that command |
| `h` or Enter | Show the palette |
| `/text` | Palette filtered by text (for example `/wallet`) |
| `l` | Login as: pick a saved identity, or log in as a new one |
| `s` | Swap to the previous identity (one key) |
| `o` | Observer on / off (`/dashboard-io`, §1.3) |
| `t` | Show / hide `telemetry_update` frames in the observer |
| `v` | Show / hide the commands above your scope (greyed, with "requires ...") |
| `c` | Remembered ids (the prompt defaults) |
| `r` | Raw request: any method, path, body, with the active token, no token, or a stand-in station token |
| `q` | Quit |

Ids from the last responses (station, branch, reservation, session, command, plan,
gamerProfileId, enrollment token) become the defaults of the next prompts, so a
flow runs with Enter most of the time. `c` lists them.

### 0.4 Useful SQL (`npm run db:psql`)

```sql
SELECT id, serial_number, branch_id, enrollment_status, status, last_seen FROM machines ORDER BY created_at DESC;
SELECT id, branch_id, machine_id, consumed_at, expires_at FROM enrollment_tokens ORDER BY created_at DESC LIMIT 5;
SELECT type, status, attempts, nack_code, nack_reason, failure_reason, issued_at FROM commands ORDER BY issued_at DESC LIMIT 10;
```

`enrollment_tokens` stores `token_hash` (sha256 hex of the token), never the token.

### 0.5 Result sheet

Mark each case **P** (pass) or **F** (fail) and note what you saw.

---

## 1. The palette

### 1.1 Commands per profile

The profile's role gives its scope: GAMER = self, EMPLOYEE = staff, MANAGER = admin,
ADMIN = hq. The palette lists a command only when the scope meets the command's
minimum (the `@RequireScope` of its route). Numbers never change between profiles.

| Group | # | Command | Min |
|---|---|---|---|
| Secure Access | 1 | login as another profile | public |
| | 2 | whoami `GET /auth/me` | self |
| | 3 | refresh tokens `POST /auth/refresh` | self |
| | 4 | logout `POST /auth/logout` | self |
| | 5 | register a gamer `POST /users` (asks the home `branchId`) | public |
| | 6 | create EMPLOYEE / MANAGER `POST /employees` | admin |
| | 7 | change role `PATCH /users/:id/role` | admin |
| | 8 | get a user `GET /users/:id` | self |
| Node Tracking | 9, 10 | list / get stations `GET /api/v1/stations[/:id]` | staff |
| | 11, 12 | list / get machines `GET /machines[/:id]` | staff |
| | 13 | same GET as every logged-in identity (branch scoping) | self |
| Station Provisioning | 14 | mint one-time enrollment token `POST /machines/enrollment-tokens` | admin |
| | 15 | stand-in: redeem a token `POST /enrollment/request` | public |
| | 16, 17, 18 | approve / reject / revoke `POST /machines/:id/...` | admin |
| | 19 | rotate credential `POST /machines/:id/rotate-token` | admin |
| | 20 | stand-in: provision end to end | admin |
| | 21 | stand-ins: list | public |
| | 22 | negative admission cases (forgeries) | admin |
| Games Catalog | 23 | list games `GET /api/v1/games` | self |
| | 24, 25 | create / update game | admin |
| | 26, 27 | attach / detach to branch | admin |
| | 28, 29 | attach / detach to station | admin |
| | 30 | station's games `GET /api/v1/stations/:id/games` | staff |
| | 31 | agent catalog pull `GET /stations/me/games` | station token |
| Remote Admin | 32 | send command `POST /api/v1/stations/:id/commands` | staff |
| | 33, 34 | list / get commands | staff |
| Telemetry & Anti-Theft | 35 | station telemetry | staff |
| | 36, 37 | list / resolve alerts | staff |
| Session & Financial Control | 38, 39, 40 | create (PIN) / get / end session | staff |
| Electronic Wallet | 41, 42 | my wallet / my ledger | self |
| | 43, 44 | wallet / ledger of a gamer | staff |
| | 45, 46 | credit / debit | staff |
| Subscription & Membership | 47, 53 | list membership / subscription plans | self |
| | 48 to 50, 54 to 56 | create / update / delete plans | admin |
| | 51, 57 | my memberships / my subscriptions | self |
| | 52, 58 | buy a membership / subscription | self |
| Advance Reservation | 59 to 62 | my reservations, book ahead, walk-in, cancel | self |
| Multi-Agency & Pricing | 63 | branch pricing `GET /branches/:branchId/pricing` | staff |
| | 64 | set branch pricing `PUT` | admin |

What each profile sees:

| Profile (scope) | Sees |
|---|---|
| Logged out | Login, register a gamer, stand-in redeem and list, agent catalog pull |
| GAMER (self) | + whoami, refresh, logout, get user, games list, own wallet and ledger, plans (list, buy, own), reservations (book, walk-in, cancel) |
| EMPLOYEE (staff) | + stations and machines, station games, commands, telemetry, alerts, sessions, wallets of gamers (credit, debit), branch pricing (read) |
| MANAGER (admin) | + staff accounts and roles, enrollment tokens, approve / reject / revoke / rotate, admission cases, game catalog management, plan management, pricing change. Own branch only |
| ADMIN (hq) | Everything, every branch |

A command above your scope is hidden (`v` shows it greyed). Typing its number still
works: the console asks for confirmation, sends it, and you see the server's
401 / 403. Use this to prove the server enforces the scope, not only the palette.

### 1.2 Identity switching

One operator drives both sides. Typical setup:

1. The console starts as `hq-admin`.
2. `l`, `n`: log in as `gamer.wood` / `password123`. The gamer is now active.
3. `s`: back to `hq-admin`. `s` again: back to the gamer.

`l` lists every saved identity with its role, scope and branch. Tokens are refreshed
on their own: a 401 on the active identity triggers one refresh (or a new login with
the stored password) and a retry.

Reservations are gamer calls (`/reservations` works on the caller's own gamer
profile), sessions are staff calls: the session flow (§13) switches with `s`.

### 1.3 Observer

`o` connects to `/dashboard-io` with the active identity's token and prints every
frame with a timestamp: `station_status`, `command_update`, `catalog_status`,
`alert`, `alert_resolved`, `session_runout_warning`, and any other event.
`telemetry_update` is hidden until you press `t`. The observer only prints; it
never reacts to a frame.

The observer keeps the identity it connected with. After a swap, press `o` twice to
reconnect it as the new identity. A staff identity without a branch (hq) receives
every branch; a branch user receives only its branch.

---

## 2. Enrollment and admission

Enrollment is the real API. A station gets its credential in four steps:

```text
admin:  POST /machines/enrollment-tokens {branchId, ttlMinutes}  -> one-time token
agent:  POST /enrollment/request (signed with its P-256 key)     -> PENDING, machine row created
admin:  POST /machines/:id/approve                               -> ENROLLED
agent:  POST /enrollment/request again (poll)                    -> ENROLLED + stationToken (JWT)
```

Every refusal of `/enrollment/request` is a **200** with
`{"status":"REJECTED","reason":"..."}`; the backend log prints the reason
(`enrollment request rejected: <REASON>`).

### 2.1 Real agent

| # | Action | Expected | P/F |
|---|---|---|---|
| 2.1 | As ADMIN or the branch MANAGER: `14` mint a token for the station's branch (`branchId`: `11` lists the branch ids seen) | Token printed, 43 characters | |
| 2.2 | On the PC, start the agent **elevated** with this token | Backend log `enrollment request: PENDING machine <id> (serial <serial>)` | |
| 2.3 | `11` with status `PENDING` | The new machine, with the PC's serial | |
| 2.4 | `16` approve it | 2xx, `enrollmentStatus ENROLLED` | |
| 2.5 | Wait for the agent's next poll | Log `enrollment request: ENROLLED ...`, then `agent connected`, `served catalog`. Observer: `[station_status] ONLINE`, then `[catalog_status]` | |
| 2.6 | Restart the agent (elevated) | Connects with its stored credential, no new enrollment request | |
| 2.7 | Restart the agent **not** elevated | It cannot read its DPAPI credential. Note what it does (expected: tries to enroll again, token consumed: `INVALID_ENROLLMENT_TOKEN`) | |
| 2.8 | Give the agent a token cut by 1 character | `REJECTED`, `INVALID_ENROLLMENT_TOKEN` (or `INVALID_REQUEST` if under 20 characters) | |
| 2.9 | Mint with `ttlMinutes 1`, wait 2 minutes, give it to the agent | `REJECTED`, `INVALID_ENROLLMENT_TOKEN` | |
| 2.10 | Enroll, then `17` reject instead of approve | Agent's next poll: `REJECTED`, `ENROLLMENT_REJECTED`. Machine `DEACTIVATED` | |
| 2.11 | `18` revoke an ENROLLED station while its agent is connected | The socket closes at once with 1008 `station not enrolled`; a running session is settled. Station stays OFFLINE | |
| 2.12 | `19` rotate the credential of an ENROLLED station, give the rotation token to the agent | Agent redeems with a new key: `ENROLLED` with a new station token. Note whether the old station token still connects | |

If the agent holds a station token for a machine that no longer exists (for example
after `npm run db:reset`), the backend logs `no MACHINE row for station <id>` and
the agent never enrolls again. Clear the agent's stored credential and enroll it
with a new token.

### 2.2 Stand-in agent

The console can act as an agent without a PC: it generates a P-256 key, signs the
canonical string exactly like the agent
(`BARONDESK-ENROLL-V1\n<token>\n<serial>\n<mac>\n<ip>\n<publicKey>\n<signedAt>`,
ECDSA-SHA256, DER, Base64) and redeems. Keys live only in the console process.

| # | Action | Expected | P/F |
|---|---|---|---|
| 2.13 | `20` provision end to end, serial `STANDIN-...` | Mint 201, redeem `PENDING`, approve 2xx, redeem `ENROLLED` with `stationToken` | |
| 2.14 | `21` list stand-ins | The serial, its machine id and its station token | |
| 2.15 | `31` agent catalog pull with the stand-in | 200, the station's resolved catalog | |
| 2.16 | `14` mint, `15` redeem twice without approving | `PENDING` both times, same `machineId` | |
| 2.17 | `14` mint, `15` redeem it with the serial of an existing machine (for example seeded `MNR-PC-01`) | `REJECTED`, `SERIAL_NUMBER_TAKEN` | |
| 2.18 | `15` redeem a token already consumed (after 2.13) | `REJECTED`, `INVALID_ENROLLMENT_TOKEN` | |
| 2.19 | `19` rotate, then `15` redeem with the same serial and a new key pair (`y`) | `ENROLLED`, new station token | |

The stand-in does not connect to `/agent-ws`: it stays OFFLINE, so commands and
sessions need the real agent.

### 2.3 Scope of enrollment

| # | Action | Expected | P/F |
|---|---|---|---|
| 2.20 | As EMPLOYEE, `14` (send anyway) | 403 | |
| 2.21 | As a MANAGER, `14` for another branch | 403 | |
| 2.22 | As a MANAGER, `16` approve a machine of another branch | 403 | |

### 2.4 Negative admission cases (forgeries)

`22` runs against `/agent-ws` and `GET /stations/me/games` with a stand-in that has
a station token (§2.2), and prints PASS/FAIL per line. **Cases b to e are
forgeries**: station JWTs the console signs itself with `JWT_ACCESS_SECRET`
(ghost machine, moved branch, expired) and direct `enrollment_status` writes
through `psql`. Every forged step is printed in magenta and labelled. They exist only
to prove the backend refuses them. The row's status is restored at the end. Run them
on a stand-in, not on the real station.

| Case | Checks | P/F |
|---|---|---|
| a | Real station token, ENROLLED: socket stays open, catalog 200 | |
| b | Row forced to PENDING / INACTIVE / DEACTIVATED: socket closed 1008, catalog 403 | |
| c | Forged token for a machine id with no row: 1008 on upgrade and handshake, catalog 403, `GET /machines/:id` 404 | |
| d | Forged token with another branch: 1008 / 401. Real token, handshake with another serial: 1008 | |
| e | No token, `?serialNumber=` or `x-station-serial` only, garbage, forged expired, user access token: 401. No row auto-created | |

Result line: `all passed`, or the number of failures.

---

## 3. Presence

Start: real agent enrolled and running (§2.1). Observer on (`o`).

| # | Action | Expected on server | P/F |
|---|---|---|---|
| 3.1 | Agent running, idle 1 minute | `10`: `ONLINE`, `lastSeen` moves. No `OFFLINE` | |
| 3.2 | Stop the agent cleanly | `[station_status] OFFLINE` at once | |
| 3.3 | Kill the agent process (Task Manager) | `[station_status] OFFLINE` at once | |
| 3.4 | Start the agent, then pull the network cable | `[station_status] OFFLINE` after 45 to 55 s (watchdog) | |
| 3.5 | Plug the network back | Agent reconnects: `ONLINE` | |
| 3.6 | Restart the backend with the agent running | Agent reconnects on its own | |
| 3.7 | Start a second agent process with the same credential | Old socket closed 4000, new one registered | |
| 3.8 | Change the PC clock 2 minutes ahead, restart agent | Frames dropped (`ts_out_of_window`) or close 4400. Reset the clock after | |

---

## 4. Remote commands (`32`)

The final status of each command comes as `[command_update]` in the observer, or
with `34` get command. `ACKED` only means the agent accepted the command: check
the effect on the PC and in the next `[station_status]`.

UNLOCK over REST is the admin unlock only (empty payload). A session unlock is sent
by the backend after an accepted PIN login (§13); it cannot be built over REST.

| # | Start | Action | Expected | On PC | P/F |
|---|---|---|---|---|---|
| 4.1 | Unlocked | LOCK | `ACKED`, `[station_status] locked=true` | Lock screen | |
| 4.2 | Locked | LOCK again | `ACKED` (idempotent) | Stays locked | |
| 4.3 | Locked | UNLOCK | `ACKED`, `locked=false` | Desktop usable | |
| 4.4 | Unlocked, no session | LAUNCH_GAME `notepad` | 409 `STATION_NOT_IN_SESSION`. No command row (`33`) | Nothing | |
| 4.5 | Session active (§13), game installed (§5) | LAUNCH_GAME `notepad` | `ACKED` | Notepad opens | |
| 4.6 | Session active | LAUNCH_GAME `does-not-exist` | 404 `GAME_NOT_FOUND` | Nothing | |
| 4.7 | Session active | END_SESSION reason `staff_end` | `ACKED`, `sessionId=null`, `locked=true` | Game closes, lock screen | |
| 4.8 | No session | END_SESSION | 409 `NO_ACTIVE_SESSION` | Nothing | |
| 4.9 | Any | CATALOG_UPDATE | `ACKED`, then `[catalog_status]` | Agent re-syncs | |
| 4.10 | As ADMIN | SHUTDOWN, confirm `y` | `ACKED` | Agent logs the shutdown (stub) | |
| 4.11 | As EMPLOYEE | SHUTDOWN | 403 `INSUFFICIENT_SCOPE`. No command row | Nothing | |
| 4.12 | Agent stopped | LOCK | 409 `STATION_OFFLINE` | - | |
| 4.13 | Any | `r` POST `/api/v1/stations/<id>/commands` body `{"type":"LOCK","gameId":"x"}` | 400 `gameId is only accepted for LAUNCH_GAME` | - | |
| 4.14 | Any | `r` body `{"type":"UNLOCK","payload":{"sessionId":"x"}}` | 400 (payload must be empty) | - | |
| 4.15 | Any | `r` body `{"type":"REBOOT"}` | 400 | - | |
| 4.16 | Freeze the agent (Resource Monitor, Suspend process), send LOCK within 45 s | `SENT`, second attempt (`attempts=2`), then `TIMEOUT` | - | |
| 4.17 | Resume right after 4.16 | Late ack wins: `TIMEOUT` to `ACKED` | PC locks | |

---

## 5. Game catalog

Start: station ONLINE, session active (§13).

| # | Action | Expected | On PC | P/F |
|---|---|---|---|---|
| 5.1 | `24` create `exe`, defaults (`notepad`, `C:\Windows\System32\notepad.exe`) | 201, listed in `23` | - | |
| 5.2 | `24` `exe` with target `notepad.exe` | 400, full path required | - | |
| 5.3 | `28` attach `notepad` to the station | 2xx. Automatic `CATALOG_UPDATE`, then `[catalog_status]` `notepad installed=true` | Agent re-syncs | |
| 5.4 | `30` station's games | `notepad` in the resolved list | - | |
| 5.5 | `32` LAUNCH_GAME `notepad` | `ACKED` | Notepad opens | |
| 5.6 | `24` `ghost` with target `C:\Games\Ghost\ghost.exe`, `28` attach | `[catalog_status]` `ghost installed=false` with a reason | - | |
| 5.7 | LAUNCH_GAME `ghost` | 409 `GAME_NOT_INSTALLED` | Nothing | |
| 5.8 | `25` patch `{"enabled":false}` on `notepad` | Automatic `CATALOG_UPDATE`. LAUNCH_GAME 409 `GAME_DISABLED` | Game gone from its catalog | |
| 5.9 | `25` `{"enabled":true}` | Launch works again | - | |
| 5.10 | `25` `{"arguments":"C:\\Windows\\win.ini"}` | Next launch opens win.ini | Notepad shows win.ini | |
| 5.11 | `29` detach from the station | LAUNCH_GAME 409 `GAME_NOT_ASSIGNED` | - | |
| 5.12 | `26` attach to the branch | Launch works again | - | |
| 5.13 | `28` attach with overrides `{"target":"C:\\Windows\\System32\\mspaint.exe"}` | Paint opens instead (station override wins) | Paint opens | |
| 5.14 | `27` and `29` detach from branch and station | Game gone from the station's catalog | - | |
| 5.15 | Stop the agent, change the catalog, start it | On connect: `served catalog`, then `[catalog_status]` with the change | New catalog | |
| 5.16 | As EMPLOYEE: `24` (send anyway) | 403 | - | |

---

## 6. Fault injection (`32`, `simulate`, needs `NODE_ENV` not `production`)

| # | Simulation | Expected | P/F |
|---|---|---|---|
| 6.1 | `stale_ts` with LOCK | `NACKED`, `STALE`. PC does not lock | |
| 6.2 | `duplicate_send` with LOCK | `ACKED` once. Agent re-acks the duplicate | |
| 6.3 | `invalid_payload` | `FAILED`, `INVALID_PAYLOAD` | |
| 6.4 | `exec_failed` while locked | `FAILED`, `EXEC_FAILED`, "must be unlocked with an active session" | |
| 6.5 | `exec_failed` unlocked with a session | `FAILED`, `EXEC_FAILED`, "not in catalog" | |
| 6.6 | Backend with `NODE_ENV=production` | 400 `SIMULATION_DISABLED` | |

---

## 7. Telemetry and alerts

| # | Action | Expected | P/F |
|---|---|---|---|
| 7.1 | Observer on, `t` | `[telemetry_update]` with CPU, GPU, RAM every few seconds | |
| 7.2 | `35` | Latest metrics for the station | |
| 7.3 | Load the CPU above the threshold (or lower `CPU_TEMP_THRESHOLD_C`) | `[alert]` hardware. `36` lists it open | |
| 7.4 | Keep the load on | No new alert per sample: repeats fold into the open alert | |
| 7.5 | Unplug a USB device on the PC | `[alert]` anti_theft | |
| 7.6 | `37` resolve it | `[alert_resolved]`. `36` with `resolved` shows it | |

---

## 8. Branch scoping and REST scope

Log in with several identities first (`l`): `hq-admin`, `manager.manar`,
`employee.manar1`, `gamer.wood`.

| # | Action | Expected | P/F |
|---|---|---|---|
| 8.1 | `13` with path `/machines` | hq: every branch. manager / employee: their branch only. gamer: 403 | |
| 8.2 | `13` with `/api/v1/alerts?status=open` | Same split | |
| 8.3 | As `manager.manar`: `63` for the other branch's id | 403 | |
| 8.4 | As `manager.manar`: `64` for its own branch | 2xx | |
| 8.5 | Observer as hq, then as `manager.manar` (`s`, `o`, `o`) | hq: events of every branch. manager: its branch only | |
| 8.6 | Observer as `gamer.wood` | Connects, but joins only its own `user:<id>` room: no station, alert or command events | |
| 8.7 | `r` with no token: `GET /api/v1/stations` | 401 | |
| 8.8 | `r` with the stand-in token: `GET /stations/me/games` | 200. With the active user token: 401 | |

---

## 9. Users and roles

| # | Action | Expected | P/F |
|---|---|---|---|
| 9.1 | `5` register a gamer, log in as it (`y`) | 201, identity switches to the gamer | |
| 9.2 | `5` same username again | 409 | |
| 9.3 | As hq: `6` create EMPLOYEE for a branch | 201, `branchId` set | |
| 9.4 | As hq: `6` create MANAGER | 201 | |
| 9.5 | As the new MANAGER: `6` role MANAGER | 403 (a manager creates EMPLOYEE only, in its branch) | |
| 9.6 | `7` change the EMPLOYEE to `GAMER`, then log in with it | Logs in, staff commands give 403 | |
| 9.7 | `6` with an unknown `branchId` | 4xx, no user created | |
| 9.8 | `3` refresh, then `4` logout; `r` `POST /auth/refresh` with the old refresh token | 401 | |

---

## 10. Branch pricing

`paygRate` and `bookingRate` are integers per hour, in the wallet's minor unit. The
session rate is `round(paygRate * (1 - membership discount) / 60)` per minute.

| # | Action | Expected | P/F |
|---|---|---|---|
| 10.1 | `63` on the seeded branch | The seeded rates | |
| 10.2 | `64` set `6000` / `6000` | 2xx. `63` shows them | |
| 10.3 | `64` `paygRate` `0` or `12.5` | 400 | |
| 10.4 | As EMPLOYEE: `64` | 403. `63` works | |

---

## 11. Wallet and ledger

Amounts are integers in the minor unit. A reused `idempotencyKey` must not post twice.

| # | Action | Expected | P/F |
|---|---|---|---|
| 11.1 | As a new gamer: `41` | Balance `0`, `gamerProfileId` remembered | |
| 11.2 | `s` to staff, `45` credit `10000` | 2xx, entry `CREDIT +10000` | |
| 11.3 | `45` credit `500` key `topup-1`, twice | Balance grows by 500 once | |
| 11.4 | `46` debit `200` | Balance down by 200 | |
| 11.5 | `46` more than the balance | 409 `INSUFFICIENT_FUNDS` | |
| 11.6 | `45` amount `0`, `-5`, `1.5` | 400 | |
| 11.7 | `43`, `44` staff view; `s`, `41`, `42` gamer view | Same balance and entries | |
| 11.8 | As the gamer: `45` (send anyway) | 403 | |

---

## 12. Membership and subscription plans

Plan `price` is in currency units; a purchase debits `price x 100` minor units.
At most one ACTIVE membership per gamer.

| # | Action | Expected | P/F |
|---|---|---|---|
| 12.1 | As admin: `48` membership `price 5`, `discountPercent 50` | 201 | |
| 12.2 | `48` same name | 409 | |
| 12.3 | As the gamer (wallet ≥ 500): `52` key `m-1` | 2xx, ACTIVE. Ledger `PAYMENT -500` | |
| 12.4 | `52` again with `m-1` | Same membership, no second debit | |
| 12.5 | `52` with another key | 409 `MEMBERSHIP_ALREADY_ACTIVE` | |
| 12.6 | New gamer, balance 0: `52` | 409 `INSUFFICIENT_FUNDS` | |
| 12.7 | `51` | The membership with its discount snapshot | |
| 12.8 | As admin: `49` `{"discountPercent":25}` | 2xx. Existing membership keeps 50% | |
| 12.9 | `50` delete a plan in use / unused | Refused / 2xx | |
| 12.10 | `54` subscription plan (default benefits) | 201 | |
| 12.11 | `54` benefits `{"windows":[{"daysOfWeek":[9],"startTime":"25:00","endTime":"x","discountPercent":20}]}` | 400 | |
| 12.12 | As the gamer: `58`, then `57` | 2xx, ACTIVE, wallet debited; listed with its benefits | |

---

## 13. Reservation, session, run-out and billing

How it fits together:

```text
gamer:  POST /reservations/walk-in {machineId, durationMinutes}  -> reservation (starts now) + checkIn.pin,
        session PENDING, rate fixed. The wallet must cover the whole time (else INSUFFICIENT_FUNDS)
gamer:  POST /reservations {machineId, startTime, endTime}        -> same, but the PIN works only from startTime;
        nobody logs in within 30 minutes -> NO_SHOW, the PC is free again
gamer:  GET /reservations                                          -> each booking shows its unused PIN
staff:  POST /sessions {reservationId}                            -> fallback: a new PIN once the old one is dead
PC:     gamer types the PIN on the lock screen -> agent login_request
        backend checks the PIN and the balance (5 minutes of play) -> login_result accepted -> session UNLOCK
        heartbeat locked=false with sessionId -> session ACTIVE, metering starts,
        run-out timer scheduled from the wallet balance and the rate
backend: warn job   -> [session_runout_warning] (SESSION_RUNOUT_WARNING_LEAD_S before lock, default 300 s)
         lock job   -> system LOCK -> heartbeat locked=true -> session PAUSED
staff:  wallet credit during the session -> timers rescheduled from the new balance
staff:  POST /sessions/:id/end -> END_SESSION -> settlement: COMPLETED, billingBreakdown, PAYMENT entry
```

Start: real station ONLINE and locked, pricing `6000` (§10), `gamer.wood` with a
wallet balance, observer on as staff. Identities: `hq-admin` and `gamer.wood`.

| # | Action | Expected | On PC | P/F |
|---|---|---|---|---|
| 13.1 | As the gamer: `61` walk-in on the station, `60` minutes | 201, reservation remembered, **`checkIn.pin`** printed | Still locked | |
| 13.2 | `59` | The reservation, with `pin { pin, validFrom, validUntil }` | - | |
| 13.3 | `s` to staff: `38` create session on it | 409 `SESSION_ALREADY_STARTED`: the walk-in already holds its PIN | - | |
| 13.4 | `38` with a random uuid | 404 `RESERVATION_NOT_FOUND` | - | |
| 13.5 | Agent stopped: `61` walk-in | 409 `MACHINE_UNAVAILABLE` (Play now needs the PC on) | - | |
| 13.6 | `32` UNLOCK on the station before any login | 409 `NO_SESSION_TO_UNLOCK` | Stays locked | |
| 13.7 | Type a wrong PIN on the PC | Backend log `login_request ... rejected (invalid_pin)`. Session stays `PENDING` | Refused | |
| 13.8 | Type the right PIN | `[station_status] locked=false sessionId=<id>`. `39`: `ACTIVE` | Desktop unlocked | |
| 13.9 | Lock (`32`), then type the same PIN again (single use) | Refused (`no_pending_session` or `pin_used` in the log) | Stays locked | |
| 13.10 | After 13.8: `46` debit down to about 5 minutes of play (the money the session already used can't be debited) | `[session_runout_warning] {sessionId, machineId}` about `SESSION_RUNOUT_WARNING_LEAD_S` before the lock | - | |
| 13.11 | After the warning: `45` credit | Timers rescheduled: the lock comes later than planned. A new warning follows later | - | |
| 13.12 | Let the balance run out | System `[command_update] LOCK ACKED`, `locked=true`, `39`: `PAUSED`, `lockedAt` set | Lock screen | |
| 13.13 | `32` LOCK during an ACTIVE session, wait 1 minute, `39` | `PAUSED`, `meteredSeconds` unchanged while locked | Lock screen | |
| 13.14 | `32` UNLOCK, wait 1 minute | Resumes the station's own session: `ACTIVE` again. After a run-out lock (13.12) it is 409 `INSUFFICIENT_FUNDS` until a top-up | Desktop unlocked | |
| 13.15 | `40` end session `staff_end` | `[command_update] END_SESSION ACKED`, `39`: `COMPLETED`, `settledAt`, `billingBreakdown` | Lock screen | |
| 13.16 | `44` ledger | `PAYMENT -totalCents` with the session id | - | |
| 13.17 | `40` again | 409 `SESSION_NOT_OPEN` | - | |
| 13.18 | As the gamer: `60` book ahead: type `startTime` about 5 minutes from now and `endTime` 1 hour later (ISO with offset, the console prints the current UTC time), then `62` cancel it | 201, then 2xx. `59` shows the new status | - | |
| 13.19 | `60` with a start time in the past | 400 `INVALID_RESERVATION_TIME` | - | |
| 13.19b | `60` book ahead starting in about 2 minutes; type its PIN (from the answer or `59`) at once, then again after the start | First `no_pending_session` in the log, then unlocked | Locked, then desktop | |
| 13.19c | Book ahead starting now, never type the PIN, wait 30 minutes (or set `NO_SHOW_GRACE_MINUTES=1`) | `59`: `NO_SHOW`; `61` walk-in on the same PC works | - | |

Check the numbers: `totalCents = round(meteredSeconds / 60 * rateCentsPerMinute)`.

Billing variants (each needs a new reservation and session):

| # | Setup | Expected | P/F |
|---|---|---|---|
| 13.20 | Gamer with an ACTIVE 50% membership | Rate halved, `appliedMembershipId` set | |
| 13.21 | Plan changed to 25% after purchase | Still 50% (snapshot) | |
| 13.22 | Wallet `0`: `61` walk-in | 409 `INSUFFICIENT_FUNDS`: nothing is booked | |
| 13.23 | End the session from the PC side | Settlement with reason `agent_reported` | |
| 13.24 | Walk-in, never type the PIN, `62` cancel | `CANCELLED`, the PIN stops working, no ledger entry. (`40` end gets 409 `NO_ACTIVE_SESSION`: the station runs no session) | |

---

## 14. Full walkthrough (smoke test, about 10 minutes)

1. Stack up. `node scripts/station-console.mjs` (logs in as `hq-admin`). `o`: observer on.
2. `11`: note the branch id. `14`: mint a token. Start the real agent **elevated** with it.
3. `11` status `PENDING`: the PC's machine. `16` approve. `[station_status] ONLINE`, `[catalog_status]`.
4. `20`: provision a stand-in. `22`: admission cases `all passed`.
5. `64`: pricing `6000` / `6000`.
6. `l`, `n`: log in as `gamer.wood`. `41`: note the balance. `s`: back to admin.
7. `45`: credit `10000` to the gamer.
8. `24`, `28`: create `notepad` and attach it to the real station. `[catalog_status]` `notepad installed=true`.
9. `32` LOCK: PC locked.
10. `s` (gamer): `61` walk-in 60 minutes: note `checkIn.pin` (6 DT, so the 10 DT credit covers it).
11. Type the PIN on the PC: desktop unlocks. `39`: `ACTIVE`.
12. `32` LAUNCH_GAME `notepad`: Notepad opens.
13. Wait 2 minutes. `40` end session. `39`: `COMPLETED`, `totalCents` about 200.
14. `44`: `PAYMENT` with the session id.
15. `35` telemetry and `36` alerts answer. `33`: every command `ACKED`.

---

## 15. Known limitations (not failures)

- SHUTDOWN is a stub on the agent: the PC stays on.
- `runningGameId` only updates on reconnect (`state_report`).
- No REST route undoes a revoke: the machine enrolls again with a fresh token for its
  branch (it goes back to PENDING for approval).
- In dev on Docker Desktop, `ip` shows the Docker gateway, not the PC.
- The stand-in agent enrolls but does not connect to `/agent-ws`: it stays OFFLINE.
- A gamer's dashboard socket gets only its own events (`session_runout_warning`,
  `session_notice`); see `FLOW_FIXES.md` A1.
