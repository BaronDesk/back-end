# Station enrollment: handoff

This note is for whoever builds station enrollment in the backend. It explains
what already exists on both sides, the exact contract enrollment must fulfil so
that stations are admitted by the current code, and a suggested design.

Read [STATION_AGENT.md](STATION_AGENT.md) §2 first: it describes the station token and the
admission rule that enrollment feeds.

---

## 1. Where things stand

**Backend (done, on `main` after this merge)**

- Stations authenticate only with a station JWT (`Authorization: Bearer`), on the
  `/agent-ws` upgrade and on `GET /stations/me/games`.
- A valid token is admitted only if its MACHINE row exists, is `ENROLLED`, and still
  has the token's `serialNumber` and `branchId`.
- Nothing creates MACHINE rows automatically anymore. Enrollment is the only
  intended way a station comes into existence.

**Agent (done, `Desktop-Agent` repo)**

The agent already has a full enrollment client. See `docs/Enrollment.md` and
`src/BaronDesk.Shared/Contracts/EnrollmentContracts.cs` in the agent repo. Its
mock server (`tools/mock-server/mock-server.js`) implements the server side and
is a useful reference.

**Missing: everything in between.** No enrollment endpoint, no one-time tokens,
no approval, no code that mints station tokens outside tests.

---

## 2. The agent's side of the contract

The agent calls this before it ever opens `/agent-ws`, when it has no station
credential and an admin has provisioned a one-time token on the PC.

### 2.1 Request

`POST /enrollment/request`, **no `api/v1` prefix**. The agent derives the URL from
its server host: `wss://host:port/agent-ws` becomes `https://host:port/enrollment/request`
(overridable with `Agent:EnrollmentUrl`). It uses the same pinned TLS certificate
as the WebSocket.

```json
{
  "oneTimeToken": "enroll-7f3c9a...",
  "mac": "00-1A-2B-3C-4D-5E",
  "ip": "192.168.1.23",
  "serialNumber": "STATION-DEV-01",
  "machineName": "GAMING-PC-07",
  "agentVersion": "1.0.0",
  "agentPublicKey": "<base64 DER SubjectPublicKeyInfo, ECDSA P-256>",
  "signedAt": "2026-09-28T10:00:00.0000000+00:00",
  "signature": "<base64 DER ECDSA-SHA256 signature>"
}
```

The signature covers these UTF-8 lines joined with `\n`:

```text
BARONDESK-ENROLL-V1
<oneTimeToken>
<serialNumber>
<mac>
<ip>
<agentPublicKey>
<signedAt>
```

Verify it in Node:

```ts
import { verify } from 'node:crypto';

const input = Buffer.from(
  ['BARONDESK-ENROLL-V1', b.oneTimeToken, b.serialNumber, b.mac, b.ip, b.agentPublicKey, b.signedAt].join('\n'),
  'utf8',
);
const ok = verify(
  'sha256',
  input,
  { key: Buffer.from(b.agentPublicKey, 'base64'), format: 'der', type: 'spki' },
  Buffer.from(b.signature, 'base64'), // DER encoding is Node's default for EC keys
);
```

### 2.2 Response

| Situation | HTTP | Body | Agent behaviour |
|---|---|---|---|
| Waiting for admin approval | 200 | `{ "status": "PENDING" }` | Re-sends the same request (same key, newer `signedAt`) every `EnrollmentPollSeconds` (15 s) |
| Approved | 200 | `{ "status": "ENROLLED", "stationToken": "<jwt>", "machineId": "<uuid>" }` | Stores the JWT in DPAPI, deletes the one-time token, connects to `/agent-ws` |
| Refused | 200 with `{ "status": "REJECTED", "reason": "..." }`, or 401 / 403 / 410 (optionally with `reason`) | | Deletes the one-time token, stays unenrolled and locked |
| Bad request, 5xx, network error | 400 / 5xx | | Retries with backoff |

Rules:

- `ENROLLED` without a usable `stationToken` is treated as an error and polled again.
- `stationToken` must be 1 to 8192 printable ASCII characters without spaces (a JWT is fine).
- The response must stay under 64 KB. The agent times out after 15 s.
- In the agent's contract, `status: "PENDING"` and the fields `oneTimeToken`, `mac`, `ip` are
  frozen. The rest was proposed by the agent and is marked "to confirm with the backend".
  Implementing exactly the shape above confirms it.

### 2.3 Security checks the agent expects

From the agent's `Enrollment.md` §4:

1. The one-time token is valid, not expired and not spent.
2. `signature` verifies against `agentPublicKey`.
3. The first accepted request **pins** `agentPublicKey` to the pending machine. A later
   request with another key is refused.
