import type { ServerEvent } from "./events";
import type { RealtimeGateway } from "./gateway.interface";

/** Sends the same event to each user (de-duplicated). */
export function broadcast(gateway: RealtimeGateway, userIds: Iterable<string>, event: ServerEvent): void {
  for (const userId of new Set(userIds)) {
    gateway.sendToUser(userId, event);
  }
}
