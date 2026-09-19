/**
 * Real-time layer types (Step X). Two transports:
 *  - raw ws for machine agents (src/modules/ops/agent-gateway.ts)
 *  - Socket.IO for dashboards (src/modules/ops/dashboard-gateway.ts)
 *
 * Both sides exchange `Envelope<T>` frames so replay/ordering (seq) and
 * causality (ts) can be checked the same way regardless of transport.
 */

export interface Envelope<T = unknown> {
  type: string;
  id: string; // uuid, unique per frame
  ts: string; // ISO datetime, sender clock
  seq: number; // monotonic per-connection counter, >= 0
  payload: T;
}

// --- Agent (machine) <-> server, over raw ws ---

export const AGENT_MESSAGES = [
  "handshake",
  "heartbeat",
  "telemetry",
  "alert",
  "command_ack",
  "command_nack",
  "state_report",
] as const;

export type AgentMessageType = (typeof AGENT_MESSAGES)[number];

export const COMMANDS = [
  "UNLOCK",
  "LOCK",
  "SHUTDOWN",
  "LAUNCH_GAME",
  "END_SESSION",
  "POLICY_UPDATE",
] as const;

export type Command = (typeof COMMANDS)[number];

// --- Server -> dashboard, over Socket.IO ---

export const DASHBOARD_EVENTS = [
  "station_status",
  "telemetry_update",
  "alert",
  "session_update",
  "command_result",
] as const;

export type DashboardEvent = (typeof DASHBOARD_EVENTS)[number];

export const ALERT_CATEGORIES = [
  "CPU_USAGE",
  "MEMORY_USAGE",
  "DISK_SPACE",
  "NETWORK_ERROR",
  "HARDWARE_FAILURE",
  "TEMPERATURE_WARNING",
  "CONNECTION_LOST",
] as const;

export type AlertCategory = (typeof ALERT_CATEGORIES)[number];
