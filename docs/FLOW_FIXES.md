# Flow fixes (2026-09-30 to 2026-10-01)

This note records the backend changes from the full flow review of
2026-09-30. Each item gives the problem, what changed, and where. The review
numbers (#n) match the implementation plan
(`../../IMPLEMENTATION_PLAN_FLOW_FIXES.md`). It follows
`BOOKING_AND_BILLING_FIXES.md`. Read both before you touch `identity`,
`reservations`, `session-billing`, `wallet`, `station` or `ops`.

**Not done, on purpose:**
- #6: a gamer ending their own session on the PC;
- #16: side effects of a role change (gamer profile, staff with no branch);
- #19: re-checking the dashboard socket's token.

---

## 0. Before you run it

**Migrations.** Apply them with `npm run db:deploy` (stack up), then
`npm run db:generate`, then restart the backend. They run in this order:

| Migration | Adds |
|---|---|
| `20260930170000_walk_in_and_lock_reason` | `reservations.is_walk_in`, `sessions.lock_reason` |
| `20260930190000_game_catalog_fixes` | `machine_games.excluded`, `station_installed_games` (see `GAME_CATALOG_FIXES.md`) |
| `20260930210000_session_money_and_extensions` | `sessions.accrued_cents`, `next_rate_cents_per_minute`, `rate_switch_at`, `ending_notice_sent_at` |
| `20260930220000_station_credentials_and_peripherals` | `machines.credential_version`, `peripherals`, `peripherals_reported_at` |
| `20260930230000_gamer_home_branch` | `gamer_profiles.home_branch_id` (FK `branches`, `ON DELETE SET NULL`) |
| `20261001090000_session_pin_cipher` | `sessions.pin_cipher` |

**Prisma client.** After pulling, run `npx prisma generate`. If the unit tests
fail with `Cannot read properties of undefined (reading 'validator')`, the
generated client in `src/generated/prisma/runtime/` was written empty. Run
`npx prisma generate` again.

**Settings.** Every new setting has a default; see §9.

**Frontend.** The staff app and the portal use all the endpoints below. See
`front-end/README.md`.

---

## 1. Security (Phase A)

### A1 (#1) Live updates stay in their own room
**Problem.** Every logged-in user, gamers included, joined the branch rooms on
`/dashboard-io`. Any gamer could see station, alert and session events.
**Change.**
- Staff join their branch room; HQ joins `branch:all`.
- A gamer joins only `user:<userId>`. Staff with no branch join nothing.
- New `publishToUser(userId, event, payload)`.
- `session_notice` goes to the gamer's room only (session-billing looks up the
  gamer's user id). `session_runout_warning` stays a staff event, sent to the
  station's branch; the gamer gets the same warning as `session_notice`
  `LOW_BALANCE`.

**Where.** `ops/dashboard.gateway.ts`, `session-billing/services/sessions.service.ts`.

### A2 (#2) Role changes can't escalate
**Change.** Below HQ, nobody may change the role of a MANAGER or an ADMIN.
Nobody may change their own role.
**Error.** `403 FORBIDDEN_ROLE_ESCALATION`.
**Where.** `identity/services/users.service.ts`.

### A3 (#15) Accounts can be disabled
**Change.**
- Login, refresh and `/auth/me` refuse an account that isn't ACTIVE
  (`403 ACCOUNT_DISABLED`).
- `PATCH /users/:id/status { status: ACTIVE | SUSPENDED }`:
  - HQ may change anyone but themselves;
  - a manager may change only the employees of their own branch;
  - suspending revokes every refresh token of the user.
- Refresh-token reuse: a refresh token that was already rotated is refused
  (`401 REFRESH_TOKEN_REUSED`), and all the user's tokens are revoked. This is
  the defence against a stolen token.

**Where.** `identity/services/auth.service.ts`, `users.service.ts`.

### A4 (#17) Errors don't leak internals
**Change.** The exception filter never sends a raw error message.
- Prisma P2002 and P2003 become `409 CONFLICT`.
- P2025 becomes `404 NOT_FOUND`.
- Anything else becomes `500 internal server error`.
- The details go to the log only.
- A taken username at sign-up or employee creation is `409 USERNAME_TAKEN`.

**Where.** `common/filters/all-exceptions.filter.ts`.

### A5 (#18) Rate limits
A Redis counter answers `429 TOO_MANY_ATTEMPTS` when one of these limits is hit:

| Route | Limit |
|---|---|
| `POST /auth/login` | 10 failures per 15 minutes, per IP + username |
| `POST /auth/refresh` | 60 a minute, per IP |
| `POST /users` (sign-up) | 30 an hour, per IP |

If Redis is down, the limiter lets requests through.

**Where.** `common/rate-limit/rate-limiter.service.ts`, `identity/controllers/*`.

---

## 2. Billing and sessions (Phase B)

### B1 (#3) The runout timer counts what was already played
**Change.** Time left = (balance − cost of this session so far − lock margin) ÷ rate.
- The cost so far is `accruedCents` plus the metered seconds × rate.
- The margin is `SESSION_RUNOUT_MARGIN_S` (default 30). It covers the delay
  between the LOCK and the station actually locking.

### B2 (#4) Metering stops when the station goes offline
**Change.**
- When presence reports a station OFFLINE, its ACTIVE session is PAUSED at
  the station's last heartbeat (`lockReason 'offline'`). It resumes the normal
  way when the station reports itself unlocked again.
- `SHUTDOWN` of a station in session settles the session at once, through
  `closeForShutdown`, before the command is sent.

### B3 (#5) Sessions that ended while the backend was down get closed
**Change.** On a `state_report` without a `sessionId`, any session still
running on that machine is settled. The settle time is the first one known of:
- the time it was locked;
- the station's last heartbeat before this connection;
- now.

### B4 (#7) Staff Unlock works
**Change.** A staff `UNLOCK` resumes the station's own open session (session id
and lease from session-billing).
- With no session: `409 NO_SESSION_TO_UNLOCK`.
- A session locked because the money ran out needs the minimum balance first:
  `409 INSUFFICIENT_FUNDS`.

