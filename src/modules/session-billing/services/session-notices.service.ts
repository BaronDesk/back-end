import { Injectable } from '@nestjs/common';

import { DASHBOARD_EVENTS, SERVER_MESSAGE_TYPES } from '../../../infra/realtime/constants.js';
import { AgentGateway } from '../../ops/agent.gateway.js';
import { DashboardGateway } from '../../ops/dashboard.gateway.js';
import { SessionsRepository } from '../repository/sessions.repository.js';
import type { SettlementSession } from '../util/session-rules.js';

/** session_notice to the station and the gamer's portal. */
@Injectable()
export class SessionNoticesService {
  constructor(
    private readonly repo: SessionsRepository,
    private readonly agents: AgentGateway,
    private readonly dashboard: DashboardGateway,
  ) {}

  /**
   * session_notice to the station (shown in a corner box) and to the gamer's
   * portal. `endsAt` is when the station locks: the run-out time for
   * LOW_BALANCE, the booking end for TIME_LEFT.
   */
  async notify(session: SettlementSession, kind: 'LOW_BALANCE' | 'TIME_LEFT' | 'CLEAR', endsAt?: Date | null): Promise<void> {
    const payload = { sessionId: session.id, kind, endsAt: endsAt?.toISOString() ?? null, message: null };
    this.agents.sendControl(session.reservation.machine.serialNumber, SERVER_MESSAGE_TYPES.SESSION_NOTICE, payload);
    const userId = await this.repo.userIdForGamer(session.reservation.gamerProfileId);
    if (userId) {
      this.dashboard.publishToUser(userId, DASHBOARD_EVENTS.SESSION_NOTICE, { ...payload, reservationId: session.reservationId });
    }
  }
}
