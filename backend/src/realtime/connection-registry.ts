import type { WebSocket } from "ws";

/**
 * Tracks which WebSocket connections belong to which authenticated user (a
 * user may have several open tabs/devices). Each connection also has a
 * connection ID, unique per user, so call signaling can target the one
 * device that joined a call rather than every tab the user has open.
 */
export class ConnectionRegistry {
  private readonly socketsByUser = new Map<string, Map<string, WebSocket>>();

  add(userId: string, connectionId: string, socket: WebSocket): void {
    const existing = this.socketsByUser.get(userId);
    if (existing) {
      existing.set(connectionId, socket);
    } else {
      this.socketsByUser.set(userId, new Map([[connectionId, socket]]));
    }
  }

  /** Removes the connection only if it is still mapped to this exact socket (a reconnect may have replaced it). */
  remove(userId: string, connectionId: string, socket: WebSocket): void {
    const existing = this.socketsByUser.get(userId);
    if (!existing || existing.get(connectionId) !== socket) return;
    existing.delete(connectionId);
    if (existing.size === 0) {
      this.socketsByUser.delete(userId);
    }
  }

  getSockets(userId: string): WebSocket[] {
    return [...(this.socketsByUser.get(userId)?.values() ?? [])];
  }

  getSocket(userId: string, connectionId: string): WebSocket | undefined {
    return this.socketsByUser.get(userId)?.get(connectionId);
  }

  isOnline(userId: string): boolean {
    return this.socketsByUser.has(userId);
  }
}
