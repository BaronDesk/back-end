# Real-time layer

Two transports:

- **Agent (machine) <-> server**: raw `ws` at `GET /agent-ws` (`agent-gateway.ts`).
- **Dashboard <-> server**: Socket.IO at path `/dashboard-io` (`dashboard-gateway.ts`).

Both exchange `Envelope` frames (`shared/types/realtime.ts`) so replay/ordering
(`seq`) and clock skew (`ts`) get checked the same way on both sides.

## Install

```
npm install @fastify/websocket socket.io
npm install -D @types/ws socket.io-client
```

## Wire into app.ts

`agentGateway` registers its own `@fastify/websocket` plugin and route.
`initDashboardGateway` needs the raw Node HTTP server, which Fastify only
exposes once the app is listening (`app.server`), so call it after `createApp`
returns, or right before `app.listen` in `server.ts`.

```ts
import { agentGateway } from "./modules/ops/agent-gateway";
import { initDashboardGateway } from "./modules/ops/dashboard-gateway";

// inside createApp(), alongside apiRoutes:
await app.register(agentGateway);

// after createApp() returns (server.ts), or right before app.listen:
const io = initDashboardGateway(app.server);
```

`publishToBranch(io, branchId, event, payload)` is the one entry point
business logic should use to push a `DashboardEvent` to a branch's room (or
`branch:all` for hq, when `branchId` is `null`).

## Test it

```
npm test
```

`tests/agent-gateway.test.ts` boots the real app on an ephemeral port, drives
a real `ws` client through handshake -> heartbeat -> a replayed heartbeat, and
asserts on `handshake_ack`, `heartbeat_ack`, and a `command_nack` with reason
`SEQ_REPLAYED`.

`tests/dashboard-gateway.test.ts` boots the app + `initDashboardGateway`,
signs a real access token with `signAccessToken`, connects a real
`socket.io-client`, asserts it lands in `branch:<branchId>` via the `hello`
payload, then asserts `publishToBranch(io, branchId, ...)` is received as the
matching event — plus a second case asserting a token-less connection is
rejected.

## Known stubs (skeleton only)

- `verifyStation` in `agent-gateway.ts` only checks that `machineId` and
  `token` are present in the query string — it does not yet verify the token
  against `Machine.agentPublicKey`.
- No command/business logic on the agent side yet (unlock/lock/etc.) — every
  agent message besides handshake/heartbeat gets a generic `ack`.
