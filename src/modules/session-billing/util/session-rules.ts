import { ConflictException, NotFoundException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Session } from '../../../generated/prisma/index.js';

import type { StationLease } from '../../ops/services/station-session.port.js';
import { OPEN_SESSION_STATUSES, type SessionsRepository } from '../repository/sessions.repository.js';

/** Session.lockReason: the backend locked the station because the gamer's funds ran out. */
export const RUNOUT_LOCK = 'runout';
/** Session.lockReason: the station went offline mid-session; metering stopped at its last heartbeat. */
export const OFFLINE_LOCK = 'offline';

export type SettlementSession = NonNullable<Awaited<ReturnType<SessionsRepository['findForSettlement']>>>;
export type StartableReservation = NonNullable<Awaited<ReturnType<SessionsRepository['findReservationForStart']>>>;

export const notFound = (code: string, error: string) => new NotFoundException({ code, error });

export const insufficientFunds = (error: string) => new ConflictException({ code: 'INSUFFICIENT_FUNDS', error });

/** The session-billing settings, with their defaults. Each service reads the ones it needs. */
export function sessionConfig(config: ConfigService) {
  return {
    pinMaxAttempts: Number(config.get('SESSION_PIN_MAX_ATTEMPTS') ?? 5),
    leaseCapSeconds: Number(config.get('SESSION_LEASE_CAP_S') ?? 180),
    sweepIntervalMs: Number(config.get('SESSION_SWEEP_INTERVAL_MS') ?? 60_000),
    minPlayMinutes: Number(config.get('SESSION_MIN_PLAY_MINUTES') ?? 5),
    runoutMarginS: Number(config.get('SESSION_RUNOUT_MARGIN_S') ?? 30),
    noShowGraceMs: Number(config.get('NO_SHOW_GRACE_MINUTES') ?? 30) * 60_000,
    endingNoticeMs: Number(config.get('SESSION_ENDING_NOTICE_MINUTES') ?? 10) * 60_000,
  };
}

export function toLease(seconds: number, now: Date): StationLease {
  return { leaseSeconds: Math.max(seconds, 0), serverTime: now.toISOString() };
}

/** The shorter of the remaining reservation window and the safety cap, re-granted on every heartbeat. */
export function leaseFor(session: Session, now: Date, leaseCapSeconds: number): StationLease {
  const windowSeconds = Math.floor((session.endTime.getTime() - now.getTime()) / 1000);
  return toLease(Math.min(windowSeconds, leaseCapSeconds), now);
}

/** Logged into, still open and inside its reservation window. */
export function isGranted(session: Session, now: Date): boolean {
  return (
    OPEN_SESSION_STATUSES.includes(session.status) &&
    (session.status !== 'PENDING' || session.pinUsedAt !== null) &&
    session.endTime > now
  );
}

/** A never-used PIN that can no longer be used: expired or out of attempts. */
export function isDeadPin(session: Session, now: Date, pinMaxAttempts: number): boolean {
  if (session.status !== 'PENDING' || session.pinUsedAt) return false;
  return !session.pinExpiresAt || session.pinExpiresAt <= now || session.pinAttempts >= pinMaxAttempts;
}
