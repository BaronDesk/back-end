// TEMPORARY DEV MONITOR — delete before merge
//
// Live view of station presence (with session / locked / running game /
// catalog install state), telemetry, alerts and commands, fed by
// `station_status`, `catalog_status`, `telemetry_update`, `alert`,
// `alert_resolved` and `command_update` on /dashboard-io. Standalone on
// purpose: no imports from src/.
//
//   TOKEN=<staff access token> npm run monitor
//   URL defaults to http://localhost:3000 (dev compose exposes Nest directly).
//   CPU_TEMP_THRESHOLD_C / GPU_TEMP_THRESHOLD_C default to 85 / 90, like the backend.
//
// Issue a command (POST /api/v1/stations/:id/commands), then poll it to a
// final status. <station> is a serial number or MACHINE id. SHUTDOWN needs a
// manager+ token. Options, in any order:
//   pin=<pin> [session=<uuid>]   UNLOCK only: booking unlock (station stays locked
//                                until the PIN is typed on its LockUI). session
//                                defaults to a random uuid.
//   game=<gameId>                LAUNCH_GAME only (required): the catalog's wire gameId.
//   reason=<text>                END_SESSION only: the agent defaults it to "normal".
//   stale_ts | duplicate_send | invalid_payload | exec_failed   dev-only fault injection.
//                                invalid_payload: LAUNCH_GAME with an empty gameId (agent: INVALID_PAYLOAD).
//                                exec_failed: LAUNCH_GAME for an id in no catalog (agent: EXEC_FAILED).
//
//   TOKEN=... npm run monitor -- cmd LOCK <station> [options]
//   TOKEN=... npm run monitor -- cmd LAUNCH_GAME <station> game=<gameId> [invalid_payload|exec_failed]
//   TOKEN=... npm run monitor -- cmd END_SESSION <station> [reason=<text>]
//   TOKEN=... npm run monitor -- cmd CATALOG_UPDATE <station>
//
// Game catalog (game-* need a manager+ token). <station> is a serial or MACHINE id:
//   TOKEN=... npm run monitor -- games
//   TOKEN=... npm run monitor -- game-add <gameId> exe|steam|epic <target> [name=..] [process=..] [args=..] [dir=..] [disabled]
//   TOKEN=... npm run monitor -- game-set <gameId> enabled=true|false | target=.. | process=.. | args=..
//   TOKEN=... npm run monitor -- game-assign <gameId> <station> [branch] [target=..] [args=..] [dir=..]
//   TOKEN=... npm run monitor -- game-unassign <gameId> <station> [branch]
//   TOKEN=... npm run monitor -- station-games <station>   resolved catalog + last catalog_status
//   TOKEN=... npm run monitor -- catalog <station>         exactly what GET /stations/me/games serves the agent
//
// Station credentials (Step 5). The station JWT is signed with the backend's
// JWT_ACCESS_SECRET (read from the env, else ./.env), like enrollment mints it:
//   TOKEN=... npm run monitor -- station-token <station> [ttl=<seconds>] [serial=<override>]
//       prints a station JWT for that MACHINE row. For the agent, put it in
//       Agent:StationToken (appsettings.Development.json); used when its DPAPI store is empty.
//   TOKEN=... npm run monitor -- station-auth <station>
//       runs the physical-test cases against /agent-ws and GET /stations/me/games.
//       Case a with the real agent: give it a minted token and watch it come ONLINE here.
//       Never handshakes as the station, so the real agent stays connected.
//
// Enrollment gating (Step 6). Only ENROLLED MACHINE rows are admitted; nothing
// is auto-created. These talk to Postgres directly (DATABASE_URL from the env,
// else ./.env), standing in for enrollment. On Windows a local Postgres often
// shadows :5432, so run them inside the backend container:
//   docker exec -it cstam-ninety-backend-backend-1 npm run monitor -- ...
//   npm run monitor -- station-enroll <serial> [status=ENROLLED|PENDING|INACTIVE|DEACTIVATED] [branch=<uuid>]
//       sets enrollmentStatus; creates the row (oldest branch unless branch=) when the serial is new.
//   TOKEN=... npm run monitor -- station-auth <station>
//       also runs the Step 6 cases: flips the row to PENDING / DEACTIVATED and back,
//       points a token at a machineId with no row, and checks no row is ever created.
import { createHmac, randomUUID } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';

import pg from 'pg';
import { io } from 'socket.io-client';
import WebSocket from 'ws';

interface StationRow {
  id?: string;
  serialNumber: string;
  name?: string | null;
  status: string;
  lastSeen: string | null;
  ip: string | null;
  locked: boolean | null;
  sessionId?: string | null;
  runningGameId?: string | null;
}

interface GameRow {
  id: string;
  gameId: string;
  name: string;
  launchType: string;
  target: string;
  processName: string | null;
  enabled: boolean;
  sortOrder: number;
}

