# CSTAM-NINETY physical test runbook

A real, multi-PC integration test on one LAN:

- **Server PC**: runs the backend stack (Docker), the seed and the live observer.
- **Station PCs**: each team member's Windows PC runs the real BaronDesk desktop agent.

Everything in `tools/physical-test/` is throwaway test tooling. Delete the folder when the
test is over. Nothing here changes the backend or the agent.

| File | What it is |
|---|---|
| `seed.ts` | One-command, idempotent venue setup (branch, admin, stations + tokens, pricing, plans, games, gamers, reservations) |
| `serve-observer.mjs` | Serves the observer page and forwards its calls to the backend |
| `observer/index.html` | Live observer and control strip. The room watches this during the test |
| `out/` | Created by the seed. Holds tokens and passwords. Git-ignored. Do not share outside the team |

Versions tested against: backend branch `feat/session-billing`, agent repo `Desktop-Agent`
branch `main` (commit `90dffb1` or later).

---

## 0. Before the day

### 0.1 People and roles

| Role | Who | Does |
|---|---|---|
| **Operator** | The person at the server PC | Runs the stack, the seed and the observer, clicks the controls |
| **Station member** | One person per station PC | Runs the agent on their PC, types PINs, unplugs devices and cables when asked |

### 0.2 What each machine needs

| Machine | Needs |
|---|---|
| Server PC | Windows with Docker Desktop running, Node.js 22.23 or later, the backend repo on `feat/session-billing` with `npm install` done once on the host, a `.env` (copy of `.env.example`, `NODE_ENV=development`) |
| Station PC | Windows 10/11, .NET 10 SDK, the agent repo on `main`, a **wired USB** mouse or keyboard (for the anti-theft test), admin rights (for CPU temperatures and the hosts file) |
| Network | All PCs on the same LAN (same Wi-Fi or switch). Guest Wi-Fi often isolates clients: avoid it |

### 0.3 Collect the station names

Each station member runs this on their PC and sends the result to the operator:

```powershell
hostname
```

The operator uses these names as the station serial numbers, for example `PC-ALICE,PC-BOB`.
Allowed characters: letters, digits, `.`, `_`, `-`.

### 0.4 Sync the clocks (every PC)

The backend drops frames more than **30 seconds** off its own clock. In an elevated PowerShell:

```powershell
w32tm /resync
```

If it fails, open Settings > Time & language > Date & time > **Sync now**.

---

## 1. Server setup (operator)

All commands run in PowerShell, in the backend repo root:

```powershell
cd "<path>\back-end"
git switch feat/session-billing
```

### 1.1 Start the stack (terminal 1, leave it open)

```powershell
npm run docker:dev
```

Wait for `listening on :3000` and `agent-ws attached at /agent-ws` in the output.

### 1.2 Apply migrations (terminal 2, first time only)

```powershell
npm run db:deploy
```

### 1.3 Seed the venue

Replace the names with the ones collected in §0.3:

```powershell
npm run dc -- exec -e PT_STATIONS="PC-ALICE,PC-BOB" backend npx tsx tools/physical-test/seed.ts
```

Expected output (IDs and tokens differ):

```text
PT seed done. Branch "PT Venue" (…)
Observer / dashboard login: pt-admin / pt-admin-2026!
Pricing: 6000 cents/hour = 100 cents/min; members 50% off

== Station PC-ALICE  (machine …)
   agent script : tools/physical-test/out/agent-PC-ALICE.ps1
   token        : eyJhbGciOiJIUzI1NiIsInR5… (≈320 chars, valid 7d)
   standard : pt-gamer-1 / pt-gamer-2026!  wallet 10000 cents  reservation …
   member   : pt-member-1 / pt-gamer-2026!  wallet 9500 cents  reservation …
```

What the seed creates:

| Item | Value |
|---|---|
| Branch | `PT Venue` |
| Admin (hq) | `pt-admin` / `pt-admin-2026!` |
| Stations | One MACHINE row per name, `ENROLLED`, plus a 7-day station token each |
| Pricing | 6000 cents/hour = **100 cents (1.00) per minute** |
| Membership plan | `PT Gold (50% off)`, price 5.00, 30 days |
| Subscription plan | `PT Night Owl`, 18:00 to 23:59, 20% (not applied to billing, see §5) |
| Games per station | `charmap` (Character Map) and `calc` (Calculator) |
| Gamers per station *n* | `pt-gamer-n` (wallet 100.00) and `pt-member-n` (wallet 100.00, bought the membership: 95.00 left) |
| Reservations | One CONFIRMED reservation per gamer on its station, from now for 4 hours |

