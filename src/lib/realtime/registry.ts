import type { WebSocket } from "ws";

/** In-memory map of connected agent sockets, keyed by machineId. Single-process only. */
class MachineRegistry {
  private readonly connections = new Map<string, WebSocket>();

  add(machineId: string, ws: WebSocket): void {
    const existing = this.connections.get(machineId);
    if (existing && existing !== ws && existing.readyState === existing.OPEN) {
      existing.close(4409, "Superseded by new connection");
    }
    this.connections.set(machineId, ws);
  }

  remove(machineId: string, ws: WebSocket): void {
    if (this.connections.get(machineId) === ws) {
      this.connections.delete(machineId);
    }
  }

  get(machineId: string): WebSocket | undefined {
    return this.connections.get(machineId);
  }
}

export const machineRegistry = new MachineRegistry();
