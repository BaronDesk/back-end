import { Injectable } from '@nestjs/common';

import type { StateReportPayload } from '../../station/schemas/presence.schemas.js';
import type { StationRef } from '../../station/services/presence.service.js';

/** What the agent needs to hold a station unlocked: seconds from `serverTime`. */
export interface StationLease {
  leaseSeconds: number;
  serverTime: string;
}

export type LoginDecision =
  | { accepted: true; sessionId: string; lease: StationLease }
  | { accepted: false; reason: string };

/**
 * What the agent gateway needs from session-billing. Implemented there; ops
 * cannot import it directly (session-billing already imports ops).
 */
export interface StationSessionHandler {
  /** login_request: checks the credential. Must not unlock anything itself. */
  login(station: StationRef, method: string, credential: string): Promise<LoginDecision>;
  /** The lease for a heartbeat_ack, for the session the station reports (or none). */
  lease(station: StationRef, sessionId: string | null): Promise<StationLease>;
  /** state_report on (re)connect: resume or close out the reported session. */
  reconcile(station: StationRef, report: StateReportPayload): Promise<void>;
}

/**
 * Late-bound link from the agent gateway to session-billing. SessionsService
 * registers itself on init; until then logins are refused and leases are zero,
 * so a station never unlocks on a backend that cannot check it.
 */
@Injectable()
export class StationSessionPort {
  private handler?: StationSessionHandler;

  register(handler: StationSessionHandler): void {
    this.handler = handler;
  }

  get current(): StationSessionHandler | undefined {
    return this.handler;
  }
}
