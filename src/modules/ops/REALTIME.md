# Real-time layer

Two transports, both provided by `OpsModule`:

- **Agent (machine) <-> server**: raw `ws` at `/agent-ws` (`agent-gateway.ts`, `AgentGateway`).
- **Dashboard <-> server**: Socket.IO at path `/dashboard-io` (`dashboard-gateway.ts`, `DashboardGateway`).

Both exchange `Envelope` frames (`shared/types/realtime.ts`) so replay/ordering
(`seq`) and clock skew (`ts`) get checked the same way on both sides.

## Wiring

Nothing to wire by hand: `OpsModule` is imported by `AppModule`. Each gateway is an
injectable provider that attaches to the app's HTTP server in `onModuleInit` and
detaches in `onModuleDestroy`:

- `AgentGateway` creates a `ws` `WebSocketServer({ noServer: true })` and handles the
  HTTP `upgrade` event for `/agent-ws` only.
- `DashboardGateway` creates the Socket.IO server on `/dashboard-io`.

(They are plain providers rather than `@WebSocketGateway` classes because Nest allows
one WebSocket adapter per app and there are two transports here.)

To push an event to a branch's dashboards from business logic, import `OpsModule`
in your module and inject `DashboardGateway`:

```ts
constructor(@Inject(DashboardGateway) private readonly dashboard: DashboardGateway) {}

this.dashboard.publishToBranch(branchId, "telemetry_update", { machineId, metric: "cpu", value: 42 });
```

`branchId === null` targets the `branch:all` room (hq).

## Test it

```
npm test
```

`tests/agent-gateway.test.ts` boots the real app on an ephemeral port
(`startTestServer()`), drives a real `ws` client through handshake -> heartbeat -> a
replayed heartbeat, and asserts on `handshake_ack`, `heartbeat_ack`, and a
`command_nack` with reason `SEQ_REPLAYED`; a second case checks that a connection
without `machineId`/`token` is closed with code 4401.

`tests/dashboard-gateway.test.ts` boots the app, signs a real access token with
`TokenService`, connects a real `socket.io-client`, asserts it lands in
`branch:<branchId>` via the `hello` payload, then asserts
`DashboardGateway.publishToBranch(...)` is received as the matching event — plus a
second case asserting a token-less connection is rejected.

## Known stubs (skeleton only)

- `verifyStation` in `agent-gateway.ts` only checks that `machineId` and
  `token` are present in the query string — it does not yet verify the token
  against `Machine.agentPublicKey`.
- No command/business logic on the agent side yet (unlock/lock/etc.) — every
  agent message besides handshake/heartbeat gets a generic `ack`.
