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

  eventsFor(userId: string): ServerEvent[] {
    return this.sentEvents.filter((entry) => entry.userId === userId).map((entry) => entry.event);
  }
}
