import { Injectable } from '@nestjs/common';
import type { WebSocket } from 'ws';

/**
 * In-memory serialNumber -> socket map for connected agents. Foundation-level
 * only: no cross-instance sync. A second app instance means agents split
 * across two disjoint registries.
 */
@Injectable()
export class AgentRegistry {
  private readonly sockets = new Map<string, WebSocket>();

  register(serialNumber: string, socket: WebSocket): void {
    this.sockets.get(serialNumber)?.close(4000, 'replaced by new connection');
    this.sockets.set(serialNumber, socket);
  }

  /**
   * Removes the mapping only if it still points at this socket. Returns false
   * when a newer connection has already replaced it, so the caller can skip
   * marking the station offline.
   */
  deregister(serialNumber: string, socket: WebSocket): boolean {
    if (this.sockets.get(serialNumber) !== socket) return false;
    this.sockets.delete(serialNumber);
    return true;
  }

  get(serialNumber: string): WebSocket | undefined {
    return this.sockets.get(serialNumber);
  }

  has(serialNumber: string): boolean {
    return this.sockets.has(serialNumber);
  }
}