> **Dev shortcut.** The real enrollment flow (`POST /enrollment/request` with admin approval)
> is not built yet. The seed writes the ENROLLED MACHINE rows and mints the station JWTs
> itself, with the same claims and key as enrollment must use. Everything else goes through
> the backend's REST API.

Run the seed again at any time: it reuses what exists, re-mints tokens, and creates a fresh
reservation for a gamer whose reservation was already used. Add a station by running it with
the longer list.

### 1.4 Start the observer (terminal 3, leave it open)

```powershell
node tools/physical-test/serve-observer.mjs
```

Open **http://localhost:8080** on the server PC. Log in with `pt-admin` / `pt-admin-2026!`.
Each station has a card, and the header pill reads **feed: live**.

To show it on another PC or a projector in the room, start it with
`$env:PT_OBSERVER_HOST = "0.0.0.0"` before the command, allow port 8080 in the firewall, and
open `http://<server IP>:8080`. This is plain HTTP, so use it only on the test network.

### 1.5 Send each member their agent script

Give each member **their own** file `tools/physical-test/out/agent-<their PC name>.ps1`
(USB stick, shared folder or direct message). It contains their station token.

---

## 2. Make the server reachable on the LAN (operator)

The agents dial `wss://cstam-server.local/agent-ws` and `https://cstam-server.local/stations/me/games`.
Caddy already serves the name `cstam-server.local`, so its certificate needs no change.
Each station PC only has to resolve that name to the server's IP.

### 2.1 Find the server's LAN IP

```powershell
Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.InterfaceAlias -notmatch 'vEthernet|Loopback|WSL' } | Select-Object InterfaceAlias, IPAddress
```

Write it down, for example `192.168.1.50`.

### 2.2 Open port 443 on the server (elevated PowerShell)

```powershell
New-NetFirewallRule -DisplayName "CSTAM Caddy 443" -Direction Inbound -Protocol TCP -LocalPort 443 -Action Allow -Profile Private,Domain
Get-NetConnectionProfile
```

If `NetworkCategory` is `Public`, switch it (use the alias shown):

```powershell
Set-NetConnectionProfile -InterfaceAlias "Wi-Fi" -NetworkCategory Private
```

If Docker Desktop asks for firewall access, allow it on private networks.

### 2.3 Point each station PC at the server (each member, elevated PowerShell)

```powershell
Add-Content -Path "$env:SystemRoot\System32\drivers\etc\hosts" -Value "`n192.168.1.50  cstam-server.local"
ipconfig /flushdns
```

Replace `192.168.1.50` with the IP from §2.1.

### 2.4 Reachability check (each member, before starting the agent)

```powershell
curl.exe -k https://cstam-server.local/health
```

Expected: a JSON answer containing `"status":"ok"`. If it hangs or fails, check
`Test-NetConnection cstam-server.local -Port 443` (must print `TcpTestSucceeded : True`),
the hosts line, the firewall rule and that both PCs are on the same network.

### 2.5 Optional: dial the IP instead of a name

Only if a hosts file cannot be edited. An IP carries no TLS server name, so Caddy needs a
default. Edit the `Caddyfile` on the server (add the global option and the IP):

```caddyfile
{
	default_sni cstam-server.local
	log {
		output stdout
		format console
	}
}

https://localhost, https://cstam-server.local, https://192.168.1.50 {
```

Then run `npm run caddy:reload`, and use `wss://192.168.1.50/agent-ws` as the server URL. Revert
the `Caddyfile` after the test.

---

## 3. Station setup (each member)

### 3.1 Get the agent ready

```powershell
cd "<path>\Desktop-Agent"
git switch main
git pull
dotnet build
```

If you ever stored a station token on this PC with `--set-station-token`, that stored token
**overrides** the script's token. Clear it once, in an **elevated** PowerShell:

```powershell
dotnet run --project src/BaronDeskAgent.ServiceCore -- --clear-station-token
```

### 3.2 Start the lock screen (terminal A)

```powershell
dotnet run --project src/BaronDesk.LockUI -- --windowed
```

`--windowed` shows the lock screen in a normal window titled
`BaronDesk LockUI — TEST MODE — LOCKED/UNLOCKED`. It is safer for a first run. For the real
full-screen lock, start it without `-- --windowed`. In a Debug build,
**Ctrl+Alt+Shift+F12** closes the full-screen lock screen if the agent is gone.

### 3.3 Start the agent (terminal B, PowerShell "Run as administrator" for CPU temperatures)

```powershell
cd "<path>\Desktop-Agent"
.\agent-PC-ALICE.ps1
```