4. `stationToken` is released only to a request signed by the pinned key, with a
   `signedAt` newer than the last one seen. Stealing the one-time token alone is not
   enough to collect the credential.
5. `mac` and `ip` are shown to the approving admin. They are not identity.

---

## 3. What enrollment must produce

The current admission code accepts a station only if both of these hold.

### 3.1 The MACHINE row

| Column | Value |
|---|---|
| `id` | uuid. Becomes the token's `sub` |
| `serial_number` | The request's `serialNumber`. Unique |
| `branch_id` | The branch the station belongs to. Becomes the token's `branchId` |
| `agent_public_key` | The request's `agentPublicKey` (column is required, currently unused elsewhere) |
| `enrollment_status` | `PENDING` while waiting, `ENROLLED` once approved |
| `name` | `machineName` (presence overwrites it from the handshake anyway) |

`MachineEnrollmentStatus` is `PENDING | ENROLLED | INACTIVE | DEACTIVATED`. Only
`ENROLLED` is admitted. The agent's `REJECTED` is a response status, not a column value.

### 3.2 The station JWT

Mint it exactly like `mintStationToken` in [test/station-token.ts](../test/station-token.ts):

```ts
jwtService.sign(
  { sub: machine.id, type: 'station', serialNumber: machine.serialNumber, branchId: machine.branchId },
  { secret: config.getOrThrow('JWT_ACCESS_SECRET'), expiresIn: STATION_TOKEN_TTL },
);
```

- Algorithm HS256 (JwtModule default), key `JWT_ACCESS_SECRET`.
- Claim names and `type: "station"` must match: `StationTokenService.verify` validates
  them with a strict schema.
- `exp` is **required**. Pick a long TTL (months) and plan rotation (§5).

Recommended: add a `sign(machine)` method to
[StationTokenService](../src/modules/station/services/station-token.service.ts) next to
`verify`, so the claim shape lives in one file. Then make `test/station-token.ts` call it.

---

## 4. Suggested design

This is a proposal. Adjust it, but keep §2 and §3 intact.

### 4.1 Data

New table, for example `enrollment_tokens`:

| Column | Notes |
|---|---|
| `id` | uuid |
| `token_hash` | SHA-256 of the one-time token. Never store the plaintext |
| `branch_id` | The branch the new station joins. This is where `Machine.branchId` comes from |
| `created_by` | Admin user id |
| `expires_at` | Short, for example 24 h |
| `machine_id` | Null until the first valid request claims it |
| `spent_at` | Set on ENROLLED or REJECTED |

Plus, on the machine (or on the token row): `last_signed_at`, to enforce "newer `signedAt`".

### 4.2 Flow

```text
Admin                     Backend                                      Agent
  │ POST /api/v1/enrollment/tokens {branchId}                           │
  │──────────────────────►│ store hash, return plaintext once           │
  │◄──────────────────────│                                             │
  │ gives token to the PC (--set-enrollment-token)                      │
  │                       │◄── POST /enrollment/request (signed) ───────│
  │                       │ token valid? signature valid?               │
  │                       │ create MACHINE PENDING, pin public key      │
  │                       │─── { status: PENDING } ────────────────────►│
  │ GET pending stations  │                                             │
  │ POST .../approve      │ enrollmentStatus = ENROLLED                 │
  │──────────────────────►│                                             │
  │                       │◄── same request, newer signedAt ────────────│
  │                       │ same key? newer? mint station JWT,          │
  │                       │ spend one-time token                        │
  │                       │─── { ENROLLED, stationToken, machineId } ──►│
  │                       │◄── WSS /agent-ws, Bearer <jwt> ─────────────│ admitted by existing code
```

### 4.3 Endpoints

| Route | Auth | Purpose |
|---|---|---|
| `POST /enrollment/request` | `@Public()`, **no** `StationAuthGuard` | The agent's endpoint (§2). Rate-limit it |
| `POST /api/v1/enrollment/tokens` | admin+ | Generate a one-time token for a branch |
| `GET /api/v1/stations?enrollmentStatus=PENDING` (or a dedicated route) | admin+ | Pending stations with `mac`, `ip`, `machineName`, serial |
| `POST /api/v1/stations/:id/enrollment/approve` | admin+ | PENDING → ENROLLED |
| `POST /api/v1/stations/:id/enrollment/reject` | admin+ | Spend the token. The next agent poll gets REJECTED |
| `POST /api/v1/stations/:id/enrollment/revoke` | admin+ | ENROLLED → DEACTIVATED, and close the live socket (§5) |

Branch scoping: use `assertScope` like the other station routes, so a branch admin
only sees and approves stations of their own branch.