interface StationGameRow {
  id: string;
  gameId: string;
  name: string;
  launchType: string;
  target: string;
  processName: string | null;
  installed: boolean | null;
  reason: string | null;
}

interface CatalogStatusEvent {
  machineId: string;
  serialNumber: string;
  reportedAt: string;
  games: { gameId: string; installed: boolean; reason: string | null }[];
}

interface TelemetryUpdate {
  serialNumber: string;
  timestamp: string;
  receivedAt: string;
  metrics: Record<string, number>;
}

interface CommandEvent {
  commandId: string;
  machineId: string;
  type: string;
  gameId?: string | null;
  status: string;
  issuedAt: string;
  resolvedAt: string | null;
  attempts: number;
  nackCode: string | null;
  nackReason: string | null;
  failureReason: string | null;
}

interface AlertEvent {
  id: string;
  serialNumber: string | null;
  category: string;
  type: string;
  severity: string;
  value: Record<string, unknown> | null;
  acknowledged: boolean;
  createdAt: string;
}

const URL = process.env.URL ?? 'http://localhost:3000';
const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  console.error('TOKEN env var is required (a staff+ access token from POST /auth/login).');
  process.exit(1);
}
const CPU_MAX = Number(process.env.CPU_TEMP_THRESHOLD_C ?? 85);
const GPU_MAX = Number(process.env.GPU_TEMP_THRESHOLD_C ?? 90);

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const rows = new Map<string, StationRow>();
const telemetry = new Map<string, TelemetryUpdate>();
const alerts: string[] = [];
const commands = new Map<string, CommandEvent>();
const games = new Map<string, GameRow>();
/** serial -> last catalog_status: what the station says it can launch. */
const catalogs = new Map<string, CatalogStatusEvent['games']>();
const log: string[] = [];
let connection = 'connecting...';

function relative(iso: string | null | undefined): string {
  if (!iso) return '-';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length);
}

/** Pads first, then colours, so ANSI codes don't break column widths. */
function cell(text: string, width: number, color?: string): string {
  const padded = pad(text, width);
  return color ? `${color}${padded}${RESET}` : padded;
}

function time(iso: string): string {
  return new Date(iso).toLocaleTimeString();
}

/** Values for every `gpu.<i>.<suffix>` / `fan.<i>.<suffix>` key, in index order. */
function indexed(metrics: Record<string, number>, prefix: string, suffix: string): number[] {
  const re = new RegExp(`^${prefix}\\.(\\d+)\\.${suffix}$`);
  return Object.entries(metrics)
    .map(([key, value]) => [re.exec(key)?.[1], value] as const)
    .filter((entry): entry is [string, number] => entry[0] !== undefined)
    .sort((a, b) => Number(a[0]) - Number(b[0]))
    .map(([, value]) => value);
}

function renderStations(): string[] {
  const header = `${pad('SERIAL', 24)} ${pad('STATUS', 8)} ${pad('LOCKED', 7)} ${pad('SESSION', 10)} ${pad('RUNNING GAME', 16)} ${pad('CATALOG', 9)} ${pad('LAST SEEN', 14)} IP`;
  const lines = [...rows.values()]
    .sort((a, b) => a.serialNumber.localeCompare(b.serialNumber))
    .map((r) => {
      const locked = r.locked === null || r.locked === undefined ? '-' : r.locked ? 'yes' : 'no';
      // Both come straight from the agent's heartbeat / state_report, never from a command ack.
      const session = r.sessionId ? r.sessionId.slice(0, 8) : '-';
      const game = r.runningGameId ?? '-';
      // installed / reported, from the station's last catalog_status.
      const catalog = catalogs.get(r.serialNumber);
      const catalogText = catalog ? `${catalog.filter((g) => g.installed).length}/${catalog.length}` : '-';
      return `${pad(r.serialNumber, 24)} ${cell(r.status, 8, r.status === 'ONLINE' ? GREEN : RED)} ${pad(locked, 7)} ${pad(session, 10)} ${cell(game, 16, r.runningGameId ? GREEN : undefined)} ${pad(catalogText, 9)} ${pad(relative(r.lastSeen), 14)} ${r.ip ?? '-'}`;
    });
  return [header, '-'.repeat(header.length + 12), ...(lines.length ? lines : [`${DIM}(no stations yet)${RESET}`])];
}

