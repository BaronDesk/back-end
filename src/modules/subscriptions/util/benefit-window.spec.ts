import { describe, expect, it } from 'vitest';

import { inWindow, localClock } from './benefit-window.js';

const at = (day: number, hhmm: string) => ({ day, minute: Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5)) });

describe('benefit windows', () => {
  it('reads the local day and time in the business time zone', () => {
    // 2026-09-30 is a Wednesday; 23:30 UTC is already Thursday 00:30 in Tunis (UTC+1).
    expect(localClock(new Date('2026-09-30T23:30:00Z'), 'Africa/Tunis')).toEqual(at(4, '00:30'));
  });

  it('matches a same-day window, end exclusive', () => {
    const w = { daysOfWeek: [1], startTime: '10:00', endTime: '12:00', discountPercent: 20 };
    expect(inWindow(w, at(1, '10:00'))).toBe(true);
    expect(inWindow(w, at(1, '11:59'))).toBe(true);
    expect(inWindow(w, at(1, '12:00'))).toBe(false);
    expect(inWindow(w, at(2, '11:00'))).toBe(false);
  });

  it('treats start == end as the whole day', () => {
    const w = { daysOfWeek: [6], startTime: '00:00', endTime: '00:00', discountPercent: 50 };
    expect(inWindow(w, at(6, '23:59'))).toBe(true);
    expect(inWindow(w, at(0, '00:00'))).toBe(false);
  });

  it('runs a window past midnight into the next day, owned by the day it starts on', () => {
    const w = { daysOfWeek: [5], startTime: '22:00', endTime: '02:00', discountPercent: 100 };
    expect(inWindow(w, at(5, '23:00'))).toBe(true);
    expect(inWindow(w, at(6, '01:00'))).toBe(true);
    expect(inWindow(w, at(6, '02:00'))).toBe(false);
    expect(inWindow(w, at(5, '01:00'))).toBe(false);
  });
});