(Copy your `agent-<PC name>.ps1` into the `Desktop-Agent` folder first. If scripts are
blocked, run `powershell -ExecutionPolicy Bypass -File .\agent-PC-ALICE.ps1`.)

The script sets:

| Setting | Value | Why |
|---|---|---|
| `DOTNET_ENVIRONMENT` | `Development` | Allows the two dev-only settings below |
| `Agent__ServerUrl` | `wss://cstam-server.local/agent-ws` | The server through Caddy on 443 |
| `Agent__AllowUntrustedCertificate` | `true` | Caddy's internal certificate is not pinned in dev |
| `Agent__PinnedCertificateHash` | empty | No pin in dev |
| `Agent__SerialNumber` | your PC name | Must equal the token's serial |
| `Agent__StationToken` | your token | Station credential (plain text: dev only) |

### 3.4 Confirm it connected

| Where | What you should see |
|---|---|
| Agent terminal | `AllowUntrustedCertificate is on …`, `Connected to wss://cstam-server.local/agent-ws.`, `Handshake acknowledged …` |
| Server terminal 1 | `agent connected: PC-ALICE [machine …, branch …] (PC-ALICE, v1.0.0) from <ip>`, then `served catalog to PC-ALICE` |
| Observer | The card turns **ONLINE**, shows an IP, `last seen` counts up to about 15 s and resets. The log shows `catalog_status: 2/2 launchable` |

The IP may show a Docker address (`172.x` or `192.168.65.x`) instead of the PC's own: Docker
Desktop hides client IPs. This is expected in dev.

---

## 4. Test scenarios

Run them in order. For each step, write **P** (as expected) or **F** (different) and what you saw.

Where to look:
- **Observer card**: the station's card on http://localhost:8080.
- **Observer log**: the "Event log" column on the right.
- **Server log**: terminal 1 on the server PC.
- **Station**: the member's screen and agent terminal.

### a. Connection and rejection

| # | Actor | Action | Expected | Where | P/F |
|---|---|---|---|---|---|
| a1 | Every member | Start the agent (§3.3) | Card **ONLINE** with an IP; `agent connected: <name>` | Observer card, server log | |
| a2 | One member | Stop the agent (Ctrl+C) | Card **OFFLINE** within about 1 s; log `<name> OFFLINE` | Observer | |
| a3 | Same member | Edit the script: change one character in the middle of the token, run it | Never connects. Server log: `agent-ws upgrade rejected (<ip>): …`. Agent retries with backoff. Card stays **OFFLINE** | Server log, agent terminal | |
| a4 | Same member | Delete the `Agent__StationToken` line, open a **new** PowerShell, run it | Never connects: with no credential the agent tries enrollment (`/enrollment/request`), which is not built, and never opens `/agent-ws`. Card stays **OFFLINE** | Agent terminal | |
| a5 | Same member | Restore the original script (from `out/`), run it in a new PowerShell | Back **ONLINE** | Observer | |

### b. Live telemetry

| # | Actor | Action | Expected | Where | P/F |
|---|---|---|---|---|---|
| b1 | Operator | Watch each card for 1 minute | Telemetry section filled: CPU load, RAM %, GPU temp and load (when the GPU exposes them). CPU temperature only when the agent runs as administrator. "x s ago" stays low | Observer card | |
| b2 | One member | Load the CPU: `1..4 \| ForEach-Object { Start-Job { while ($true) {} } }` | CPU load and temperature rise within a few seconds on that card only | Observer card | |
| b3 | Same member | Stop it: `Get-Job \| Stop-Job; Get-Job \| Remove-Job` | Values drop back | Observer card | |

### c. Anti-theft (USB)

The agent watches **wired USB keyboards and mice** that were plugged in when it started.
Wireless dongles and Bluetooth devices are not watched.

| # | Actor | Action | Expected | Where | P/F |
|---|---|---|---|---|---|
| c1 | One member | Unplug the wired USB mouse or keyboard, keep it unplugged for **10 s** | A **CRITICAL** `anti_theft / HARDWARE_FAILURE` alert on that card: "Peripheral removed and not reconnected: <device> (VID_…&PID_…)". Server log `alert anti_theft/…` | Observer card and log | |
| c2 | Same member | Plug it back, unplug it again and replug within **3 s** | No new alert (reconnected inside the 5 s debounce window) | Observer card | |
| c3 | Operator | Click **Resolve** on the alert | The alert disappears from the card | Observer card | |

### d. Remote lock, unlock, shutdown

Start with the station locked (click **Lock** first if needed).