function renderTelemetry(): string[] {
  const header = `${pad('SERIAL', 24)} ${pad('CPU°C', 7)} ${pad('GPU°C', 14)} ${pad('FAN RPM', 16)} UPDATED`;
  const lines = [...telemetry.values()]
    .sort((a, b) => a.serialNumber.localeCompare(b.serialNumber))
    .map((t) => {
      const cpu = t.metrics['cpu.temperature_c'];
      const gpus = indexed(t.metrics, 'gpu', 'temperature_c');
      const fans = indexed(t.metrics, 'fan', 'speed_rpm');
      const cpuText = cpu === undefined ? '-' : cpu.toFixed(1);
      const gpuText = gpus.length ? gpus.map((g) => g.toFixed(0)).join('/') : '-';
      const fanText = fans.length ? fans.map((f) => f.toFixed(0)).join('/') : '-';
      const stale = Date.now() - new Date(t.receivedAt).getTime() > 30_000;
      return [
        pad(t.serialNumber, 24),
        cell(cpuText, 7, cpu !== undefined && cpu > CPU_MAX ? RED : undefined),
        cell(gpuText, 14, gpus.some((g) => g > GPU_MAX) ? RED : undefined),
        pad(fanText, 16),
        stale ? `${DIM}${relative(t.receivedAt)} (expired)${RESET}` : relative(t.receivedAt),
      ].join(' ');
    });
  return [header, '-'.repeat(header.length + 12), ...(lines.length ? lines : [`${DIM}(no telemetry yet)${RESET}`])];
}

function alertLine(a: AlertEvent): string {
  const v = a.value ?? {};
  const detail =
    a.category === 'anti_theft'
      ? `${v.deviceType ?? '?'} '${v.deviceName ?? '?'}' pid=${v.productId ?? '?'}`
      : a.category === 'hardware'
        ? `${v.metric ?? '?'}=${v.value ?? '?'} > ${v.threshold ?? '?'}`
        : JSON.stringify(v);
  const color = a.category === 'anti_theft' ? RED : YELLOW;
  return `${pad(time(a.createdAt), 11)} ${pad(a.serialNumber ?? '-', 24)} ${cell(a.category, 11, color)} ${pad(a.type, 20)} ${detail}  ${DIM}${a.id.slice(0, 8)}${RESET}`;
}

const COMMAND_COLOR: Record<string, string> = {
  PENDING: DIM,
  SENT: YELLOW,
  ACKED: GREEN,
  NACKED: RED,
  TIMEOUT: RED,
  FAILED: RED,
};

function serialOf(machineId: string): string {
  return [...rows.values()].find((r) => r.id === machineId)?.serialNumber ?? machineId.slice(0, 8);
}

function renderCommands(): string[] {
  const header = `${pad('ISSUED', 11)} ${pad('SERIAL', 24)} ${pad('TYPE', 11)} ${pad('STATUS', 8)} ${pad('TRIES', 5)} ${pad('AGE', 12)} DETAIL`;
  const lines = [...commands.values()]
    .sort((a, b) => a.issuedAt.localeCompare(b.issuedAt))
    .slice(-10)
    .map((c) => {
      const game = c.gameId ? (games.get(c.gameId)?.gameId ?? c.gameId.slice(0, 8)) : '';
      const outcome = c.nackCode ? `${c.nackCode}${c.nackReason ? `: ${c.nackReason}` : ''}` : (c.failureReason ?? '');
      const detail = [game && `game=${game}`, outcome].filter(Boolean).join('  ');
      return [
        pad(time(c.issuedAt), 11),
        pad(serialOf(c.machineId), 24),
        pad(c.type, 11),
        cell(c.status, 8, COMMAND_COLOR[c.status]),
        pad(String(c.attempts), 5),
        pad(relative(c.issuedAt), 12),
        `${detail}  ${DIM}${c.commandId.slice(0, 8)}${RESET}`,
      ].join(' ');
    });
  return [header, '-'.repeat(header.length + 12), ...(lines.length ? lines : [`${DIM}(no commands)${RESET}`])];
}

function render(): void {
  console.clear();
  console.log(`node monitor  ${DIM}${URL}  [${connection}]  thresholds CPU>${CPU_MAX} GPU>${GPU_MAX}${RESET}\n`);
  console.log(renderStations().join('\n'));
  console.log(`\n${renderTelemetry().join('\n')}`);
  const alertHeader = `${pad('TIME', 11)} ${pad('SERIAL', 24)} ${pad('CATEGORY', 11)} ${pad('TYPE', 20)} DETAIL`;
  console.log(`\nALERTS\n${alertHeader}\n${'-'.repeat(alertHeader.length + 20)}`);
  console.log(alerts.length ? alerts.slice(-10).join('\n') : `${DIM}(no alerts)${RESET}`);
  console.log(
    `\nCOMMANDS  ${DIM}(issue: npm run monitor -- cmd LOCK|UNLOCK|SHUTDOWN|LAUNCH_GAME|END_SESSION|CATALOG_UPDATE <serial>)${RESET}`,
  );
  console.log(renderCommands().join('\n'));
  console.log(`\n${DIM}recent events:${RESET}`);
  console.log(log.slice(-6).join('\n'));
}

