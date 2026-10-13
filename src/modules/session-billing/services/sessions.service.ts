import { Injectable, type OnModuleInit } from '@nestjs/common';

import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import {
  StationSessionPort,
  type LoginDecision,
  type StationLease,
  type StationSessionHandler,
} from '../../ops/services/station-session.port.js';
import type { StateReportPayload } from '../../station/schemas/presence.schemas.js';
import type { StationRef } from '../../station/services/presence.service.js';

import { SessionExtensionsService } from './session-extensions.service.js';
import { SessionLoginService } from './session-login.service.js';
import { SessionMeteringService, type Quote } from './session-metering.service.js';
import { SessionQueriesService } from './session-queries.service.js';
import { SessionRunoutService } from './session-runout.service.js';
import { SessionSweepService } from './session-sweep.service.js';
import { StationLinkService } from './station-link.service.js';

export { EXTEND_MINUTES } from './session-extensions.service.js';
export type { Quote } from './session-metering.service.js';

/**
 * Session-billing's entry point for controllers, other modules and the agent
 * gateway (it registers itself on the StationSessionPort). Owns no logic:
 * - SessionLoginService: PINs, station login, leases.
 * - SessionMeteringService: rates, affordability, metering, settlement.
 * - SessionRunoutService: the funds run-out timer, lock and resume.
 * - StationLinkService: station status, offline pause, reconnect, staff controls.
 * - SessionExtensionsService: extra time on a running booking.
 * - SessionSweepService: the periodic sweep.
 * - SessionQueriesService: lists and lookups.
 */
@Injectable()
export class SessionsService implements OnModuleInit, StationSessionHandler {
  constructor(
    private readonly loginService: SessionLoginService,
    private readonly metering: SessionMeteringService,
    private readonly runout: SessionRunoutService,
    private readonly stationLink: StationLinkService,
    private readonly extensions: SessionExtensionsService,
    private readonly sweeper: SessionSweepService,
    private readonly queries: SessionQueriesService,
    private readonly port: StationSessionPort,
  ) {}

  onModuleInit(): void {
    this.port.register(this);
  }

  // --- PINs ----------------------------------------------------------------

  start(caller: AccessTokenPayload, reservationId: string) {
    return this.loginService.start(caller, reservationId);
  }

  checkIn(gamerProfileId: string, reservationId: string) {
    return this.loginService.checkIn(gamerProfileId, reservationId);
  }

  pinsForGamer(gamerProfileId: string) {
    return this.loginService.pinsForGamer(gamerProfileId);
  }

  // --- money ---------------------------------------------------------------

  quote(gamerProfileId: string, branchId: string, isWalkIn: boolean, start: Date, minutes: number): Promise<Quote> {
    return this.metering.quote(gamerProfileId, branchId, isWalkIn, start, minutes);
  }

  committedCents(gamerProfileId: string, now = new Date(), excludeReservationId?: string): Promise<number> {
    return this.metering.committedCents(gamerProfileId, now, excludeReservationId);
  }

  assertAffordable(input: { gamerProfileId: string; branchId: string; isWalkIn: boolean; start: Date; minutes: number }): Promise<Quote> {
    return this.metering.assertAffordable(input);
  }

  // --- extensions ----------------------------------------------------------

  extendOptions(gamerProfileId: string, reservationId: string) {
    return this.extensions.extendOptions(gamerProfileId, reservationId);
  }

  extend(gamerProfileId: string, reservationId: string, minutes: number) {
    return this.extensions.extend(gamerProfileId, reservationId, minutes);
  }

  // --- lists ---------------------------------------------------------------

  list(caller: AccessTokenPayload, query: { branchId?: string; status?: string; from?: Date; limit: number }) {
    return this.queries.list(caller, query);
  }

  currentForGamer(userId: string) {
    return this.queries.currentForGamer(userId);
  }

  // --- staff ---------------------------------------------------------------

  get(caller: AccessTokenPayload, id: string) {
    return this.queries.get(caller, id);
  }

  end(caller: AccessTokenPayload, id: string, reason?: string) {
    return this.stationLink.end(caller, id, reason);
  }

  forceClose(caller: AccessTokenPayload, id: string, reason?: string) {
    return this.stationLink.forceClose(caller, id, reason);
  }

  unlockFor(station: StationRef) {
    return this.stationLink.unlockFor(station);
  }

  closeForShutdown(station: StationRef): Promise<void> {
    return this.stationLink.closeForShutdown(station);
  }

  retireMachine(machineId: string): Promise<void> {
    return this.stationLink.retireMachine(machineId);
  }

  // --- runout --------------------------------------------------------------

  lockForRunout(sessionId: string): Promise<void> {
    return this.runout.lockForRunout(sessionId);
  }

  warnLowBalance(sessionId: string): Promise<void> {
    return this.runout.warnLowBalance(sessionId);
  }

  // --- station -------------------------------------------------------------

  login(station: StationRef, method: string, credential: string): Promise<LoginDecision> {
    return this.loginService.login(station, method, credential);
  }

  lease(station: StationRef, sessionId: string | null): Promise<StationLease> {
    return this.loginService.lease(station, sessionId);
  }

  reconcile(station: StationRef, report: StateReportPayload): Promise<void> {
    return this.stationLink.reconcile(station, report);
  }

  // --- sweep ---------------------------------------------------------------

  sweep(): Promise<void> {
    return this.sweeper.sweep();
  }
}
