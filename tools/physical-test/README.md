# Physical test harness

Throwaway tooling. It drives the running backend over the network and prints
what comes back. It has no business logic. Enrollment and the PIN login are done
by the real desktop agent on the station PC.

| File | Role |
|---|---|
| `observer.mjs` | Connects to `/dashboard-io` as the admin and prints every frame with a timestamp |
| `driver.mjs` | Linear script of REST calls, printing each request and response |

## Preconditions

- Database seeded from `feat/seeding` (branches, stations, gamers, pricing).
- Backend reachable at `BASE_URL`.
- Run from the backend repo root with `npm install` done (for `socket.io-client`).

## Run

Two terminals on the harness machine:

```powershell
$env:BASE_URL = "http://192.168.1.10:3000"
node tools/physical-test/observer.mjs      # terminal 1
node tools/physical-test/driver.mjs        # terminal 2
```

## Env

| Variable | Default | Used by |
|---|---|---|
| `BASE_URL` | `http://localhost:3000` | both |
| `WS_URL` | `BASE_URL` | observer |
| `ADMIN_USERNAME` / `ADMIN_PASSWORD` | `hq-admin` / `change-me-immediately` | both |
| `HIDE_EVENTS` | none | observer, e.g. `telemetry_update` |
| `GAMER_USERNAME` / `GAMER_PASSWORD` | `gamer.wood` / `password123` | driver |
| `STATION_ID` | first enrolled machine | driver: seeded station whose branch gets the token |
| `MACHINE_ID` | none | driver: skip enrollment, use this enrolled agent machine |
| `WALK_IN_MINUTES` | `60` | driver |
| `START_BALANCE` | unchanged | driver: set the gamer wallet to this (millimes) first |
| `TOPUP_AMOUNT` | `200` | driver: mid-session credit (millimes) |
| `POLL_MS` | `3000` | driver |

For HTTPS through Caddy with its local CA, set `NODE_EXTRA_CA_CERTS=caddy-root.crt`.

## Driver steps

1. Admin login.
2. Mint a one-time enrollment token (`POST /machines/enrollment-tokens`) for the seeded station's branch.
3. Operator starts the agent with the token. The driver waits for the new PENDING machine,
   asks, then approves it (`POST /machines/:id/approve`), and waits for ENROLLED and ONLINE.
4. Gamer login, wallet read, optional balance adjustment, walk-in reservation on the station.
5. Admin starts the session (`POST /sessions`). The PIN is printed once.
6. Operator types the PIN on the lock screen. The driver waits for session ACTIVE and station `locked=false`.
7. After `SESSION_RUNOUT_WARNING` shows in the observer, Enter tops up the wallet. The backend reschedules the timers.
8. The driver waits for the run-out lock: session PAUSED, station `locked=true`.
9. Enter ends the session (`POST /sessions/:id/end`). The driver waits for COMPLETED.
10. Settlement read-back: `billingBreakdown.totalCents`, one wallet debit for the session, reservation COMPLETED.

## Timing

Run-out time is `balance / rateCentsPerMinute`. The warning fires
`SESSION_RUNOUT_WARNING_LEAD_S` (backend default 300 s) before it. For a short
run, set `START_BALANCE` so run-out comes in a few minutes, and lower
`SESSION_RUNOUT_WARNING_LEAD_S` on the backend if needed.
