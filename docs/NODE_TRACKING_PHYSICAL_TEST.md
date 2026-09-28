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
   ipconfig   # e.g. IPv4 Address . . . : 192.168.137.1
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
