# Node tracking: physical test guide

How to verify node tracking end to end with the real BaronDesk desktop agent:
presence over `/agent-ws`, `station_status` over `/dashboard-io`, and
`GET /api/v1/stations`.

All commands are PowerShell. "Server PC" is the machine that runs Docker. "Gaming PC" is
the machine that runs the agent. They can be the same machine.

---

## 0. The port and address problem

The agent defaults to `wss://127.0.0.1:8443/agent-ws`. The current stack does not serve
that address:

| What the agent expects | What the stack provides |
|---|---|
| port **8443** | Caddy publishes **443** only (`docker-compose.yml`) |
| host `127.0.0.1` (an IP) | Caddy's certificate and routing cover only `localhost` and `cstam-server.local` |

A connection to an IP sends no TLS SNI, and its `Host` header does not match any Caddy
site. Caddy then fails the TLS handshake or returns an empty response, and the agent
never connects.

Pick **one** of the three setups below.

The agent is always pointed at the server through environment variables
(`Agent__ServerUrl`, `Agent__SerialNumber`). These override `appsettings.json`, so you
do not edit any agent file.

TLS validation: in dev, `PinnedCertificateHash` is empty and `AllowUntrustedCertificate`
is `true`. The agent therefore accepts Caddy's internal CA certificate without pinning.
Do not change this for this phase.

### Setup A: same PC, no infra change (simplest)

The agent and Docker run on the same machine. Point the agent at Caddy on 443:

```powershell
$env:Agent__ServerUrl = "wss://localhost/agent-ws"
```

### Setup B: gaming PC on the LAN, no infra change (recommended for a real LAN test)

1. On the **server PC**, find its LAN IP:
   ```powershell
   ipconfig   # e.g. IPv4 Address . . . : 192.168.1.50
   ```
2. On the **server PC**, allow inbound 443 (run in an admin terminal):
   ```powershell
   New-NetFirewallRule -DisplayName "CSTAM Caddy 443" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow
   ```
3. On the **gaming PC**, map the name that Caddy already serves to the server IP. Run
   this in an admin terminal, and replace the IP with yours:
   ```powershell
   Add-Content C:\Windows\System32\drivers\etc\hosts "`n192.168.1.50  cstam-server.local"
   ping cstam-server.local   # must resolve to 192.168.1.50
   ```
4. Point the agent at the name:
   ```powershell
   $env:Agent__ServerUrl = "wss://cstam-server.local/agent-ws"
   ```

### Setup C: keep the agent's default port 8443 (changes the Docker files)

Use this only if you want the agent's default URL, unchanged. It edits `Caddyfile` and
the compose file, so it is a team decision. Revert it after the test, or commit it on
purpose.

`Caddyfile`: add `default_sni` to the global block, and add the 8443 addresses to the
site list. Replace `192.168.1.50` with the server's LAN IP.

```caddy
{
	default_sni localhost
	log {
		output stdout
		format console
	}
}

