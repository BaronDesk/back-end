// TEMPORARY DEV MONITOR — delete before merge
//
// Live view of station presence, telemetry and alerts, fed by
// `station_status`, `telemetry_update`, `alert` and `alert_resolved` on
// /dashboard-io. Standalone on purpose: no imports from src/.
//
//   TOKEN=<staff access token> npm run monitor
//   URL defaults to http://localhost:3000 (dev compose exposes Nest directly).
//   CPU_TEMP_THRESHOLD_C / GPU_TEMP_THRESHOLD_C default to 85 / 90, like the backend.
import { io } from 'socket.io-client';

interface StationRow {
  serialNumber: string;
  name?: string | null;
  status: string;
  lastSeen: string | null;
  ip: string | null;
  locked: boolean | null;
}

interface TelemetryUpdate {
  serialNumber: string;
  timestamp: string;
  receivedAt: string;
  metrics: Record<string, number>;
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
  const header = `${pad('SERIAL', 24)} ${pad('STATUS', 8)} ${pad('LOCKED', 7)} ${pad('LAST SEEN', 14)} IP`;
  const lines = [...rows.values()]
    .sort((a, b) => a.serialNumber.localeCompare(b.serialNumber))
    .map((r) => {
      const locked = r.locked === null || r.locked === undefined ? '-' : r.locked ? 'yes' : 'no';
      return `${pad(r.serialNumber, 24)} ${cell(r.status, 8, r.status === 'ONLINE' ? GREEN : RED)} ${pad(locked, 7)} ${pad(relative(r.lastSeen), 14)} ${r.ip ?? '-'}`;
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

function render(): void {
  console.clear();
  console.log(`node monitor  ${DIM}${URL}  [${connection}]  thresholds CPU>${CPU_MAX} GPU>${GPU_MAX}${RESET}\n`);
  console.log(renderStations().join('\n'));
  console.log(`\n${renderTelemetry().join('\n')}`);
  const alertHeader = `${pad('TIME', 11)} ${pad('SERIAL', 24)} ${pad('CATEGORY', 11)} ${pad('TYPE', 20)} DETAIL`;
  console.log(`\nALERTS\n${alertHeader}\n${'-'.repeat(alertHeader.length + 20)}`);
  console.log(alerts.length ? alerts.slice(-10).join('\n') : `${DIM}(no alerts)${RESET}`);
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
  const open = (await get<AlertEvent[]>('/api/v1/alerts?status=open&limit=10')) ?? [];
  alerts.length = 0;
  for (const a of open.reverse()) alerts.push(alertLine(a));
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
socket.on('telemetry_update', (event: TelemetryUpdate) => {
  telemetry.set(event.serialNumber, event);
  render();
});
socket.on('alert', (event: AlertEvent) => {
  alerts.push(alertLine(event));
  log.push(`${new Date().toLocaleTimeString()}  ALERT ${event.category}/${event.type} on ${event.serialNumber ?? '?'}`);
  render();
});
socket.on('alert_resolved', (event: AlertEvent) => {
  log.push(`${new Date().toLocaleTimeString()}  resolved ${event.category}/${event.type} ${event.id.slice(0, 8)}`);
  render();
});

// Keep the relative columns moving between events.
setInterval(render, 5000);
render();