**Where.** `ops/services/commands.service.ts`, `SessionsService.unlockFor`.

### B5 (#8) END_SESSION only ends the session it was meant for
**Change.**
- `issueSystemEndSession(machineId, reason, sessionId)` sends END_SESSION only
  when the station currently reports that same session. Otherwise it returns
  false: the session is settled in the database only, and the station is left
  alone.
- When a gamer logs in on a PC, any other session still open there is settled
  at its lock time (`replaced_by_login`).

### B6 (#20) Spending during a session is safe
**Change.**
- Every wallet debit other than a session settlement emits `debited`.
  Session-billing then reschedules the runout timer.
- Money a running session has already used is reserved: desk debits and plan
  purchases can't spend it (`409 INSUFFICIENT_FUNDS`). This goes through a
  reserve hook that session-billing registers with the wallet.

### B7 (#21) No unpaid shortfalls
**Change.** Bookings and walk-ins are quoted: the rate at their start (booking
or walk-in rate, best discount) × the duration.
- They are refused (`409 INSUFFICIENT_FUNDS`) unless the balance covers the
  quote on top of everything already promised: running sessions (cost so far
  plus the rest of their time) and the gamer's other bookings ahead.
- The minimum play time (`SESSION_MIN_PLAY_MINUTES`) is checked when the PIN
  is typed: the login is refused with `insufficient_funds`.
- The capped debit stays as a safety net. A shortfall is logged as an error.

**Where.** `SessionsService.assertAffordable` / `committedCents` / `quote`,
`reservations.service.ts`.

### B8 (#22) The PIN comes with the booking; no-shows free the PC
**Change.**
- Every booking and walk-in gets its PIN when it is made. The answer to
  `POST /reservations` and `POST /reservations/walk-in` carries
  `checkIn { sessionId, pin, pinExpiresAt }`.
- The PIN works only on that PC, from the booking's start until the no-show
  deadline (`NO_SHOW_GRACE_MINUTES`, default 30, after the start, never past
  the end).
- Typed before the start, the login gets `no_pending_session`.
- `GET /reservations` shows each unused PIN as
  `pin { pin, validFrom, validUntil }`. The PIN is kept sealed in
  `sessions.pin_cipher` (AES-256-GCM, key `PIN_ENCRYPTION_KEY`, default
  derived from `JWT_ACCESS_SECRET`). The argon2 hash still does the login
  check.
- `POST /reservations/:id/check-in` ("New PIN") replaces a PIN nobody has
  typed yet.
- **No-show:** the sweep marks a booking NO_SHOW when its PIN reaches the
  deadline unused. Its session is cancelled, and the PC can be booked or
  walked into again.
- Cancelling (gamer or staff) depends on whether someone actually played, not
  on the clock:
  - a booking that started but nobody logged into can be cancelled until its
    deadline;
  - once someone has logged in, cancelling gets `409 SESSION_IN_PROGRESS`.
- The staff `POST /sessions` stays as the desk's fallback: it issues a PIN for
  a gamer without a phone.