https://localhost, https://cstam-server.local, https://localhost:8443, https://127.0.0.1:8443, https://192.168.1.50:8443 {
	tls internal
	reverse_proxy backend:3000 {
		header_up X-Real-IP {remote_host}
	}
}
```

`docker-compose.dev.yml`, `reverse-proxy.ports`: add `- "8443:8443"`.

Open the firewall on the server PC for 8443 (same command as in B, with
`-LocalPort 8443`). Then:

```powershell
$env:Agent__ServerUrl = "wss://127.0.0.1:8443/agent-ws"      # same PC
$env:Agent__ServerUrl = "wss://192.168.1.50:8443/agent-ws"   # LAN PC
```

After you edit the Caddyfile, run `npm run caddy:validate`, then `npm run caddy:reload`.
You can also restart the stack instead.

### Fallback for debugging only: skip TLS

If Caddy is the suspect, connect straight to Nest. The dev compose exposes port 3000:

```powershell
$env:Agent__ServerUrl = "ws://localhost:3000/agent-ws"   # or ws://192.168.1.50:3000/agent-ws with firewall 3000 open
```

This proves only the backend logic. It does not prove TLS. Do the final run through
Caddy.

---

## 1. Start the backend

On the server PC, in `back-end/`:

```powershell
# Docker Desktop must be running first.
npm run docker:dev
```

The `migrate` service applies `prisma/migrations/20260924120000_machine_presence`
automatically. Wait for the backend log line `listening on :3000` and
`agent-ws attached at /agent-ws`.

Sanity checks:

```powershell
Invoke-RestMethod http://localhost:3000/health          # status: ok, postgres up, redis up
curl.exe -k https://localhost/health                    # same thing through Caddy
```

If Prisma complains about unknown `status` or `lastSeen` fields, regenerate the client
in the container:

```powershell
npm run db:generate
```

## 2. Get a staff token and start the monitor

Seed the hq admin once. The defaults are `hq-admin` / `change-me-immediately`, and you
can override them with `SEED_ADMIN_USERNAME` and `SEED_ADMIN_PASSWORD`:

```powershell
npm run dc -- run --rm migrate npx prisma db seed
```

Log in, then start the monitor in a **second terminal**:

```powershell
$login = Invoke-RestMethod -Method Post -Uri http://localhost:3000/auth/login `
  -ContentType 'application/json' `
  -Body '{"username":"hq-admin","password":"change-me-immediately"}'
$env:TOKEN = $login.accessToken
npm run monitor
```

The header should show `[connected]`. The access token lives 15 minutes. The open
socket stays connected after that, but a reconnect needs a fresh token, so log in again
and restart the monitor.

Keep a third terminal for REST checks:

```powershell
$h = @{ Authorization = "Bearer $($login.accessToken)" }
Invoke-RestMethod http://localhost:3000/api/v1/stations -Headers $h | Format-Table
```

## 3. Start the agent

On the gaming PC, in `agent/Desktop-Agent/BaronDeskAgent/BaronDeskAgent.ServiceCore`:

```powershell
$env:Agent__ServerUrl    = "wss://localhost/agent-ws"   # from Setup A/B/C
$env:Agent__SerialNumber = "STATION-DEV-01"             # the station identity
dotnet run                                               # launchSettings sets DOTNET_ENVIRONMENT=Development (Debug logs)
```

You do not need to create a machine row first. In dev, an unknown serial gets a
provisional `MACHINE` row. The backend logs
`unknown station STATION-DEV-01: creating provisional MACHINE row (dev only)`.

---

## 4. Test steps and what to expect

Record the observed result of each step.

### Step 1: station goes ONLINE (expected within about 1s)

| Where | Expected |
|---|---|
| Agent log | `Handshake sent to server. Station=STATION-DEV-01` → `Handshake acknowledged by server.` → `State report sent on connect.` |
| Backend log | `agent connected: STATION-DEV-01 (<PC name>, v1.0.0) from <ip>` |
| Monitor | row `STATION-DEV-01  ONLINE` (green), event line `STATION-DEV-01 -> ONLINE` |
| REST | `/api/v1/stations` lists it with `status: ONLINE` |
| Agent log must **not** contain | `STALE`, `Rejected unauthorized or unknown message type`, `Certificate pinning mismatch` |

### Step 2: heartbeats keep it ONLINE (leave it running for about 30s)

The agent heartbeats every 15s.

- Agent log (Debug) shows `Heartbeat acknowledged by server. Lease updated: ...` about every 15s.
- Run the REST call twice, 15s or more apart. `lastSeen` advances.
- The monitor's LAST SEEN column stays under about 15s.
- Optional, check the cache and the database:
  ```powershell
  npm run redis:cli    # then: HGETALL node:STATION-DEV-01
  npm run db:psql      # then: select serial_number, status, last_seen, ip_address from machines;
  ```
  Redis `lastSeen` changes on every heartbeat. Postgres `last_seen` changes at most
  every 15s. This is the intended throttling.

### Step 3a: clean stop, OFFLINE immediately

Stop the agent with `Ctrl+C`, or close its window. You can also kill it with
`Stop-Process -Force`, because the OS still closes the TCP socket.

