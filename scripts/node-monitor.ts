// TEMPORARY DEV MONITOR — delete before merge
//
// Live table of station presence, fed by `station_status` on /dashboard-io.
// Standalone on purpose: no imports from src/.
//
//   TOKEN=<staff access token> npm run monitor
//   URL defaults to http://localhost:3000 (dev compose exposes Nest directly).
import { io } from 'socket.io-client';

interface StationRow {
  serialNumber: string;
  name?: string | null;
  status: string;
  lastSeen: string | null;
  ip: string | null;
  locked: boolean | null;
}

const URL = process.env.URL ?? 'http://localhost:3000';
const TOKEN = process.env.TOKEN;
if (!TOKEN) {
  console.error('TOKEN env var is required (a staff+ access token from POST /auth/login).');
  process.exit(1);
}

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

const rows = new Map<string, StationRow>();
const log: string[] = [];
let connection = 'connecting...';

function relative(iso: string | null): string {
  if (!iso) return '-';
  const s = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s ago`;
  return `${Math.floor(s / 3600)}h ago`;
}

function pad(text: string, width: number): string {
  return text.length >= width ? text.slice(0, width) : text + ' '.repeat(width - text.length);
}

function render(): void {
  const header = `${pad('SERIAL', 24)} ${pad('STATUS', 8)} ${pad('LOCKED', 7)} ${pad('LAST SEEN', 14)} IP`;
  const lines = [...rows.values()]
    .sort((a, b) => a.serialNumber.localeCompare(b.serialNumber))
    .map((r) => {
      const color = r.status === 'ONLINE' ? GREEN : RED;
      const locked = r.locked === null || r.locked === undefined ? '-' : r.locked ? 'yes' : 'no';
      return `${pad(r.serialNumber, 24)} ${color}${pad(r.status, 8)}${RESET} ${pad(locked, 7)} ${pad(relative(r.lastSeen), 14)} ${r.ip ?? '-'}`;
    });

  console.clear();
  console.log(`node monitor  ${DIM}${URL}  [${connection}]${RESET}\n`);
  console.log(header);
  console.log('-'.repeat(header.length + 12));
  console.log(lines.length ? lines.join('\n') : `${DIM}(no stations yet)${RESET}`);
  console.log(`\n${DIM}recent station_status events:${RESET}`);
  console.log(log.slice(-8).join('\n'));
}

async function seed(): Promise<void> {
  try {
    const res = await fetch(`${URL}/api/v1/stations`, { headers: { Authorization: `Bearer ${TOKEN}` } });
    if (!res.ok) {
      log.push(`GET /api/v1/stations -> ${res.status}`);
      return;
    }
    for (const s of (await res.json()) as StationRow[]) rows.set(s.serialNumber, s);
  } catch (err) {
    log.push(`GET /api/v1/stations failed: ${(err as Error).message}`);
  }
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
  rows.set(event.serialNumber, { ...rows.get(event.serialNumber), ...event });
  log.push(`${new Date().toLocaleTimeString()}  ${event.serialNumber} -> ${event.status}`);
  render();
});

// Keep the relative LAST SEEN column moving between events.
setInterval(render, 5000);
render();
