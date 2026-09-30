export const RUNOUT_QUEUE = 'session-runout';

export const RUNOUT_JOBS = { WARN: 'warn', LOCK: 'lock' } as const;
export type RunoutJobName = (typeof RUNOUT_JOBS)[keyof typeof RUNOUT_JOBS];

export interface RunoutJobData {
  sessionId: string;
  gamerProfileId: string;
  machineId: string;
  branchId: string;
  serialNumber: string;
}

export interface ScheduleRunoutInput extends RunoutJobData {
  rateCentsPerMinute: number | null;
}

export const warnJobId = (sessionId: string): string => `warn:${sessionId}`;
export const lockJobId = (sessionId: string): string => `lock:${sessionId}`;
