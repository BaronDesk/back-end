import { Injectable } from '@nestjs/common';
import type { Session } from '../../../generated/prisma/index.js';

import { assertScope } from '../../../common/utils/assert-scope.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { WalletService } from '../../wallet/services/wallet.service.js';
import { OPEN_SESSION_STATUSES, SessionsRepository } from '../repository/sessions.repository.js';
import { costAt, rateAt, secondsBetween, type Meter } from '../util/metering.js';
import { toSessionDto, type SessionRecord } from '../util/public-session.js';
import { notFound } from '../util/session-rules.js';

/** Sessions History shows this many of the latest sessions. */
const HISTORY_LIMIT = 50;

/** Read-only views of sessions for the desk and the gamer. */
@Injectable()
export class SessionQueriesService {
  constructor(
    private readonly repo: SessionsRepository,
    private readonly wallet: WalletService,
  ) {}

  /** Sessions for the desk: its branch (HQ: any, or every branch), with station, gamer and cost so far. */
  async list(caller: AccessTokenPayload, query: { branchId?: string; status?: string; from?: Date; limit: number }) {
    if (query.branchId) assertScope(caller, { branchId: query.branchId });
    const branchId = caller.scope === 'hq' ? (query.branchId ?? null) : caller.branchId;
    if (caller.scope !== 'hq' && !branchId) return [];
    const now = new Date();
    const rows = await this.repo.list({ branchId, status: query.status as Session['status'] | undefined, from: query.from, limit: query.limit });
    return rows.map((s) => ({
      ...toSessionDto(s as unknown as SessionRecord),
      station: s.reservation.machine,
      gamerUsername: s.reservation.gamerProfile.user.username,
      costSoFarCoins: OPEN_SESSION_STATUSES.includes(s.status) ? costAt(s as Meter, now) : null,
    }));
  }

  /**
   * The gamer's sessions history (Settings → Sessions History): their settled
   * sessions, latest first, with the time played, the bill and the XP earned.
   */
  async historyForGamer(userId: string) {
    const gamerProfileId = await this.repo.gamerProfileIdForUser(userId);
    if (!gamerProfileId) throw notFound('GAMER_PROFILE_NOT_FOUND', 'gamer profile not found');
    const sessions = await this.repo.listSettledForGamer(gamerProfileId, HISTORY_LIMIT);
    return sessions.map((s) => {
      const bill = (s.billingBreakdown ?? {}) as Record<string, unknown>;
      const num = (v: unknown) => (typeof v === 'number' ? v : null);
      return {
        sessionId: s.id,
        stationName: s.reservation.machine.name ?? s.reservation.machine.serialNumber,
        branchName: s.reservation.machine.branch.name,
        isWalkIn: s.reservation.isWalkIn,
        startTime: s.startTime,
        settledAt: s.settledAt,
        meteredSeconds: s.meteredSeconds,
        totalCoins: num(bill.totalCoins) ?? 0,
        // A free session has no debit, so no chargedCoins on its bill.
        chargedCoins: num(bill.chargedCoins) ?? 0,
        // Sessions settled before XP was awarded have none on their bill.
        xpEarned: num(bill.xpEarned),
      };
    });
  }

  /**
   * The gamer's own session now: station, rate, time played, cost so far,
   * balance, when it ends and why it is locked, or null when not playing.
   */
  async currentForGamer(userId: string) {
    const gamerProfileId = await this.repo.gamerProfileIdForUser(userId);
    if (!gamerProfileId) throw notFound('GAMER_PROFILE_NOT_FOUND', 'gamer profile not found');
    const session = await this.repo.findCurrentForGamer(gamerProfileId);
    if (!session) return null;
    const now = new Date();
    const meter = session as Meter;
    const { balance } = await this.wallet.getWalletForGamer(gamerProfileId);
    const played = session.meteredSeconds + (session.status === 'ACTIVE' && session.meteringStartedAt ? secondsBetween(session.meteringStartedAt, now) : 0);
    return {
      sessionId: session.id,
      reservationId: session.reservation.id,
      status: session.status,
      lockReason: session.lockReason,
      station: session.reservation.machine,
      startedAt: session.startTime.toISOString(),
      endsAt: session.endTime.toISOString(),
      rateCoinsPerHour: rateAt(meter, now),
      playedSeconds: played,
      costSoFarCoins: costAt(meter, now),
      balance,
      balanceAfterCoins: balance - costAt(meter, now),
    };
  }

  async get(caller: AccessTokenPayload, id: string) {
    const session = await this.repo.findByIdWithReservation(id);
    if (!session) throw notFound('SESSION_NOT_FOUND', 'session not found');
    assertScope(caller, { branchId: session.reservation.machine.branchId });
    return toSessionDto(session as SessionRecord);
  }
}
