import type { BenefitWindow } from '../schemas/subscription.schemas.js';

export interface LocalClock {
  /** 0 = Sunday … 6 = Saturday, like BenefitWindow.daysOfWeek. */
  day: number;
  /** Minutes since local midnight. */
  minute: number;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const toMinutes = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** Day of week and minute of day of `at` on the clocks of `timeZone`. */
export function localClock(at: Date, timeZone: string): LocalClock {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(at);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { day: WEEKDAYS.indexOf(part('weekday')), minute: Number(part('hour')) * 60 + Number(part('minute')) };
}

/**
 * Whether the clock falls in the window. The end is exclusive; start == end
 * is the whole day. A window that ends before it starts runs past midnight
 * and belongs to the day it starts on (Fri 22:00–02:00 covers Sat 01:00).
 */
export function inWindow(window: BenefitWindow, clock: LocalClock): boolean {
  const start = toMinutes(window.startTime);
  const end = toMinutes(window.endTime);
  const on = (day: number) => window.daysOfWeek.includes(day);
  if (start === end) return on(clock.day);
  if (start < end) return on(clock.day) && clock.minute >= start && clock.minute < end;
  if (clock.minute >= start) return on(clock.day);
  return clock.minute < end && on((clock.day + 6) % 7);
}
