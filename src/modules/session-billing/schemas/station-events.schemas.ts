import type { SessionEndedEvent, StationStatusEvent } from '../../station/services/presence.service.js';

/**
 * Presence events that move billing (a session ended, a station locked,
 * unlocked or went offline), queued in Redis so the follow-up survives a
 * process crash: the worker runs it once the app is back. The sweep stays
 * the safety net for anything older.
 */
export const STATION_EVENTS_QUEUE = 'station-events';

export const STATION_EVENT_JOBS = { SETTLE: 'settle', STATUS: 'status' } as const;

export interface SettleJobData {
  event: SessionEndedEvent;
}

export interface StatusJobData {
  event: StationStatusEvent;
  /** When presence saw the change (ISO): metering starts or stops then, however late the job runs. */
  at: string;
}

export type StationEventJobData = SettleJobData | StatusJobData;

// BullMQ rejects custom job ids containing ':' ("Custom Id cannot contain :").
const safe = (part: string | number | boolean | null) => String(part).replace(/:/g, '_');

/** One settlement per session: a repeated end event while its job waits is the same job. */
export const settleJobId = (sessionId: string): string => `settle-${safe(sessionId)}`;

/** One job per observed change: the same change seen twice is deduplicated, a later one is not. */
export const statusJobId = (event: StationStatusEvent, at: Date): string =>
  ['status', event.serialNumber, event.status, event.sessionId ?? 'none', event.locked, at.getTime()].map(safe).join('-');