- Backend log: `station STATION-DEV-01 OFFLINE (socket closed)`
- Monitor: row turns red `OFFLINE`, and the event line shows `-> OFFLINE`.

### Step 3b: silent loss, OFFLINE through the watchdog (up to about 55s)

The socket must stay open while heartbeats stop, so no close event reaches the server.
Use one of these methods:

- **LAN PC:** unplug the network cable or disable Wi-Fi on the gaming PC.
- **Same PC:** run the agent under a debugger (Visual Studio or Rider) and use
  *Break All* to pause it.

Expected: after 45s without a heartbeat, plus up to 10s for the next watchdog sweep:

- Backend log: `station STATION-DEV-01 OFFLINE (heartbeat timeout)`
- Monitor: `-> OFFLINE`

If the network returns, or you resume the debugger, before the TCP connection dies, the
next heartbeat flips the station back to ONLINE on the same socket. That is expected.

### Step 4: restart, back to ONLINE

Start the agent again, or reconnect the network. The agent reconnects with backoff:
2s × 1.5ⁿ, at most 30s.

- The handshake sequence from step 1 repeats. The server's first frame is `seq 1` again,
  and no `STALE` appears.
- Monitor: `-> ONLINE`.

---

## 4C. Station commands: LOCK, UNLOCK, SHUTDOWN

The `migrate` service applies `prisma/migrations/20260926180000_station_commands`. Keep the
monitor running: its COMMANDS pane shows every command live (`command_update`), with type,
status, attempts, age and any nack code or failure reason.

Issue commands from another terminal with the same token. The `cmd` mode posts the
command, then polls it until it reaches a final status:

```powershell
npm run monitor -- cmd LOCK <serial>
```

The same call over plain HTTP:

```powershell
$station = (Invoke-RestMethod http://localhost:3000/api/v1/stations -Headers $h) |
  Where-Object serialNumber -eq '<serial>'
$cmd = Invoke-RestMethod -Method Post -Uri "http://localhost:3000/api/v1/stations/$($station.id)/commands" `
  -Headers $h -ContentType 'application/json' -Body '{"type":"LOCK"}'
