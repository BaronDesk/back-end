export const AGENT_COMMANDS = {
  UNLOCK: 'UNLOCK',
  LOCK: 'LOCK',
  SHUTDOWN: 'SHUTDOWN',
  LAUNCH_GAME: 'LAUNCH_GAME',
  END_SESSION: 'END_SESSION',
  POLICY_UPDATE: 'POLICY_UPDATE',
} as const;
export type AgentCommand = (typeof AGENT_COMMANDS)[keyof typeof AGENT_COMMANDS];

export const AGENT_MESSAGE_TYPES = {
  HANDSHAKE: 'handshake',
  HEARTBEAT: 'heartbeat',
  TELEMETRY: 'telemetry',
  ALERT: 'alert',
  COMMAND_ACK: 'command_ack',
  COMMAND_NACK: 'command_nack',
  STATE_REPORT: 'state_report',
} as const;
export type AgentMessageType = (typeof AGENT_MESSAGE_TYPES)[keyof typeof AGENT_MESSAGE_TYPES];

export const DASHBOARD_EVENTS = {
  STATION_STATUS: 'station_status',
  TELEMETRY_UPDATE: 'telemetry_update',
  ALERT: 'alert',
  SESSION_UPDATE: 'session_update',
  COMMAND_RESULT: 'command_result',
} as const;
export type DashboardEvent = (typeof DASHBOARD_EVENTS)[keyof typeof DASHBOARD_EVENTS];