**Where.** `SessionsService.issuePin` / `login` / `sweep`, `sessions.repository.ts`.

### B9 (#23) Extend
**Change.** Sessions stop at the booking's end by default.
- `GET /reservations/:id/extend-options` lists 30, 60 and 90 minutes, each with
  its cost and whether it's available. The `reason` is `SLOT_TAKEN` or
  `INSUFFICIENT_FUNDS` when it isn't.
- `POST /reservations/:id/extend { minutes: 30 | 60 | 90 }`, for the gamer's
  own running booking. It's charged at the walk-in rate.
- Refused with:
  - `409 RESERVATION_SLOT_TAKEN` when another booking overlaps;
  - `409 GAMER_ALREADY_BOOKED` when the gamer has another booking then;
  - `409 INSUFFICIENT_FUNDS` when the wallet can't cover it;
  - `409 SESSION_NOT_RUNNING` when the session isn't running.
- On success, the booking and the session end later. If the rate changes, the
  switch is recorded (`nextRateCentsPerMinute` from `rateSwitchAt`, the old
  end). The sweep then bills the time before the switch into `accruedCents`.
- Settlement = `accruedCents` + metered seconds × rate.

### B10 (#10) The station warns before locking
**Change.** `session_notice` goes to the station (in the agent's shape) and to
the gamer's portal:
- `LOW_BALANCE` when the runout warning fires;
- `TIME_LEFT` `SESSION_ENDING_NOTICE_MINUTES` (default 10) before the end, once
  per session;
- `CLEAR` after a top-up or an extend.

### B11 (#24) Membership upgrade and cancel
**Change.**
- Buying a more expensive tier while one is active is an upgrade: the old tier
  is cancelled, and the gamer pays the new price minus what's left of the old
  one, prorated by days.
- The same or a cheaper tier is still `409 MEMBERSHIP_ALREADY_ACTIVE`.
- `POST /memberships/me/cancel` cancels the tier, with no refund
  (`404 NO_ACTIVE_MEMBERSHIP` when there is none).

### Also: force-close
`POST /sessions/:id/force-close` (staff) closes a session without waiting for
the station:
- one that was played is settled up to now;
- one nobody logged into is cancelled.

The station is still asked to end it.

### Also: walk-ins on a busy PC
A walk-in is refused while someone plays on the PC (`409 RESERVATION_SLOT_TAKEN`).

---

## 3. Stations and enrollment (Phase C)

### C1 (#11) Revoking a station disconnects it
Revoke and reject close the live socket (1008). Revoke also settles any open
session on the station and cancels its future bookings
(`SessionsService.retireMachine`).

### C2 (#12) Rotation retires the old token
Station tokens carry `ver`, and admission requires it to match
`machines.credential_version`. A token without `ver` counts as version 1.
Redeeming a rotation token bumps the version, so the old token stops working.

### C3 (#13) Station tokens renew themselves
On handshake, if the token expires within 30 days, the backend sends
`station_credential { stationToken }` with a fresh token of the same version.
The agent saves it in its DPAPI store and uses it from the next reconnect.
**Where.** `station/services/station-token.service.ts`, `ops/agent.gateway.ts`;
agent: `ConnectionWorker`.

### C4 (#14) A rejected or revoked PC can enroll again
A fresh enrollment token for the same branch resets a DEACTIVATED machine to
PENDING, with the new key and name. An admin still has to approve it.

### C5 (#25) Peripheral status is stored and shown
- `peripheral_status` and `state_report.peripherals` are saved on the machine
  (`peripherals`, `peripherals_reported_at`).
- They are pushed to the branch as `peripheral_status`.
- `GET /api/v1/stations/:id` returns them.

### C6 (#29) Stations can be renamed
`PATCH /api/v1/stations/:id { name }` (manager and up; 1 to 64 characters).
The name the agent reports only fills a station that has none, so a rename
sticks. Live dashboards get the new name through `station_status`.

---

## 4. Branches and the gamer's home branch (Phase D)

### D1 (#26) Branches API
- `GET /branches` is public: `{ id, name, location }`, needed at sign-up.
- `POST /branches` and `PATCH /branches/:id` are HQ only.

### D2 Gamers have a home branch
- `POST /users` requires `branchId`. A missing one is `400 VALIDATION_ERROR`;
  an unknown one is `400 BRANCH_NOT_FOUND`.
- `PATCH /users/me/branch { branchId }` changes it (`403 NOT_A_GAMER` for staff).
- `/auth/me` and every user answer include `homeBranchId`.

### D3 (#27) Gamers see the stations of their branch
`GET /branches/:id/stations` (any logged-in user) lists the branch's enrolled
stations. For each: `id`, `name`, `serialNumber`, `online`, `busyNow`,
`busyUntil`, and the bookings of the next 7 days (start and end only, never
who booked).

---

## 5. Desk tools and visibility (Phase E)

| # | Endpoint | Who | What |
|---|---|---|---|
| E1 (#9) | `GET /gamers?q=` | staff | Gamers by username (up to 20), for top-ups. No member code needed |
| E2 (#28) | `GET /api/v1/reservations?branchId&from&to&status&limit` | staff, own branch | Bookings with `gamerUsername` and the station |
| E2 | `DELETE /api/v1/reservations/:id` | staff, own branch | Cancels a booking nobody plays on yet, and its PIN |
| E3 (#29) | `GET /users?q&role&branchId&limit` | staff | HQ: everyone. Branch staff: gamers and their own branch's staff |
| E3 | `POST /auth/change-password { currentPassword, newPassword }` | self | Revokes every other refresh token and returns a new pair |
| E3 | `POST /users/:id/password { newPassword }` | manager and up | HQ: anyone. A manager: their branch's employees and the gamers of their branch. Not yourself (`403 USE_CHANGE_PASSWORD`) |
| E4 (#29) | `GET /sessions?branchId&status&from&limit` | staff | Sessions a gamer logged into, newest first, with station, gamer and `costSoFarCents`. A booking's PENDING session that still waits for its PIN is left out: it's on the bookings list |
| E5 (#29) | `GET /sessions/me/current` | gamer | The current session: station, rate, time played, cost so far, balance, end time, lock reason, extend options. `null` when not playing |
| E6 (#29) | `GET /api/v1/stations/:id/telemetry/history?hours=` | staff | One sample a minute, oldest first; 1 to 48 hours, default 6 |

---

## 6. New and changed endpoints at a glance

| Method and path | Scope | Change |
|---|---|---|
| `GET /branches` | public | new |
| `POST /branches`, `PATCH /branches/:id` | hq | new |
| `GET /branches/:id/stations` | self | new |
| `POST /users` | public | needs `branchId`; rate-limited |
| `PATCH /users/me/branch` | self | new |
| `GET /users` | staff | new |
| `GET /gamers` | staff | new |
| `PATCH /users/:id/status` | admin | new |
| `POST /users/:id/password` | admin | new |
| `POST /auth/change-password` | self | new |
| `POST /auth/login`, `POST /auth/refresh` | public | rate-limited; refuse disabled accounts; refresh-token reuse detection |
| `POST /reservations`, `POST /reservations/walk-in` | self | quoted against the wallet; answer with `checkIn` (the PIN) |
| `GET /reservations` | self | each booking carries its unused `pin` |
| `POST /reservations/:id/check-in` | self | New PIN: replaces an unused one |
| `GET /reservations/:id/extend-options`, `POST /reservations/:id/extend` | self | new |
| `DELETE /reservations/:id` | self | cancel keyed on actual play (`SESSION_IN_PROGRESS`) |
| `GET /api/v1/reservations`, `DELETE /api/v1/reservations/:id` | staff | new |
| `GET /sessions` | staff | new |
| `GET /sessions/me/current` | self | new |
| `POST /sessions/:id/force-close` | staff | new |
| `POST /memberships/me/cancel` | self | new; buying a dearer tier upgrades |
| `PATCH /api/v1/stations/:id` | admin | new (rename) |
| `GET /api/v1/stations/:id` | staff | adds `peripherals`, `peripheralsReportedAt` |
| `GET /api/v1/stations/:id/telemetry/history` | staff | new |
| `POST /api/v1/stations/:id/commands` | staff | `UNLOCK` needs the station's session; `SHUTDOWN` settles it first |

Scopes: `self` = any logged-in user, `staff` = employee and up,
`admin` = manager and up, `hq` = HQ admin.

---

## 7. New error codes

| Code | Status | When |
|---|---|---|
| `ACCOUNT_DISABLED` | 403 | Login, refresh or `/auth/me` on a suspended account |
| `REFRESH_TOKEN_REUSED` | 401 | A rotated refresh token is used again: every token of the user is revoked |
| `TOO_MANY_ATTEMPTS` | 429 | A rate limit (§1, A5) |
| `FORBIDDEN_ROLE_ESCALATION` | 403 | A role, status or password change above what the caller may do |
| `FORBIDDEN_SELF_STATUS` | 403 | Suspending yourself |
| `USE_CHANGE_PASSWORD` | 403 | Resetting your own password through `/users/:id/password` |
| `USERNAME_TAKEN` | 409 | Sign-up or employee creation with a taken username |
| `CONFLICT` / `NOT_FOUND` | 409 / 404 | Database conflicts and missing rows, without internals |
| `BRANCH_NOT_FOUND` | 400 / 404 | Sign-up or home branch with an unknown branch (400); a branch route (404) |
| `NOT_A_GAMER` | 403 | `PATCH /users/me/branch` by staff |
| `INSUFFICIENT_FUNDS` | 409 | A booking, walk-in or extend the wallet can't cover; a staff UNLOCK after a runout lock; a debit that would spend money a session already used |
| `NO_SESSION_TO_UNLOCK` | 409 | Staff UNLOCK on a PC with no session |
| `SESSION_IN_PROGRESS` | 409 | Cancelling a booking someone logged into |
| `RESERVATION_EXPIRED` | 409 | A PIN for a booking past its no-show deadline |
| `RESERVATION_SLOT_TAKEN` | 409 | A booking or extend that overlaps another booking; a walk-in while someone plays on the PC |
| `SESSION_NOT_RUNNING` | 409 | Extending a session that isn't running |
| `NO_ACTIVE_MEMBERSHIP` | 404 | Cancelling a membership you don't have |

**Login results** (`login_result.reason` to the station): `invalid_pin`,
`pin_used`, `pin_expired`, `too_many_attempts`, `no_pending_session` (no
booking has started on this PC), `insufficient_funds` (below the minimum play
time), `unsupported_method`.

---

## 8. Events

**Dashboard socket (`/dashboard-io`).**
- To the branch room (and HQ): `station_status`, `telemetry_update`,
  `command_update`, `alert`, `alert_resolved`, `catalog_status`,
  `session_runout_warning`, `peripheral_status` (new).
- To the gamer's `user:<id>` room: `session_notice` (new). `session_update` is
  defined but not sent yet.

**Agent socket (`/agent-ws`).**
- New from the backend:
  - `session_notice { sessionId, kind: LOW_BALANCE | TIME_LEFT | CLEAR, endsAt }`;
  - `station_credential { stationToken }`.
- Now handled from the agent: `peripheral_status`, `installed_games`, and
  `state_report.peripherals`.

---

## 9. Settings

All are optional; `.env.example` lists them commented out with their
defaults.

| Setting | Default | What |
|---|---|---|
| `SESSION_MIN_PLAY_MINUTES` | 5 | A login needs the balance for this many minutes of play |
| `NO_SHOW_GRACE_MINUTES` | 30 | A booking nobody logged into this long after its start is a NO_SHOW; the PIN's deadline |
| `SESSION_PIN_MAX_ATTEMPTS` | 5 | Wrong PINs before it is burned |
| `SESSION_RUNOUT_MARGIN_S` | 30 | The station locks this long before the money runs out |
| `SESSION_RUNOUT_WARNING_LEAD_S` | 300 | The low-balance warning comes this long before the lock |
| `SESSION_ENDING_NOTICE_MINUTES` | 10 | The TIME_LEFT notice comes this long before the end |
| `PIN_ENCRYPTION_KEY` | derived from `JWT_ACCESS_SECRET` | Seals the PIN so the app can show it again (16+ characters) |
| `BUSINESS_TIMEZONE` | `Africa/Tunis` | Pass time windows are read in it |

`SESSION_PIN_TTL_S` is no longer used: the PIN's validity comes from the
booking.

---

## 10. Tests

- **Unit** (`npm test`): 318 pass. They cover each item above, mostly in
  `*.service.spec.ts` next to the code.
- **e2e** (`npm run test:int`, inside the backend container): updated for
  every changed contract, but **not run yet**. They need the migrations in §0.
  - Every gamer sign-up sends `branchId`; `auth` checks the refusals.
  - `session-billing` covers:
    - the PIN at booking, its window, and New PIN;
    - the balance check at login, and funds at booking and walk-in;
    - the 30-minute no-show;
    - `issueSystemEndSession` per session;
    - staff UNLOCK.
  - `commands`: `NO_SESSION_TO_UNLOCK`.
  - `realtime`: a gamer's socket gets only its own events.

## 11. Known limits

- The e2e specs haven't run against a database with these migrations yet.
- A gamer can't end their own session from the PC (#6, skipped).
- The dashboard socket keeps the token it connected with until it reconnects
  (#19, skipped).
- `GET /users` and `GET /gamers` return at most 100 and 20 rows. Search to
  narrow them.
- Only the latest peripheral snapshot is kept, not its history.
