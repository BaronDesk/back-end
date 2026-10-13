import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Subject } from 'rxjs';

import { MachinesRepository } from '../repository/machines.repository.js';

/** Why a station needs attention. */
export type AttentionReason = 'commands_failed' | 'disconnects';

/** A station's flag set or cleared, for ops to push to its branch room. */
export interface StationAttentionChange {
  machineId: string;
  branchId: string;
  serialNumber: string;
  needsAttention: boolean;
  /** Why it was flagged (on a clear: why it had been). */
  reason: string | null;
  since: string | null;
}

/**
 * Flags a station the backend can't control: staff commands that keep
 * failing (CommandsService reports them), or a station that keeps dropping
 * (presence reports each ONLINE -> OFFLINE). A flagged station takes no new
 * booking, walk-in or check-in until staff clear it; a session already
 * running on it carries on.
 */
@Injectable()
export class StationAttentionService implements OnModuleDestroy {
  private readonly logger = new Logger(StationAttentionService.name);
  /** Pushed when a station's flag is set or cleared. */
  readonly changes = new Subject<StationAttentionChange>();
  /** machineId -> recent ONLINE -> OFFLINE times (ms), within the window. */
  private readonly drops = new Map<string, number[]>();

  /** Staff commands in a row ending FAILED / TIMEOUT that flag a station. */
  readonly failedCommandsThreshold: number;
  private readonly disconnectsThreshold: number;
  private readonly windowMs: number;

  constructor(
    private readonly machines: MachinesRepository,
    config: ConfigService,
  ) {
    this.failedCommandsThreshold = Number(config.get('ATTENTION_FAILED_COMMANDS') ?? 3);
    this.disconnectsThreshold = Number(config.get('ATTENTION_DISCONNECTS') ?? 3);
    this.windowMs = Number(config.get('ATTENTION_WINDOW_MIN') ?? 10) * 60_000;
  }

  onModuleDestroy(): void {
    this.changes.complete();
  }

  /** A station went ONLINE -> OFFLINE: flags it at the threshold within the window. Never throws. */
  async recordDisconnect(machineId: string, at = new Date()): Promise<void> {
    const cutoff = at.getTime() - this.windowMs;
    const recent = (this.drops.get(machineId) ?? []).filter((t) => t > cutoff);
    recent.push(at.getTime());
    this.drops.set(machineId, recent);
    if (recent.length < this.disconnectsThreshold) return;
    try {
      await this.flag(machineId, 'disconnects');
    } catch (err) {
      this.logger.error(`could not flag ${machineId} after ${recent.length} drops: ${(err as Error).message}`);
    }
  }

  /** Sets the flag (once: an already flagged station keeps its first reason). True when it was newly set. */
  async flag(machineId: string, reason: AttentionReason): Promise<boolean> {
    const machine = await this.machines.flagAttention(machineId, reason, new Date());
    if (!machine) return false;
    this.logger.warn(`station ${machine.serialNumber} needs attention (${reason}): no new bookings on it until staff clear it`);
    this.emit(machine);
    return true;
  }

  /** Clears the flag and the drop history. False when it was not set. */
  async clear(machineId: string): Promise<boolean> {
    const machine = await this.machines.clearAttention(machineId);
    if (!machine) return false;
    this.drops.delete(machineId);
    this.logger.log(`station ${machine.machine.serialNumber} attention cleared (was ${machine.reason ?? 'unknown'})`);
    this.emit({ ...machine.machine, attentionReason: machine.reason, attentionSince: null });
    return true;
  }

  private emit(machine: {
    id: string;
    branchId: string;
    serialNumber: string;
    needsAttention: boolean;
    attentionReason: string | null;
    attentionSince: Date | null;
  }): void {
    this.changes.next({
      machineId: machine.id,
      branchId: machine.branchId,
      serialNumber: machine.serialNumber,
      needsAttention: machine.needsAttention,
      reason: machine.attentionReason,
      since: machine.attentionSince?.toISOString() ?? null,
    });
  }
}
