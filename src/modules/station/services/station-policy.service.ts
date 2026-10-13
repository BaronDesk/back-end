import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Subject } from 'rxjs';

import { stationTiming, type StationTiming } from '../../../config/station-timing.js';
import type { Prisma } from '../../../generated/prisma/index.js';
import { StationPolicyRepository } from '../repository/station-policy.repository.js';
import { STATION_POLICY_FIELDS, type EffectiveStationPolicy, type StationPolicy } from '../schemas/policy.schemas.js';

/**
 * Station policy. A station's effective policy is its branch's default,
 * overridden field by field by the station's own policy, plus the backend's
 * timing (heartbeat, lease, grace), which staff cannot change. Ops sends it
 * on every (re)connect, and to a branch's online stations when the branch
 * default changes (`branchPolicyChanges`).
 */
@Injectable()
export class StationPolicyService implements OnModuleDestroy {
  /** Pushed after a branch's default policy changed. */
  readonly branchPolicyChanges = new Subject<{ branchId: string }>();
  private readonly timing: StationTiming;

  constructor(
    private readonly repo: StationPolicyRepository,
    config: ConfigService,
  ) {
    this.timing = stationTiming(config);
  }

  onModuleDestroy(): void {
    this.branchPolicyChanges.complete();
  }

  /** What the station must run with, or null for an unknown machine. */
  async effectiveFor(machineId: string): Promise<EffectiveStationPolicy | null> {
    const row = await this.repo.findForMachine(machineId);
    if (!row) return null;
    return {
      ...toPolicy(row.branch.stationPolicy),
      ...toPolicy(row.policy),
      heartbeatIntervalSeconds: this.timing.heartbeatIntervalSeconds,
      defaultLeaseDurationSeconds: this.timing.leaseSeconds,
      leaseGracePeriodSeconds: this.timing.leaseGraceSeconds,
    };
  }

  /** The branch's default policy ({} when none), or null for an unknown branch. */
  async getBranchPolicy(branchId: string): Promise<StationPolicy | null> {
    const stored = await this.repo.findBranchPolicy(branchId);
    return stored === undefined ? null : toPolicy(stored);
  }

  /** Replaces the branch's default policy ({} clears it) and tells ops to push it. */
  async setBranchPolicy(branchId: string, policy: StationPolicy): Promise<StationPolicy> {
    const cleaned = toPolicy(policy);
    await this.repo.setBranchPolicy(branchId, Object.keys(cleaned).length ? (cleaned as Prisma.InputJsonValue) : null);
    this.branchPolicyChanges.next({ branchId });
    return cleaned;
  }
}

/** The known policy fields of a stored JSON value; anything else (null, junk, unknown keys) is dropped. */
function toPolicy(stored: unknown): StationPolicy {
  const policy: Record<string, number> = {};
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return policy;
  for (const field of STATION_POLICY_FIELDS) {
    const value = (stored as Record<string, unknown>)[field];
    if (typeof value === 'number' && Number.isFinite(value)) policy[field] = value;
  }
  return policy;
}