async function get<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${URL}${path}`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!res.ok) {
      log.push(`GET ${path} -> ${res.status}`);
      return null;
    }
    return (await res.json()) as T;
  } catch (err) {
    log.push(`GET ${path} failed: ${(err as Error).message}`);
    return null;
  }
}

async function seed(): Promise<void> {
  for (const s of (await get<StationRow[]>('/api/v1/stations')) ?? []) rows.set(s.serialNumber, s);
  for (const g of (await get<GameRow[]>('/api/v1/games')) ?? []) games.set(g.id, g);
  for (const station of rows.values()) {
    if (!station.id) continue;
    const reported = ((await get<StationGameRow[]>(`/api/v1/stations/${station.id}/games`)) ?? []).filter(
      (g) => g.installed !== null,
    );
    if (reported.length) {
      catalogs.set(
        station.serialNumber,
        reported.map((g) => ({ gameId: g.gameId, installed: g.installed === true, reason: g.reason })),
      );
    }
  }
  const open = (await get<AlertEvent[]>('/api/v1/alerts?status=open&limit=10')) ?? [];
  alerts.length = 0;
  for (const a of open.reverse()) alerts.push(alertLine(a));
  for (const station of rows.values()) {
    if (!station.id) continue;
    for (const c of (await get<CommandEvent[]>(`/api/v1/stations/${station.id}/commands?limit=5`)) ?? []) {
      commands.set(c.commandId, c);
    }
  }
}

const FINAL = new Set(['ACKED', 'NACKED', 'TIMEOUT', 'FAILED']);

/** `cmd` mode: POST a command, then poll GET /commands/:id until it settles. */
async function issueCommand(type: string | undefined, target: string | undefined, options: string[]) {
  if (!type || !target) {
    console.error(
      'usage: npm run monitor -- cmd LOCK|UNLOCK|SHUTDOWN|LAUNCH_GAME|END_SESSION|CATALOG_UPDATE <serial|machineId> [pin=<pin> [session=<uuid>]] [game=<gameId>] [reason=<text>] [stale_ts|duplicate_send|invalid_payload|exec_failed]',
    );
    process.exit(1);
  }
  const option = (key: string) => options.find((o) => o.startsWith(`${key}=`))?.slice(key.length + 1);
  const simulate = options.find((o) => !o.includes('='));
  const pin = option('pin');
  const payload = pin ? { sessionId: option('session') ?? crypto.randomUUID(), pin } : undefined;
  const reason = option('reason');
  // The wire gameId goes as typed: the backend (or, with a simulation, the agent) judges it.
  const gameId = option('game');
  const stations = (await get<StationRow[]>('/api/v1/stations')) ?? [];
  const station = stations.find((s) => s.serialNumber === target || s.id === target);
  if (!station?.id) {
    console.error(`no station '${target}'. known: ${stations.map((s) => s.serialNumber).join(', ') || '(none)'}`);
    process.exit(1);
  }

  const res = await fetch(`${URL}/api/v1/stations/${station.id}/commands`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: type.toUpperCase(),
      ...(payload ? { payload } : {}),
      ...(gameId ? { gameId } : {}),
      ...(reason ? { reason } : {}),
      ...(simulate ? { simulate } : {}),
    }),
  });
  const body = (await res.json()) as CommandEvent;
  console.log(`POST ${type.toUpperCase()} ${station.serialNumber} -> ${res.status} ${JSON.stringify(body)}`);
  if (!res.ok) process.exit(1);

  let last = body.status;
  const deadline = Date.now() + 30_000;
  while (!FINAL.has(last) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 300));
    const current = await get<CommandEvent>(`/api/v1/commands/${body.commandId}`);
    if (current && current.status !== last) {
      last = current.status;
      const extra = current.nackCode ? `${current.nackCode}: ${current.nackReason ?? ''}` : (current.failureReason ?? '');
      console.log(`${new Date().toLocaleTimeString()}  ${body.commandId} -> ${last} (attempts ${current.attempts}) ${extra}`);
    }
  }
  // ACKED means "accepted". Station state comes from its heartbeat / state_report.
  const after = (await get<StationRow[]>('/api/v1/stations'))?.find((s) => s.id === station.id);
  console.log(
    `station ${station.serialNumber} locked=${after?.locked ?? '?'} sessionId=${after?.sessionId ?? 'null'} runningGameId=${after?.runningGameId ?? 'null'} (locked/session from heartbeat ~15s; runningGameId only from state_report, i.e. after an agent reconnect)`,
  );
  process.exit(FINAL.has(last) ? 0 : 2);
}

async function send(method: string, path: string, body?: unknown): Promise<void> {
  const res = await fetch(`${URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  console.log(`${method} ${path} -> ${res.status} ${await res.text()}`);
  if (!res.ok) process.exit(1);
}

async function findStation(target: string | undefined): Promise<StationRow & { branchId?: string }> {
  const stations = (await get<StationRow[]>('/api/v1/stations')) ?? [];
  const station = stations.find((s) => s.serialNumber === target || s.id === target);
  if (!station?.id) {
    console.error(`no station '${target}'. known: ${stations.map((s) => s.serialNumber).join(', ') || '(none)'}`);
    process.exit(1);
  }
  return (await get<StationRow & { branchId?: string }>(`/api/v1/stations/${station.id}`)) ?? station;
}

