export const AGENT_COMMANDS = {
  UNLOCK: 'UNLOCK',
  LOCK: 'LOCK',
  SHUTDOWN: 'SHUTDOWN',
  LAUNCH_GAME: 'LAUNCH_GAME',
  END_SESSION: 'END_SESSION',
  POLICY_UPDATE: 'POLICY_UPDATE',
  CATALOG_UPDATE: 'CATALOG_UPDATE',
} as const;
export type AgentCommand = (typeof AGENT_COMMANDS)[keyof typeof AGENT_COMMANDS];

export const AGENT_MESSAGE_TYPES = {
  HANDSHAKE: 'handshake',
  HEARTBEAT: 'heartbeat',
  TELEMETRY: 'telemetry',
  DEVICE_EVENT: 'device_event',
  ALERT: 'alert',
  COMMAND_ACK: 'command_ack',
  COMMAND_NACK: 'command_nack',
  STATE_REPORT: 'state_report',
  CATALOG_STATUS: 'catalog_status',
  INSTALLED_GAMES: 'installed_games',
  PERIPHERAL_STATUS: 'peripheral_status',
  LOGIN_REQUEST: 'login_request',
} as const;
export const SERVER_MESSAGE_TYPES = {
  HANDSHAKE_ACK: 'handshake_ack',
  HEARTBEAT_ACK: 'heartbeat_ack',
  LOGIN_RESULT: 'login_result',
  /** Low balance / time left / clear, shown on the station (no ack). */
  SESSION_NOTICE: 'session_notice',
  /** A renewed station token for the agent to store (no ack). */
  STATION_CREDENTIAL: 'station_credential',
} as const;

export type AgentMessageType = (typeof AGENT_MESSAGE_TYPES)[keyof typeof AGENT_MESSAGE_TYPES];

export const DASHBOARD_EVENTS = {
  STATION_STATUS: 'station_status',
  TELEMETRY_UPDATE: 'telemetry_update',
  ALERT: 'alert',
  ALERT_RESOLVED: 'alert_resolved',
  SESSION_UPDATE: 'session_update',
  COMMAND_RESULT: 'command_result',
  COMMAND_UPDATE: 'command_update',
  CATALOG_STATUS: 'catalog_status',
  SESSION_RUNOUT_WARNING: 'session_runout_warning',
  /** To the gamer: low balance / time left / clear, as shown on the station. */
  SESSION_NOTICE: 'session_notice',
  PERIPHERAL_STATUS: 'peripheral_status',
} as const;
export type DashboardEvent = (typeof DASHBOARD_EVENTS)[keyof typeof DASHBOARD_EVENTS];