Invoke-RestMethod "http://localhost:3000/api/v1/commands/$($cmd.commandId)" -Headers $h
```

The agent starts **locked** (fail-closed), so run the cases in this order. `ACKED` means
the agent **accepted** the command, not that it finished. The station's lock state is
the monitor's LOCKED column, which comes from the agent's heartbeat (about every 15s),
never from the command result. `cmd` mode prints it after the command settles.

| Case | Do | Expect |
|---|---|---|
| a. Direct UNLOCK | `cmd UNLOCK <serial>` | `ACKED`. Agent log: `Workstation unlocked directly`. Next heartbeat: LOCKED `no`. |
| b. Booking UNLOCK | `cmd LOCK <serial>`, then `cmd UNLOCK <serial> pin=4821` | `ACKED`, but LOCKED stays `yes`. Agent log: `Workstation remains locked ... PIN entry required on LockUI`. It unlocks only after `4821` is typed on the station's LockUI (needs `BaronDesk.LockUI` running). |
| c. Handler failure | `cmd LOCK <serial> exec_failed` | The backend sends a LAUNCH_GAME for `simulated-not-in-catalog` under this command id. Status `FAILED`, detail `EXEC_FAILED: ...` (the agent's reason: "must be unlocked with an active session" while locked, else "not in catalog"), tries `1` (not retried). |
| d. Stale send | `cmd LOCK <serial> stale_ts` | Agent log: `Stale message rejected`. Status `NACKED`, detail `STALE`, tries `1`. The lock state does not change. |
| e. Idempotency | `cmd UNLOCK <serial> duplicate_send` while locked | The agent gets the same command id twice, each with a fresh seq and ts. Agent log: one `unlocked directly`, then `Re-acknowledging idempotently`. Status `ACKED`. |
| f. Offline station | Stop the agent, wait for OFFLINE, then `cmd LOCK <serial>` | `409 STATION_OFFLINE`. No command row is created. |
| g. SHUTDOWN | `cmd SHUTDOWN <serial>` with the hq-admin token (manager+ only, staff get 403) | `ACKED`. The agent's power-off is still a stub (it only logs `System shutdown requested.`), so stop the agent yourself: the station goes OFFLINE and the command stays `ACKED`. |

`stale_ts`, `duplicate_send`, `invalid_payload` and `exec_failed` are dev-only. The
backend rejects them with 400 when `NODE_ENV=production`.

Nack handling: the agent sends `UNKNOWN_TYPE`, `INVALID_PAYLOAD`, `EXEC_FAILED` and
`STALE`. The first three end as `FAILED`, `STALE` as `NACKED`, always with the agent's
`reason`. No nack is retried.

A retry after an ack timeout (10s by default, `COMMAND_ACK_TIMEOUT_MS`) reuses the same
command id. To see a real retry, block the agent for more than 10s after it receives the
command. The row then shows `attempts 2`. If no ack arrives at all, the final status is
`TIMEOUT`.

---

## 4D. Station game catalog, LAUNCH_GAME and END_SESSION

The `migrate` service applies `prisma/migrations/20260927120000_station_game_catalog`.

How it fits together:

- **The agent pulls its catalog.** On every (re)connect, and on `CATALOG_UPDATE`, it calls
  `GET /stations/me/games` with `Authorization: Bearer <stationToken>` on the same host as
  `/agent-ws` (through Caddy on 443). The response is already resolved for that machine:
  only games assigned to its branch or to the station itself, with per-machine
  `target` / `arguments` / `workingDirectory` overrides applied.
- **Station auth is a dev stub.** Nothing verifies the token yet. In development the backend
  remembers which serial handshook on `/agent-ws` with that token, so the agent needs only
  `Agent__StationToken` set to any value. `x-station-serial: <serial>` also works for curl.
  In production the route answers 401 until station credentials exist.
- **The agent reports back.** After each sync it sends `catalog_status` (`installed` +
  `reason` per game). That is the only availability truth: the monitor's CATALOG column
  shows `installed/reported`, and LAUNCH_GAME is refused up front for a game the station has
  not reported as installed.
- **The launch is real.** LAUNCH_GAME carries only `{ gameId }`; the agent launches that
  entry from its synced catalog. An ack means the process was started. RUNNING GAME only
  updates from `state_report`, which the agent sends on reconnect, not on heartbeat.
- **END_SESSION stops the game itself,** then ends the session and locks. The backend sends no
  separate stop command.

Seed and assign a game with the hq-admin token (game-* need manager+). Use an exe that exists
on the test PC; Notepad works everywhere:

```powershell
npm run monitor -- game-add notepad exe C:\Windows\System32\notepad.exe name=Notepad process=notepad.exe
npm run monitor -- game-assign notepad <serial>          # this station only
npm run monitor -- catalog <serial>                      # exactly what the agent receives
npm run monitor -- station-games <serial>                # catalog + last catalog_status
```

To launch, the station must be unlocked with an active session. The current agent's UNLOCK
always needs a `sessionId`: run `cmd UNLOCK <serial> pin=0000`, and wait until LOCKED `no`
and SESSION shows an id (type the PIN on the LockUI if the station stays locked).

| Case | Do | Expect |
|---|---|---|
| a. Catalog sync | Start (or restart) the agent after `game-assign` | Backend log: `served catalog to <serial>: 1 game(s)`, then `catalog_status from <serial>: 1/1 launchable`. Agent log: `Game catalog synced: 1 games, 1 launchable here`. Monitor CATALOG `1/1`; `station-games` shows `installed`. |
| b. CATALOG_UPDATE | With the agent connected: `game-add steam-game steam 730 process=cs2.exe`, then `game-assign steam-game <serial>` | A `CATALOG_UPDATE` row goes `ACKED` in COMMANDS, the agent re-pulls, and a fresh `catalog_status` event line follows (CATALOG `x/2`; the steam game shows installed only if Steam and that app are on the PC). `cmd CATALOG_UPDATE <serial>` forces the same. |
| c. LAUNCH_GAME | Session active: `cmd LAUNCH_GAME <serial> game=notepad` | Notepad opens on the station. `ACKED`. Agent log: `Launched Notepad (notepad) via exe`. RUNNING GAME stays `-` until the agent reconnects (then `state_report` carries `notepad`). |
| d1. Invalid payload | `cmd LAUNCH_GAME <serial> game=notepad invalid_payload` | Wire gameId is empty. `FAILED`, detail `INVALID_PAYLOAD: gameId is required (1-128 characters).`, tries `1`. |
| d2. Agent refusal | `cmd LAUNCH_GAME <serial> game=notepad exec_failed` (in session, then again while locked) | `FAILED`, `EXEC_FAILED` with the agent's reason ("not in catalog", then "must be unlocked with an active session"), tries `1`. |
| d3. Refused up front | `cmd LAUNCH_GAME` for: an unknown id; a game not assigned to the station; a game reported not installed; any game while locked or without a session | `404 GAME_NOT_FOUND`, `409 GAME_NOT_ASSIGNED`, `409 GAME_NOT_INSTALLED` (with the agent's reason), `409 STATION_NOT_IN_SESSION`. Nothing reaches the agent. |
| e. Untracked launcher game | `cmd LAUNCH_GAME <serial> game=<a steam/epic game without process=>` | Launches, `ACKED`. Agent log: `has no processName in the catalog: it cannot be tracked or closed at session end`. The backend only records the ack. |
| f. END_SESSION | With Notepad running: `cmd END_SESSION <serial> reason=staff_end` | Agent log: `Stopping game notepad`. Notepad closes. `ACKED`; next heartbeat: SESSION `-`, LOCKED `yes`, RUNNING GAME `-`. COMMANDS shows only the END_SESSION row: no stop command was sent. |
| g. No session | `cmd END_SESSION <serial>` while SESSION is `-` | `409 NO_ACTIVE_SESSION`. No command row. |

END_SESSION only ends the session on the device. Billing and wallet close-out belong to
Member B, who subscribes to `PresenceService.sessionEnded` (`session.ended { machineId,
sessionId, reason }`). That event fires when the agent **reports** the session gone, not
on the ack.

---

## 5. Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| Agent: `Connection lost or could not be established` in a loop | Wrong URL, port or host. Check the setup in section 0. Test reachability with `Test-NetConnection 192.168.1.50 -Port 443` from the gaming PC. |
| Agent connects, but no handshake_ack. Backend closes with 4400 | Payload or `ts` rejected. Check the backend log for `malformed envelope` or `invalid handshake payload`. |
| Socket closed with 4408 after 10s | The server received no handshake. The agent never sent one, or the frames are not reaching Nest. |
| Socket closed with 4403 `unknown station` | `NODE_ENV=production`, where provisional rows are off. Create the machine row, or run in development. |
| Monitor `connect_error: invalid token` or `missing token` | Token expired or not set. Log in again (section 2). |
| Monitor connected, but no rows | The station was never seen, or the token belongs to a staff user of a different branch. The hq admin sees all branches. |
| IP column shows `172.x.x.x` or `192.168.65.x` | Docker Desktop NATs inbound traffic, so Caddy sees Docker's gateway, not the gaming PC. This is a known dev-only limitation. The real client IP appears when the stack runs on native Linux or with host networking. |
| `curl.exe -k https://192.168.1.50/...` fails but `https://localhost` works | This is the IP/SNI problem from section 0. Use Setup B or C. |

---

## 6. Cleanup after the phase

- Delete `scripts/node-monitor.ts` and the `"monitor"` script in `package.json`.
- Remove the hosts entry on the gaming PC and the firewall rules on the server PC:
  `Remove-NetFirewallRule -DisplayName "CSTAM Caddy 443"`.
- If you used Setup C, revert or deliberately commit the `Caddyfile` and compose changes.
- Provisional machine rows sit on the oldest branch, or on a branch named
  `Provisional (unenrolled stations)`. Delete them, or enroll them properly.
