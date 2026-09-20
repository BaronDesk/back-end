import { Injectable } from '@nestjs/common';
import type { WebSocket } from 'ws';

/**
 * In-memory machineId -> socket map for connected agents. Foundation-level
 * only: no cross-instance sync. A second app instance means agents split
 * across two disjoint registries.
 */
@Injectable()
export class AgentRegistry {
  private readonly sockets = new Map<string, WebSocket>();

  register(machineId: string, socket: WebSocket): void {
    this.sockets.get(machineId)?.close(4000, 'replaced by new connection');
    this.sockets.set(machineId, socket);
  }

  deregister(machineId: string, socket: WebSocket): void {
    if (this.sockets.get(machineId) === socket) this.sockets.delete(machineId);
  }

  get(machineId: string): WebSocket | undefined {
    return this.sockets.get(machineId);
  }

  has(machineId: string): boolean {
    return this.sockets.has(machineId);
  }
}
