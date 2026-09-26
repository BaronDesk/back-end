// TEMPORARY DEV MONITOR — delete before merge
//
// Live view of station presence (with session / locked / running game),
// telemetry, alerts and commands, fed by `station_status`, `telemetry_update`,
// `alert`, `alert_resolved` and `command_update` on /dashboard-io. Standalone
// on purpose: no imports from src/.
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
//   game=<gameId|slug>           LAUNCH_GAME only (required): a catalog game.
//   reason=<text>                END_SESSION only: the agent defaults it to "normal".
//   stale_ts | duplicate_send | exec_failed   dev-only fault injection.
//                                exec_failed puts a blank-gameId LAUNCH_GAME on the wire.
//
//   TOKEN=... npm run monitor -- cmd LOCK <station> [options]
//   TOKEN=... npm run monitor -- cmd LAUNCH_GAME <station> game=<slug> [exec_failed]
//   TOKEN=... npm run monitor -- cmd END_SESSION <station> [reason=<text>]
//
// Game catalog (game-add / game-set need a manager+ token):
//   TOKEN=... npm run monitor -- games
//   TOKEN=... npm run monitor -- game-add <slug> <launchRef> [name] [disabled]
//   TOKEN=... npm run monitor -- game-set <gameId|slug> enabled=true|false
import { io } from 'socket.io-client';

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
  name: string;
  slug: string;
  launchRef: string;
  enabled: boolean;
  sortOrder: number;
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
  const header = `${pad('SERIAL', 24)} ${pad('STATUS', 8)} ${pad('LOCKED', 7)} ${pad('SESSION', 10)} ${pad('RUNNING GAME', 16)} ${pad('LAST SEEN', 14)} IP`;
  const lines = [...rows.values()]
    .sort((a, b) => a.serialNumber.localeCompare(b.serialNumber))
    .map((r) => {
      const locked = r.locked === null || r.locked === undefined ? '-' : r.locked ? 'yes' : 'no';
      // Both come straight from the agent's heartbeat / state_report, never from a command ack.
      const session = r.sessionId ? r.sessionId.slice(0, 8) : '-';
      const game = r.runningGameId ?? '-';
      return `${pad(r.serialNumber, 24)} ${cell(r.status, 8, r.status === 'ONLINE' ? GREEN : RED)} ${pad(locked, 7)} ${pad(session, 10)} ${cell(game, 16, r.runningGameId ? GREEN : undefined)} ${pad(relative(r.lastSeen), 14)} ${r.ip ?? '-'}`;
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
      const game = c.gameId ? (games.get(c.gameId)?.slug ?? c.gameId.slice(0, 8)) : '';
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
    `\nCOMMANDS  ${DIM}(issue: npm run monitor -- cmd LOCK|UNLOCK|SHUTDOWN|LAUNCH_GAME|END_SESSION <serial>)${RESET}`,
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
      'usage: npm run monitor -- cmd LOCK|UNLOCK|SHUTDOWN|LAUNCH_GAME|END_SESSION <serial|machineId> [pin=<pin> [session=<uuid>]] [game=<id|slug>] [reason=<text>] [stale_ts|duplicate_send|exec_failed]',
    );
    process.exit(1);
  }
  const option = (key: string) => options.find((o) => o.startsWith(`${key}=`))?.slice(key.length + 1);
  const simulate = options.find((o) => !o.includes('='));
  const pin = option('pin');
  const payload = pin ? { sessionId: option('session') ?? crypto.randomUUID(), pin } : undefined;
  const reason = option('reason');
  const gameArg = option('game');
  let gameId: string | undefined;
  if (gameArg) {
    const catalog = (await get<GameRow[]>('/api/v1/games')) ?? [];
    gameId = catalog.find((g) => g.id === gameArg || g.slug === gameArg)?.id;
    if (!gameId) {
      console.error(`no game '${gameArg}'. known: ${catalog.map((g) => g.slug).join(', ') || '(none)'}`);
      process.exit(1);
    }
  }
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
      const extra = current.nackCode ?? current.failureReason ?? '';
      console.log(`${new Date().toLocaleTimeString()}  ${body.commandId} -> ${last} (attempts ${current.attempts}) ${extra}`);
    }
  }
  // ACKED means "accepted". Station state comes from its heartbeat / state_report.
  const after = (await get<StationRow[]>('/api/v1/stations'))?.find((s) => s.id === station.id);
  console.log(
    `station ${station.serialNumber} locked=${after?.locked ?? '?'} sessionId=${after?.sessionId ?? 'null'} runningGameId=${after?.runningGameId ?? 'null'} (from heartbeat; refreshes every ~15s)`,
  );
  process.exit(FINAL.has(last) ? 0 : 2);
}

async function send(method: string, path: string, body: unknown): Promise<void> {
  const res = await fetch(`${URL}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  console.log(`${method} ${path} -> ${res.status} ${JSON.stringify(await res.json())}`);
  if (!res.ok) process.exit(1);
}

/** `games` / `game-add` / `game-set`: catalog helpers for the physical test. */
async function catalogCommand(command: string, args: string[]): Promise<never> {
  if (command === 'games') {
    for (const g of (await get<GameRow[]>('/api/v1/games')) ?? []) {
      console.log(`${pad(g.slug, 24)} ${pad(g.enabled ? 'enabled' : 'disabled', 9)} launchRef=${g.launchRef}  ${g.id}`);
    }
    if (log.length) console.log(log.join('\n'));
    process.exit(0);
  }
  if (command === 'game-add') {
    const [slug, launchRef, name, flag] = args;
    if (!slug || !launchRef) {
      console.error('usage: npm run monitor -- game-add <slug> <launchRef> [name] [disabled]');
      process.exit(1);
    }
    await send('POST', '/api/v1/games', { slug, launchRef, name: name ?? slug, enabled: flag !== 'disabled' });
    process.exit(0);
  }
  const [target, setting] = args;
  const enabled = setting?.match(/^enabled=(true|false)$/)?.[1];
  const game = ((await get<GameRow[]>('/api/v1/games')) ?? []).find((g) => g.id === target || g.slug === target);
  if (!game || !enabled) {
    console.error('usage: npm run monitor -- game-set <gameId|slug> enabled=true|false');
    process.exit(1);
  }
  await send('PATCH', `/api/v1/games/${game.id}`, { enabled: enabled === 'true' });
  process.exit(0);
}

if (process.argv[2] === 'cmd') {
  await issueCommand(process.argv[3], process.argv[4], process.argv.slice(5));
}
if (process.argv[2] === 'games' || process.argv[2] === 'game-add' || process.argv[2] === 'game-set') {
  await catalogCommand(process.argv[2], process.argv.slice(3));
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
