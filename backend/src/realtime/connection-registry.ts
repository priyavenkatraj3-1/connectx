import type { WebSocket } from "ws";

/** Tracks which WebSocket connections belong to which authenticated user (a user may have several open tabs/devices). */
export class ConnectionRegistry {
  private readonly socketsByUser = new Map<string, Set<WebSocket>>();

  add(userId: string, socket: WebSocket): void {
    const existing = this.socketsByUser.get(userId);
    if (existing) {
      existing.add(socket);
    } else {
      this.socketsByUser.set(userId, new Set([socket]));
    }
  }

  remove(userId: string, socket: WebSocket): void {
    const existing = this.socketsByUser.get(userId);
    if (!existing) return;
    existing.delete(socket);
    if (existing.size === 0) {
      this.socketsByUser.delete(userId);
    }
  }

  getSockets(userId: string): Set<WebSocket> {
    return this.socketsByUser.get(userId) ?? new Set();
  }

  isOnline(userId: string): boolean {
    return this.socketsByUser.has(userId);
  }
}
