import type { ServerEvent } from "../../src/realtime/events";
import type { RealtimeGateway } from "../../src/realtime/gateway.interface";

/** Records every event sent to every user, and lets tests simulate specific users being "online". */
export class FakeRealtimeGateway implements RealtimeGateway {
  readonly sentEvents: Array<{ userId: string; event: ServerEvent }> = [];
  onlineUserIds = new Set<string>();

  sendToUser(userId: string, event: ServerEvent): void {
    this.sentEvents.push({ userId, event });
  }

  isUserOnline(userId: string): boolean {
    return this.onlineUserIds.has(userId);
  }

  /** Connections tests have declared open, as "userId:connectionId". */
  openConnections = new Set<string>();
  readonly connectionEvents: Array<{ userId: string; connectionId: string; event: ServerEvent }> = [];

  sendToConnection(userId: string, connectionId: string, event: ServerEvent): boolean {
    if (!this.openConnections.has(`${userId}:${connectionId}`)) return false;
    this.connectionEvents.push({ userId, connectionId, event });
    return true;
  }

  hasConnection(userId: string, connectionId: string): boolean {
    return this.openConnections.has(`${userId}:${connectionId}`);
  }

  eventsFor(userId: string): ServerEvent[] {
    return this.sentEvents.filter((entry) => entry.userId === userId).map((entry) => entry.event);
  }
}