async function findGame(gameId: string | undefined): Promise<GameRow> {
  const catalog = (await get<GameRow[]>('/api/v1/games')) ?? [];
  const game = catalog.find((g) => g.gameId === gameId || g.id === gameId);
  if (!game) {
    console.error(`no game '${gameId}'. known: ${catalog.map((g) => g.gameId).join(', ') || '(none)'}`);
    process.exit(1);
  }
  return game;
}

/** `key=value` options into an object, mapping short names to API fields. */
function fields(args: string[], names: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const arg of args) {
    const at = arg.indexOf('=');
    if (at > 0 && names[arg.slice(0, at)]) out[names[arg.slice(0, at)]] = arg.slice(at + 1);
  }
  return out;
}

const GAME_FIELDS = { name: 'name', process: 'processName', args: 'arguments', dir: 'workingDirectory', target: 'target' };
const OVERRIDE_FIELDS = { target: 'target', args: 'arguments', dir: 'workingDirectory' };

/**
 * process.exit right after a fetch can trip a libuv assertion on Windows
 * (a keep-alive socket still closing). Let the handles settle first.
 */
async function exitSoon(code: number): Promise<never> {
  await new Promise((r) => setTimeout(r, 100));
  process.exit(code);
}

/** `name` from the env, else the backend's ./.env. */
function envValue(name: string): string {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  const line = existsSync('.env')
    ? readFileSync('.env', 'utf8').split(/\r?\n/).find((l) => l.startsWith(`${name}=`))
    : undefined;
  if (!line) {
    console.error(`${name} not set and not found in ./.env`);
    process.exit(1);
  }
  return line.slice(name.length + 1).trim().replace(/^["']|["']$/g, '');
}

function accessSecret(): string {
  return envValue('JWT_ACCESS_SECRET');
}

/** One query against the backend's Postgres: stands in for enrollment in the physical test. */
async function sql<T extends Record<string, unknown>>(text: string, values: unknown[] = []): Promise<T[]> {
  const client = new pg.Client({ connectionString: envValue('DATABASE_URL').replace(/[?&]schema=[^&]*/, '') });
  await client.connect();
  try {
    return (await client.query<T>(text, values)).rows;
  } finally {
    await client.end();
  }
}

const ENROLLMENT_STATUSES = new Set(['PENDING', 'ENROLLED', 'INACTIVE', 'DEACTIVATED']);

async function setEnrollment(machineId: string, status: string): Promise<void> {
  await sql('UPDATE machines SET enrollment_status = $1::"MachineEnrollmentStatus" WHERE id = $2::uuid', [status, machineId]);
}

async function machineCount(where: { id?: string; serialNumber?: string }): Promise<number> {
  const [row] = await sql<{ n: string }>('SELECT count(*) AS n FROM machines WHERE id::text = $1 OR serial_number = $2', [
    where.id ?? '',
    where.serialNumber ?? '',
  ]);
  return Number(row?.n ?? 0);
}

/** `station-enroll`: what enrollment would leave behind, written directly. */
async function stationEnroll(args: string[]): Promise<never> {
  const [serial, ...rest] = args;
  const option = (key: string) => rest.find((a) => a.startsWith(`${key}=`))?.slice(key.length + 1);
  const status = (option('status') ?? 'ENROLLED').toUpperCase();
  if (!serial || !ENROLLMENT_STATUSES.has(status)) {
    console.error('usage: npm run monitor -- station-enroll <serial> [status=ENROLLED|PENDING|INACTIVE|DEACTIVATED] [branch=<uuid>]');
    process.exit(1);
  }
  const branch = option('branch') ?? (await sql<{ id: string }>('SELECT id FROM branches ORDER BY created_at LIMIT 1'))[0]?.id;
  if (!branch) {
    console.error('no branch to put the station on; pass branch=<uuid>');
    process.exit(1);
  }
  const [row] = await sql<{ id: string; branch_id: string; enrollment_status: string }>(
    `INSERT INTO machines (id, serial_number, branch_id, agent_public_key, enrollment_status, updated_at)
       VALUES ($1::uuid, $2, $3::uuid, '', $4::"MachineEnrollmentStatus", now())
     ON CONFLICT (serial_number) DO UPDATE SET enrollment_status = EXCLUDED.enrollment_status, updated_at = now()
     RETURNING id, branch_id, enrollment_status`,
    [randomUUID(), serial, branch, status],
  );
  console.log(`${serial}  machine ${row?.id}  branch ${row?.branch_id}  enrollmentStatus ${row?.enrollment_status}`);
  return exitSoon(0);
}

/** HS256, the JwtModule default: what enrollment would mint. */
function signJwt(claims: Record<string, unknown>, ttlSeconds: number): string {
  const b64 = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const body = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ ...claims, iat: now, exp: now + ttlSeconds })}`;
  return `${body}.${createHmac('sha256', accessSecret()).update(body).digest('base64url')}`;
}

function stationToken(station: StationRow & { branchId?: string }, ttlSeconds = 30 * 86_400, serial?: string): string {
  return signJwt(
    { sub: station.id, type: 'station', serialNumber: serial ?? station.serialNumber, branchId: station.branchId },
    ttlSeconds,
  );
}

const WS_URL = `${URL.replace(/^http/, 'ws')}/agent-ws`;

/** 101 when /agent-ws accepts the token (closed again before any handshake), else the upgrade's HTTP status. */
function upgradeStatus(token: string | null): Promise<number> {
  const socket = new WebSocket(WS_URL, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
  return new Promise((resolve) => {
    socket.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      socket.terminate();
    });
    socket.on('open', () => {
      resolve(101);
      socket.close();
    });
    socket.on('error', () => resolve(0));
  });
}

/** Connects with `token` and handshakes as `serial`: the close code, or 'ack' if the handshake was accepted. */
function handshakeResult(token: string, serial: string): Promise<number | 'ack'> {
  const socket = new WebSocket(WS_URL, { headers: { Authorization: `Bearer ${token}` } });
  return new Promise((resolve) => {
    socket.on('open', () =>
      socket.send(
        JSON.stringify({
          type: 'handshake',
          id: crypto.randomUUID(),
          ts: new Date().toISOString(),
          seq: 1,
          payload: { serialNumber: serial },
        }),
      ),
    );
    socket.on('message', (data: Buffer) => {
      if ((JSON.parse(data.toString()) as { type?: string }).type === 'handshake_ack') {
        resolve('ack');
        socket.close();
      }
    });
    socket.on('close', (code: number) => resolve(code));
    socket.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
    socket.on('error', () => undefined);
  });
}

async function catalogStatus(headers: Record<string, string>, query = ''): Promise<number> {
  return (await fetch(`${URL}/stations/me/games${query}`, { headers })).status;
}

/**
 * Whether /agent-ws admits `token`, without handshaking: 'open' if the socket
 * is still up after a moment, the close code if the server closed it (1008 =
 * not admitted), or the upgrade's HTTP status if it was refused.
 */
function admission(token: string | null): Promise<number | 'open'> {
  const socket = new WebSocket(WS_URL, token ? { headers: { Authorization: `Bearer ${token}` } } : {});
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    socket.on('open', () => {
      timer = setTimeout(() => {
        resolve('open');
        socket.close();
      }, 750);
    });
    socket.on('close', (code: number) => {
      clearTimeout(timer);
      resolve(code);
    });
    socket.on('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      socket.terminate();
    });
    socket.on('error', () => undefined);
  });
}

/** `station-auth`: the Step 5 + Step 6 physical-test cases, PASS/FAIL per line. */
async function stationAuthCases(station: StationRow & { branchId?: string }): Promise<never> {
  const machineId = station.id ?? '';
  const valid = stationToken(station, 300);
  const expired = stationToken(station, -60);
  let failed = 0;
  const check = (label: string, actual: unknown, expected: unknown) => {
    const ok = actual === expected;
    if (!ok) failed++;
    console.log(`${ok ? `${GREEN}PASS${RESET}` : `${RED}FAIL${RESET}`}  ${pad(label, 64)} got ${actual}, want ${expected}`);
  };
  const [row] = await sql<{ enrollment_status: string }>('SELECT enrollment_status FROM machines WHERE id = $1::uuid', [machineId]);
  const original = row?.enrollment_status ?? 'ENROLLED';

  console.log(`station ${station.serialNumber}  machine ${machineId}  branch ${station.branchId}  (was ${original})\n`);
  try {
    // a. ENROLLED + valid token: admitted, listed by presence, catalog served.
    await setEnrollment(machineId, 'ENROLLED');
    check('a. ENROLLED + valid token: /agent-ws stays open', await admission(valid), 'open');
    check('a. ENROLLED + valid token: GET /stations/me/games', await catalogStatus({ Authorization: `Bearer ${valid}` }), 200);
    const listed = await get<StationRow & { enrollmentStatus?: string }>(`/api/v1/stations/${machineId}`);
    check('a. presence lists the station as ENROLLED', listed?.enrollmentStatus, 'ENROLLED');
    console.log(`${DIM}      presence status ${listed?.status ?? '?'} (ONLINE when the real agent is connected)${RESET}`);

    // b. Same station, not ENROLLED: 1008 on the socket, 403 on REST.
    for (const status of ['PENDING', 'DEACTIVATED']) {
      await setEnrollment(machineId, status);
      check(`b. ${status}: /agent-ws close code`, await admission(valid), 1008);
      check(`b. ${status}: GET /stations/me/games`, await catalogStatus({ Authorization: `Bearer ${valid}` }), 403);
    }
    await setEnrollment(machineId, 'ENROLLED');
    check('b. back to ENROLLED: /agent-ws stays open', await admission(valid), 'open');

    // c. Valid signature, machineId with no MACHINE row: rejected, nothing created.
    const ghostId = randomUUID();
    const ghostSerial = `GHOST-${ghostId.slice(0, 8)}`;
    const ghost = stationToken({ ...station, id: ghostId, serialNumber: ghostSerial }, 300);
    check('c. no MACHINE row: /agent-ws close code', await admission(ghost), 1008);
    check('c. no MACHINE row: handshake close code', await handshakeResult(ghost, ghostSerial), 1008);
    check('c. no MACHINE row: GET /stations/me/games', await catalogStatus({ Authorization: `Bearer ${ghost}` }), 403);
    check('c. no MACHINE row created', await machineCount({ id: ghostId, serialNumber: ghostSerial }), 0);

    // d. Unknown serial, no token: rejected, never auto-created (dev included).
    const unknownSerial = `UNKNOWN-${randomUUID().slice(0, 8)}`;
    check('d. unknown serial, no token: WSS upgrade', await upgradeStatus(null), 401);
    check('d. unknown serial, no token: GET ?serialNumber=', await catalogStatus({}, `?serialNumber=${unknownSerial}`), 401);
    check('d. no MACHINE row created for the unknown serial', await machineCount({ serialNumber: unknownSerial }), 0);

    // e. The old serial-trust bypass authenticates nothing; bad tokens stay 401.
    const bySerial = { 'x-station-serial': station.serialNumber };
    check('e. x-station-serial only: GET /stations/me/games', await catalogStatus(bySerial), 401);
    check('e. ?serialNumber= only: GET /stations/me/games', await catalogStatus({}, `?serialNumber=${station.serialNumber}`), 401);
    check('e. garbage token + x-station-serial: GET', await catalogStatus({ Authorization: 'Bearer garbage', ...bySerial }), 401);
    check('e. garbage token: WSS upgrade', await upgradeStatus('garbage'), 401);
    check('e. expired token: WSS upgrade', await upgradeStatus(expired), 401);
    check('e. expired token: GET /stations/me/games', await catalogStatus({ Authorization: `Bearer ${expired}` }), 401);
    check('e. user access token (TOKEN): WSS upgrade', await upgradeStatus(TOKEN ?? null), 401);
    check('e. user access token (TOKEN): GET /stations/me/games', await catalogStatus({ Authorization: `Bearer ${TOKEN}` }), 401);
    check('e. token serial != handshake serial: close code', await handshakeResult(valid, `${station.serialNumber}-X`), 1008);
  } finally {
    await setEnrollment(machineId, original);
  }
  console.log(`\n${failed ? `${RED}${failed} failed${RESET}` : `${GREEN}all passed${RESET}`}  ${DIM}(enrollmentStatus restored to ${original})${RESET}`);
  return exitSoon(failed ? 2 : 0);
}

/** Catalog helpers for the physical test. */
async function catalogCommand(command: string, args: string[]): Promise<never> {
  if (command === 'games') {
    for (const g of (await get<GameRow[]>('/api/v1/games')) ?? []) {
      console.log(
        `${pad(g.gameId, 20)} ${pad(g.enabled ? 'enabled' : 'disabled', 9)} ${pad(g.launchType, 6)} target=${g.target} process=${g.processName ?? '-'}  ${DIM}${g.id}${RESET}`,
      );
    }
    if (log.length) console.log(log.join('\n'));
    return exitSoon(0);
  }
  if (command === 'game-add') {
    const [gameId, launchType, target, ...rest] = args;
    if (!gameId || !launchType || !target) {
      console.error('usage: npm run monitor -- game-add <gameId> exe|steam|epic <target> [name=..] [process=..] [args=..] [dir=..] [disabled]');
      process.exit(1);
    }
    await send('POST', '/api/v1/games', {
      gameId,
      name: gameId,
      launchType,
      target,
      ...fields(rest, GAME_FIELDS),
      enabled: !rest.includes('disabled'),
    });
    return exitSoon(0);
  }
  if (command === 'game-set') {
    const [gameId, ...rest] = args;
    const game = await findGame(gameId);
    const patch: Record<string, unknown> = fields(rest, GAME_FIELDS);
    const enabled = rest.find((a) => a.startsWith('enabled='))?.slice('enabled='.length);
    if (enabled) patch.enabled = enabled === 'true';
    await send('PATCH', `/api/v1/games/${game.id}`, patch);
    return exitSoon(0);
  }
  if (command === 'game-assign' || command === 'game-unassign') {
    const [gameId, target, ...rest] = args;
    const game = await findGame(gameId);
    const station = await findStation(target);
    const method = command === 'game-assign' ? 'PUT' : 'DELETE';
    if (rest.includes('branch')) {
      await send(method, `/api/v1/games/${game.id}/branches/${station.branchId}`);
    } else {
      await send(method, `/api/v1/games/${game.id}/stations/${station.id}`, method === 'PUT' ? fields(rest, OVERRIDE_FIELDS) : undefined);
    }
    return exitSoon(0);
  }
  const station = await findStation(args[0]);
  if (command === 'station-token') {
    const option = (key: string) => args.find((a) => a.startsWith(`${key}=`))?.slice(key.length + 1);
    console.log(stationToken(station, Number(option('ttl') ?? 30 * 86_400), option('serial')));
    return exitSoon(0);
  }
  if (command === 'station-auth') return stationAuthCases(station);
  if (command === 'station-games') {
    for (const g of (await get<StationGameRow[]>(`/api/v1/stations/${station.id}/games`)) ?? []) {
      const state = g.installed === null ? `${DIM}not reported${RESET}` : g.installed ? `${GREEN}installed${RESET}` : `${RED}not installed${RESET}`;
      console.log(`${pad(g.gameId, 20)} ${pad(g.launchType, 6)} target=${g.target}  ${state}${g.reason ? `  (${g.reason})` : ''}`);
    }
    return exitSoon(0);
  }
  // `catalog`: the agent's view, authenticated with a freshly minted station token.
  const res = await fetch(`${URL}/stations/me/games`, { headers: { Authorization: `Bearer ${stationToken(station, 60)}` } });
  console.log(`GET /stations/me/games (${station.serialNumber}) -> ${res.status}`);
  console.log(JSON.stringify(await res.json(), null, 2));
  return exitSoon(0);
}

const CATALOG_COMMANDS = new Set([
  'games',
  'game-add',
  'game-set',
  'game-assign',
  'game-unassign',
  'station-games',
  'catalog',
  'station-token',
  'station-auth',
]);

if (process.argv[2] === 'station-enroll') {
  await stationEnroll(process.argv.slice(3));
}
if (process.argv[2] === 'cmd') {
  await issueCommand(process.argv[3], process.argv[4], process.argv.slice(5));
}
if (CATALOG_COMMANDS.has(process.argv[2] ?? '')) {
  await catalogCommand(process.argv[2] ?? '', process.argv.slice(3));
}

const socket = io(URL, { path: '/dashboard-io', auth: { token: TOKEN }, transports: ['websocket'] });

socket.on('connect', () => {
  connection = 'connected';
  void seed().then(render);
});
socket.on('connect_error', (err) => {
  connection = `connect_error: ${err.message}`;
  render();
});
socket.on('disconnect', (reason) => {
  connection = `disconnected: ${reason}`;
  render();
});
socket.on('station_status', (event: StationRow) => {
  const previous = rows.get(event.serialNumber);
  rows.set(event.serialNumber, { ...previous, ...event });
  const at = new Date().toLocaleTimeString();
  if (previous?.status !== event.status) log.push(`${at}  ${event.serialNumber} -> ${event.status}`);
  if (previous && previous.locked !== event.locked) log.push(`${at}  ${event.serialNumber} locked=${event.locked}`);
  if (previous && (previous.sessionId ?? null) !== (event.sessionId ?? null)) {
    log.push(`${at}  ${event.serialNumber} session ${event.sessionId ? `started ${event.sessionId.slice(0, 8)}` : 'ended'}`);
  }
  if (previous && (previous.runningGameId ?? null) !== (event.runningGameId ?? null)) {
    log.push(`${at}  ${event.serialNumber} runningGameId=${event.runningGameId ?? 'null'}`);
  }
  render();
});
socket.on('catalog_status', (event: CatalogStatusEvent) => {
  catalogs.set(event.serialNumber, event.games);
  const installed = event.games.filter((g) => g.installed).length;
  const missing = event.games.filter((g) => !g.installed).map((g) => `${g.gameId}${g.reason ? ` (${g.reason})` : ''}`);
  log.push(
    `${new Date().toLocaleTimeString()}  catalog_status ${event.serialNumber}: ${installed}/${event.games.length} launchable${missing.length ? `; not: ${missing.join(', ')}` : ''}`,
  );
  render();
});
socket.on('telemetry_update', (event: TelemetryUpdate) => {
  telemetry.set(event.serialNumber, event);
  render();
});
socket.on('alert', (event: AlertEvent) => {
  alerts.push(alertLine(event));
  log.push(`${new Date().toLocaleTimeString()}  ALERT ${event.category}/${event.type} on ${event.serialNumber ?? '?'}`);
  render();
});
socket.on('command_update', (event: CommandEvent) => {
  const previous = commands.get(event.commandId)?.status;
  commands.set(event.commandId, event);
  if (previous !== event.status) {
    const extra = event.nackCode ?? event.failureReason ?? '';
    log.push(`${new Date().toLocaleTimeString()}  ${event.type} on ${serialOf(event.machineId)} -> ${event.status} ${extra}`);
  }
  render();
});
socket.on('alert_resolved', (event: AlertEvent) => {
  log.push(`${new Date().toLocaleTimeString()}  resolved ${event.category}/${event.type} ${event.id.slice(0, 8)}`);
  render();
});

// Keep the relative columns moving between events.
setInterval(render, 5000);
render();
