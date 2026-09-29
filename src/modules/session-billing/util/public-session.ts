export interface SessionRecord {
  id: string;
  reservationId: string;
  appliedMembershipId: string | null;
  status: string;
  rateCentsPerMinute: number | null;
  meteredSeconds: number;
  startTime: Date;
  endTime: Date;
  lockedAt: Date | null;
  settledAt: Date | null;
  billingBreakdown: unknown;
  createdAt: Date;
}

export function toSessionDto(session: SessionRecord) {
  return {
    id: session.id,
    reservationId: session.reservationId,
    appliedMembershipId: session.appliedMembershipId,
    status: session.status,
    rateCentsPerMinute: session.rateCentsPerMinute,
    meteredSeconds: session.meteredSeconds,
    startTime: session.startTime,
    endTime: session.endTime,
    lockedAt: session.lockedAt,
    settledAt: session.settledAt,
    billingBreakdown: session.billingBreakdown,
    createdAt: session.createdAt,
  };
}
