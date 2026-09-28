import { Injectable, type OnModuleDestroy } from '@nestjs/common';

export type CommandReply =
  | { kind: 'ack' }
  | { kind: 'nack'; code: string; reason: string | null }
  | { kind: 'timeout' };

interface PendingAck {
  resolve: (reply: CommandReply) => void;
  timer: NodeJS.Timeout;
}

/**
 * In-memory correlation of in-flight commands to the agent's reply. The
 * worker registers a commandId right before it sends; the gateway settles it
 * on command_ack / command_nack; the timer settles it as `timeout` otherwise.
 * Single-instance, like the AgentRegistry the send itself goes through.
 */
@Injectable()
export class CommandAckTracker implements OnModuleDestroy {
  private readonly pending = new Map<string, PendingAck>();

  /** Registers synchronously, so a reply that races the send is never missed. */
  expect(commandId: string, timeoutMs: number): Promise<CommandReply> {
    this.settle(commandId, { kind: 'timeout' });
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.settle(commandId, { kind: 'timeout' }), timeoutMs);
      this.pending.set(commandId, { resolve, timer });
    });
  }

  /** Returns false when nothing was waiting (late reply, or a duplicate). */
  settle(commandId: string, reply: CommandReply): boolean {
    const entry = this.pending.get(commandId);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.pending.delete(commandId);
    entry.resolve(reply);
    return true;
  }

  onModuleDestroy(): void {
    for (const commandId of this.pending.keys()) this.settle(commandId, { kind: 'timeout' });
  }
}