| # | Actor | Action | Expected | Where | P/F |
|---|---|---|---|---|---|
| d1 | Operator | Click **Unlock** | Last command `UNLOCK ACKED`. Lock screen goes away (windowed mode: banner **UNLOCKED**). Card shows **UNLOCKED** within 15 s | Observer, station | |
| d2 | Operator | Click **Lock** | `LOCK ACKED`. Lock screen covers the desktop. Card **LOCKED** within 15 s | Observer, station | |
| d3 | Station member | **Save your work first.** Say "ready" | - | - | |
| d4 | Operator | Click **Shutdown**, type the station name to confirm | `SHUTDOWN ACKED`. **The PC really shuts down within about 2 s, forcing apps closed.** Card goes **OFFLINE** at once (socket closed), or at most about 55 s later through the watchdog | Observer, station | |
| d5 | Station member | Power the PC back on, restart LockUI and the agent (§3.2, §3.3) | Card back **ONLINE** | Observer | |

### e. Games

| # | Actor | Action | Expected | Where | P/F |
|---|---|---|---|---|---|
| e1 | Operator | Right after a station connects, read the log | `catalog_status: 2/2 launchable`. Both **Launch** buttons have no ⚠ | Observer log and card | |
| e2 | Operator | Station **locked**, no session: click **Launch charmap** | Refused before sending: error `409 STATION_NOT_IN_SESSION` on the card | Observer card | |
| e3 | Operator | During an **active** session (after f4): click **Launch charmap** | `LAUNCH_GAME ACKED`, and **Character Map opens** on the station (the agent's launcher is real on `main`) | Observer, station | |
| e4 | Operator | Click **Launch calc** | `ACKED`. Character Map closes and Calculator opens | Station | |
| e5 | Operator | Click **Catalog sync** | `CATALOG_UPDATE ACKED`, then a new `catalog_status: 2/2 launchable` | Observer log | |

### f. Session and billing

Uses the standard gamer (`pt-gamer-n`, 1.00 per minute, wallet 100.00).

| # | Actor | Action | Expected | Where | P/F |
|---|---|---|---|---|---|
| f1 | Operator | Click **Lock** so the station starts locked | **LOCKED** | Observer | |
| f2 | Operator | Click **Start session (pt-gamer-n)** | Session panel: status **PENDING**, rate **100 c/min**, and a 4-digit **PIN** in large yellow digits. Log `UNLOCK ACKED` | Observer card | |
| f3 | Station member | The lock screen asks for a PIN. Type a **wrong** PIN | Refused. Stays locked. Session stays **PENDING** | Station, observer | |
| f4 | Station member | Type the **right** PIN | Desktop unlocks. Within 15 s: card **UNLOCKED**, session **ACTIVE**, "metered (live est.)" and "cost so far" start counting | Station, observer | |
| f5 | Everyone | Play for **2 minutes** (try e3, e4 here) | Cost so far ≈ 2.00 | Observer | |
| f6 | Operator | Click **Lock**, wait 1 minute | Session **PAUSED**; cost stops growing while locked | Observer | |
| f7 | Operator | Click **Unlock** | Session **ACTIVE** again | Observer | |
| f8 | Operator | Click **End session** | Log `END_SESSION ACKED`. Station: game closes, lock screen returns. Within 15 s the session turns **COMPLETED** with "Settled: *N*s x 100 c/min = *X* debited" | Observer, station | |
| f9 | Operator | Read the wallet line of `pt-gamer-n` | Balance drops by exactly the settled amount (red delta), for example 100.00 → 97.00 after about 3 active minutes | Observer card | |

The metered time counts only unlocked, active time. Paused time (f6) is not billed.

### g. Membership discount

Uses the member gamer (`pt-member-n`, who bought `PT Gold (50% off)` in the seed).

| # | Actor | Action | Expected | Where | P/F |
|---|---|---|---|---|---|
| g1 | Operator | **Lock**, then **Start session (pt-member-n, member)** | Rate **50 c/min** (half of 100); membership **applied** | Observer card | |
| g2 | Station member | Type the PIN, play 2 minutes | Cost so far ≈ 1.00 | Observer | |
| g3 | Operator | **End session** | Settled at 50 c/min; `pt-member-n` wallet drops by the settled amount (from 95.00) | Observer | |

### h. Network loss

Real behaviour today, which differs from what you might expect. Read the notes before
marking a step F.

| # | Actor | Action | Expected | Where | P/F |
|---|---|---|---|---|---|
| h1 | Operator + member | Start a standard session and unlock with the PIN (f1 to f4) | Session **ACTIVE** | Observer | |
| h2 | Station member | Unplug the network cable or turn Wi-Fi off. Note the time | Nothing visible for about 45 s | - | |
| h3 | Operator | Watch the card | **OFFLINE** 45 to 55 s after the cut (watchdog). **The session stays ACTIVE and keeps metering**: the backend does not pause billing on OFFLINE (known gap, §5) | Observer | |
| h4 | Station member | Watch the screen, still offline | About **70 s** after the cut (60 s lease + 10 s grace) the station **locks itself** and ends its session locally ("fail-closed"), and any game closes | Station | |
| h5 | Station member | Reconnect the network | The agent reconnects on its own within about 30 s. Card **ONLINE**, **LOCKED**, agent session cleared | Observer | |
| h6 | Operator | Watch the session panel | The server learns the session is gone from the agent's state report and settles it: **COMPLETED**, reason `agent_reported` in the server log (`session … ended on … (agent_reported)`). The billed time runs **until the reconnect**, so it includes the offline minutes | Observer, server log | |
| h7 | Both | Repeat h1 to h5 with a **short** cut (reconnect after about 20 s) | Card may not even go OFFLINE; the station stays unlocked and the session stays **ACTIVE** (the lease survives a short cut) | Observer, station | |

---

## 5. Not expected to work (do not report as bugs)

| Item | What happens today |
|---|---|
| Run-out auto-lock | No timer locks a station when the wallet runs out. A session keeps going; settlement then fails to debit and shows **DEBIT FAILED** |
| Rate-period segmentation | One rate for the whole session, fixed at start (no peak/off-peak split) |
| Subscription time-window billing | `PT Night Owl` windows are not applied to session rates. Only the membership discount is |
| Billing pause while OFFLINE | Metering continues while a station is OFFLINE (h3, h6) |
| Running game in the observer | `running game` updates only when the agent reconnects (it is sent in the state report, not in heartbeats). It shows `-` right after a launch |
| Real enrollment | Stations are seeded, not enrolled (§1.3) |
| Station IP | Shows a Docker address in dev (§3.4) |
| Dashboard feed access | Any logged-in user can open the dashboard feed today, gamers included; a gamer sees every branch. Known security gap, not part of this test |

Corrections to earlier assumptions, checked against the agent code on `main`:

- **SHUTDOWN is real**: it runs `shutdown.exe` (forced, 2 s delay). It is not a stub. Save work first (d3).
- **Game launch is real**: the game opens on the station's desktop (e3). It is not stubbed.

---

## 6. Reset and cleanup

Between runs:

- **New reservations**: run the seed again (§1.3). It creates a fresh one for each gamer whose
  reservation was used. Wallets are **not** topped up again (the top-up has an idempotency key).
  To add money, use the console `node scripts/station-console.mjs` (menu `w`, credit) or re-seed on a reset database.
- **Stuck session** (PENDING or ACTIVE after a failed run): click **End session** on the card.

After the test:

1. Stop the agents (Ctrl+C) and LockUI on every station.
2. Remove the hosts line from each station PC (`notepad $env:SystemRoot\System32\drivers\etc\hosts`, elevated).
3. On the server: `Remove-NetFirewallRule -DisplayName "CSTAM Caddy 443"`, and revert the `Caddyfile` if you used §2.5.
4. `npm run docker:down`.
5. Optional, **deletes all data**: `npm run db:reset`.
6. Delete `tools/physical-test/` (it holds tokens and passwords in `out/`).

---

## 7. Troubleshooting

| Symptom | Cause and fix |
|---|---|
| Seed: `PT_STATIONS is empty` | Pass `-e PT_STATIONS="…"` exactly as in §1.3 |
| Seed: `fetch failed` / `ECONNREFUSED` | The backend in the container is not up yet. Wait for `listening on :3000` |
| Observer: "No seed output" | Run the seed, then reload the page |
| Observer: `feed: error` | Wrong login, or the backend is down. Log in again |
| Agent: `Connection lost or could not be established` in a loop | The server is not reachable: redo §2.4 |
| Server log: `agent-ws upgrade rejected` | Token wrong or expired: use the script from the latest seed run, and clear any stored token (§3.1) |
| Agent closes with 1008 `serial number does not match station token` | `Agent__SerialNumber` differs from the name you gave the operator |
| Agent closes with 1008 `station token does not match the station` | The seed ran again and moved the station. Use the new script |
| Close 4400 or frames ignored | Clock drift: redo §0.4 on both PCs |
| No CPU temperature | Run the agent terminal as administrator |
| No anti-theft alert | The device is wireless or was plugged in after the agent started. Use a wired USB mouse or keyboard plugged in before starting the agent |
| Launch refused `GAME_NOT_INSTALLED` | The station reported the exe missing. Check `C:\Windows\System32\charmap.exe` exists on that PC |