### 4.4 Where the code goes

- A new `enrollment` module, or a folder inside `station`. It needs `MachinesRepository`
  and `StationTokenService` (export them from `StationModule`).
- Do not put enrollment logic in `AgentGateway` or `PresenceService`. They only
  consume the result.

---

## 5. Things the current code leaves to enrollment

> **Status 2026-10-01:** items 1, 2 and 4 are done (`FLOW_FIXES.md` §3, C1–C4). Item 3 is still
> open.

1. **Close the live socket on revoke.** Setting `enrollmentStatus` to DEACTIVATED today
   only blocks the **next** connect. Suggested hook, following the existing
   `statusChanges` pattern (ops subscribes to station, never the reverse):
   - `StationModule` exposes a `Subject<{ serialNumber, reason }>` (for example
     `stationRevoked`).
   - `AgentGateway` subscribes and calls `registry.get(serial)?.close(1008, 'station not enrolled')`.
   - Presence then marks it OFFLINE through the normal close path.
   - **Done (C1):** reject and revoke close the socket with 1008; revoke also settles the
     station's open session and cancels its bookings ahead.
2. **Token rotation.** Nothing renews a station token before `exp`. The agent re-reads
   its credential on every connect, so a future renewal endpoint (for example
   `POST /stations/me/token`, station-authenticated, returns a fresh JWT) needs no agent
   restart. Needs agreement with the agent side. Until then, choose a TTL long enough.
   - **Done (C2, C3):** tokens carry `ver` (= `Machine.credentialVersion`); redeeming a
     rotation token bumps it, so the old token dies. On handshake, a token within 30 days
     of `exp` is renewed with `station_credential { stationToken }`, which the agent saves.
3. **Branch move or serial change.** Either one invalidates the station's token
   (admission rejects it as a mismatch). A "move station" feature must mint and deliver
   a new token, or the station must re-enroll.
4. **Re-enrollment.** The agent re-enrolls after `--clear-station-token`, with a new key
   pair. Decide what happens when `serialNumber` already exists: recommended is to refuse
   unless an admin has DEACTIVATED (or deleted) the old row first, then reuse the row and
   replace `agent_public_key`.
   - **Done (C4):** a fresh enrollment token for the same branch resets a DEACTIVATED
     machine to PENDING with the new key and name; an admin approves it again.

---

## 6. Until enrollment ships: manual provisioning

To connect a real agent today, create the row and the token by hand.

1. Create an ENROLLED row (`npm run db:psql`):

   ```sql
   INSERT INTO machines (id, serial_number, branch_id, agent_public_key, enrollment_status, updated_at)
   VALUES (gen_random_uuid(), 'STATION-DEV-01',
           (SELECT id FROM branches ORDER BY created_at LIMIT 1), '', 'ENROLLED', now())
   RETURNING id, branch_id;
   ```

2. Mint a token inside the backend container (`npm run docker:sh`), with the `id` and
   `branch_id` from step 1:

   ```sh
   MACHINE_ID=<id> BRANCH_ID=<branch_id> SERIAL=STATION-DEV-01 node -e "console.log(require('jsonwebtoken').sign({sub:process.env.MACHINE_ID,type:'station',serialNumber:process.env.SERIAL,branchId:process.env.BRANCH_ID},process.env.JWT_ACCESS_SECRET,{expiresIn:'30d'}))"
   ```

3. Give it to the agent, either:
   - Development only: `$env:Agent__StationToken = "<jwt>"`, or
   - Any environment (elevated prompt): `"<jwt>" | BaronDeskAgent.ServiceCore.exe --set-station-token`

   Set `$env:Agent__SerialNumber = "STATION-DEV-01"` to match the token.

---

## 7. Tests to add

- Unit: signature verification (valid, tampered field, wrong key), token expiry and
  single use, key pinning, `signedAt` must increase, status responses.
- e2e: generate token → `POST /enrollment/request` (PENDING) → approve → poll (ENROLLED
  with a token) → open `/agent-ws` with that token and get `handshake_ack`. The existing
  `test/realtime.e2e-spec.ts` shows how to open the agent socket in a test.
- e2e: revoke closes a live socket with 1008.
- End to end with the real agent: agent repo `docs/Enrollment.md` §7, pointed at this
  backend instead of the mock server.

---

## 8. Open questions to settle with the agent side

- Confirm the response shape in §2.2 (the agent marks it OPEN).
- Station token TTL, and whether a renewal endpoint is wanted now or later.
- Whether the station key should be used after enrollment (for example a signed
  handshake). The agent lists this as future work (AS30). The backend does not use
  `agent_public_key` after enrollment today.
