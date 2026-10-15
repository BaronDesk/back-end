# Simulating network failures

Ways to reproduce a lost, slow or restarted connection between stations and the backend without unplugging cables. They are for tests and the demo only. The endpoints answer `400 SIMULATION_DISABLED` when `NODE_ENV=production`, the same guard the command simulations use.

| What you want to see | Use |
|---|---|
| One PC losing its network | [Drop one station](#drop-one-station) |
| The whole venue losing its network | [Drop a branch](#drop-a-branch-venue-outage) |
| The backend crashing or restarting mid-session | [Restart the backend](#restart-the-backend) |
| A slow or lossy network | [Add network delay](#slow-network-add-delay-on-the-host) |

## Drop one station

```http
POST /api/v1/stations/:machineId/simulate/network-drop
Authorization: Bearer <manager or admin token>
Content-Type: application/json

{ "seconds": 90 }
```

- The station's socket is terminated with no close handshake, like a pulled cable. For `seconds` (1–3600) its reconnects are refused with HTTP 503 before the WebSocket upgrade completes, and the agent keeps retrying on its own.
- Presence marks the station OFFLINE at once, and its session pauses at the last heartbeat. When it reconnects, the drop is classified as a **single** drop (`PresenceService.outageOf`): offline play is billed up to the lease, and the station is flagged for attention if the session was paid.
- Response: `{ machineId, serialNumber, droppedUntil, disconnected }`. `disconnected` is false when the station was not connected; its reconnects are refused all the same.
- The backend logs the start, every refused reconnect and the end:

  ```
  WARN [NetworkSimulationService] simulated network drop of station SN-1 for 90s started by <userId> (socket cut)
  LOG  [AgentGateway] agent-ws reconnect of SN-1 refused: simulated network drop, 74s left
  WARN [NetworkSimulationService] simulated outage of station SN-1 ended: reconnects accepted again
  ```

## Drop a branch (venue outage)

```http
POST /api/v1/branches/:branchId/simulate/network-drop
{ "seconds": 90 }
```

Every station of the branch that is connected is cut, and any station of the branch is refused until the outage ends, including one that was not connected. On reconnect, every station is classified as a **venue** outage, however few stations the branch has. No offline play is billed past the last heartbeat, and no station is flagged. Response: `{ branchId, droppedUntil, disconnected: [serialNumber, …] }`.

Notes for both endpoints:

- Managers can drop stations of their own branch only; HQ admins can drop any branch.
- A second drop of the same station or branch replaces the first one, and its end time starts from the second call.
- The outage is held in the backend's memory. A backend restart ends it.
- The drops still count towards the "keeps dropping" attention flag, as a real outage would. Clear the flag with `DELETE /api/v1/stations/:id/attention` after a demo.

## Restart the backend

```bash
node scripts/restart-backend.mjs                # crash: SIGKILL, down 30 s, started again
node scripts/restart-backend.mjs --down 90      # down longer than the lease: the PCs lock themselves
node scripts/restart-backend.mjs --graceful     # SIGTERM instead: Nest shuts down cleanly
```

The script lists the stations the database shows ONLINE, stops the `backend` container, waits for `--down` seconds, starts it again and waits until `/health` answers. It uses the same compose files as `npm run dc`, and changes neither them nor the other containers.

- **Crash** is the default. No socket is closed, so machine rows stay ONLINE with their last persisted `last_seen`. The new process marks a row OFFLINE at its first watchdog pass (`PRESENCE_WATCHDOG_INTERVAL_MS`, default 10 s), unless the station reconnects before that pass. Either way, its session pauses at that last contact: at the watchdog pass, or at the station's handshake.
- **Graceful** closes every socket on shutdown, so stations go OFFLINE straight away.

## Slow network: add delay on the host

Linux `tc netem` adds delay, jitter and loss to an interface's outgoing traffic. It needs root (or `CAP_NET_ADMIN`) and changes no compose file.

**Between stations and the backend, in Docker.** Apply it inside the `reverse-proxy` container's network namespace. Every station connection passes through that container, and Postgres and Redis traffic does not. A throw-away `netshoot` container joins the namespace with the capability, so the proxy container itself needs no change:

```bash
PROXY=cstam-ninety-backend-reverse-proxy-1
NETSHOOT="docker run --rm --net container:$PROXY --cap-add NET_ADMIN nicolaka/netshoot"

$NETSHOOT ip -br link                                                    # find the interface (usually eth0)
$NETSHOOT tc qdisc add dev eth0 root netem delay 300ms 100ms loss 2%     # 300 ms ±100 ms, 2 % loss
$NETSHOOT tc qdisc change dev eth0 root netem delay 2s                   # change it in place
$NETSHOOT tc qdisc show dev eth0
$NETSHOOT tc qdisc del dev eth0 root                                     # back to normal
```

The rule stays on the interface after `netshoot` exits, until you delete it or the proxy container is recreated. Because netem only shapes outgoing traffic, and the proxy forwards in both directions, both station → backend and backend → station are delayed.

**On a plain Linux host or station** (the backend not in Docker, or a Linux station PC), apply it to the network card that carries the station traffic:

```bash
sudo tc qdisc add dev enp3s0 root netem delay 300ms 100ms loss 2%
sudo tc qdisc del dev enp3s0 root
```

This slows **everything** on that card, including your SSH session. Use a large delay only on a test machine.

**Docker Desktop on Windows / macOS.** Use the `netshoot` commands above: they run inside Docker's Linux VM. On a Windows station PC, [clumsy](https://jagt.github.io/clumsy/) does the same with a filter such as `tcp.DstPort == 443`.

### What to expect at each delay (default timings)

| Delay (one way) | Effect |
|---|---|
| under ~1 s | Nothing visible: heartbeats (every 15 s) and leases (60 s) absorb it. |
| a few seconds | Commands wait for their ack (`COMMAND_ACK_TIMEOUT_MS`, 10 s). Above about 5 s one way, the ack misses the timeout: the command is retried with the same id (the agent re-acks it), then ends TIMEOUT. |
| over 30 s | Every agent frame falls outside the replay window and is dropped (`ts_out_of_window` in the log). The station goes OFFLINE after 45 s of silence (`PRESENCE_OFFLINE_AFTER_MS`), and locks itself when its lease lapses. |
| loss of a few % | Occasional retried commands. A heartbeat lost now and then is harmless, because the next one restates the station's state. |

Remove the rule when you are done: it slows every client of the proxy, dashboards included. The e2e suite is not affected, because it talks to its own in-process app.
