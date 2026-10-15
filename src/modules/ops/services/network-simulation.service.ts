import { BadRequestException, Injectable, Logger, NotFoundException, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { assertScope } from '../../../common/utils/assert-scope.js';
import type { AccessTokenPayload } from '../../../common/types/jwt-payload.js';
import { AgentRegistry } from '../../../infra/realtime/registry.js';
import { PresenceService } from '../../station/services/presence.service.js';
import type { StationPrincipal } from '../../station/services/station-token.service.js';

/** One simulated outage: connections refused until `until` (epoch ms). */
interface Outage {
  until: number;
  timer: NodeJS.Timeout;
}

/**
 * Dev-only network failures, for tests and the demo: a station's (or a whole
 * branch's) connection is cut and its reconnects are refused for N seconds.
 * The socket is terminated without a close handshake, like a pulled cable;
 * the agent then retries on its own until the outage ends. Refused in
 * production, like the command simulations.
 */
@Injectable()
export class NetworkSimulationService implements OnModuleDestroy {
  private readonly logger = new Logger(NetworkSimulationService.name);
  private readonly allowed: boolean;
  private readonly stations = new Map<string, Outage>();
  private readonly branches = new Map<string, Outage>();
  /** Serials cut by a branch outage whose socket close is still to be handled: they go OFFLINE as a venue outage. */
  private readonly venueCuts = new Set<string>();

  constructor(
    private readonly presence: PresenceService,
    private readonly registry: AgentRegistry,
    config: ConfigService,
  ) {
    this.allowed = config.get('NODE_ENV') !== 'production';
  }

  onModuleDestroy(): void {
    for (const outage of [...this.stations.values(), ...this.branches.values()]) clearTimeout(outage.timer);
  }

  /** Cuts one station off for `seconds`: OFFLINE as a single drop. */
  async dropStation(caller: AccessTokenPayload, stationId: string, seconds: number) {
    this.assertAllowed();
    const station = await this.presence.resolveById(stationId);
    if (!station) throw new NotFoundException({ code: 'STATION_NOT_FOUND', error: 'station not found' });
    assertScope(caller, { branchId: station.branchId });

    const until = this.start(this.stations, station.serialNumber, seconds, `station ${station.serialNumber}`);
    const cut = this.cut(station.serialNumber, false);
    this.logger.warn(`simulated network drop of station ${station.serialNumber} for ${seconds}s started by ${caller.sub} (${cut ? 'socket cut' : 'was not connected'})`);
    return { machineId: station.machineId, serialNumber: station.serialNumber, droppedUntil: new Date(until).toISOString(), disconnected: cut };
  }

  /** Cuts every station of a branch off for `seconds`: OFFLINE together, as a venue outage. */
  dropBranch(caller: AccessTokenPayload, branchId: string, seconds: number) {
    this.assertAllowed();
    assertScope(caller, { branchId });

    const until = this.start(this.branches, branchId, seconds, `branch ${branchId}`);
    const disconnected = this.presence
      .onlineStations()
      .filter((s) => s.branchId === branchId)
      .filter((s) => this.cut(s.serialNumber, true))
      .map((s) => s.serialNumber);
    this.logger.warn(`simulated venue outage of branch ${branchId} for ${seconds}s started by ${caller.sub}: ${disconnected.length} station(s) cut`);
    return { branchId, droppedUntil: new Date(until).toISOString(), disconnected };
  }

  /** Why this station's connection is refused right now, or null when it is not in a simulated outage. */
  refusal(principal: Pick<StationPrincipal, 'serialNumber' | 'branchId'>): string | null {
    const now = Date.now();
    const station = this.stations.get(principal.serialNumber);
    if (station && station.until > now) return `simulated network drop, ${secondsLeft(station.until, now)}s left`;
    const branch = this.branches.get(principal.branchId);
    if (branch && branch.until > now) return `simulated venue outage, ${secondsLeft(branch.until, now)}s left`;
    return null;
  }

  /** For the socket close: true (once) when a branch outage cut this station. */
  takeVenueCut(serialNumber: string): boolean {
    return this.venueCuts.delete(serialNumber);
  }

  private assertAllowed(): void {
    if (!this.allowed) throw new BadRequestException({ code: 'SIMULATION_DISABLED', error: 'network simulation is dev-only' });
  }

  /** Records (or extends) the outage and schedules its end. */
  private start(outages: Map<string, Outage>, key: string, seconds: number, label: string): number {
    clearTimeout(outages.get(key)?.timer);
    const until = Date.now() + seconds * 1000;
    const timer = setTimeout(() => {
      outages.delete(key);
      this.logger.warn(`simulated outage of ${label} ended: reconnects accepted again`);
    }, seconds * 1000);
    timer.unref();
    outages.set(key, { until, timer });
    return until;
  }

  /** Terminates the station's live socket, if any. */
  private cut(serialNumber: string, venue: boolean): boolean {
    const socket = this.registry.get(serialNumber);
    if (!socket) return false;
    if (venue) this.venueCuts.add(serialNumber);
    socket.terminate();
    return true;
  }
}

function secondsLeft(until: number, now: number): number {
  return Math.ceil((until - now) / 1000);
}
